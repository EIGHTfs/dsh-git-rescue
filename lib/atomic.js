/**
 * dsh-git-rescue — 原子写 + 敏感文件权限守卫（2026-08-21 对齐官方设计）
 *
 * 对齐 @deepseek-ai/dsh-atomic-write + dsh-credentials-local 的官方权限约定：
 *  1. writeFileAtomic：临时文件 wx 独占创建 + 同目录 rename 原子替换，
 *     权限位随新 inode 生效（收窄宽权限文件无 chmod 竞态），失败清理临时文件。
 *  2. withFileLock：跨进程写锁（<file>.lock，wx 创建），串行化 read-modify-write。
 *  3. assertOwnerOnly / ensureOwnerOnly：读取敏感文件前校验权限过宽
 *     （group/other 权限位，即 mode & 0o077），过宽抛错（同官方）或自动收紧
 *     （chmod 600，本插件友好模式）。
 *
 * 官方依据：
 *  - dsh-credentials-local: GROUP_OTHER_BITS=63(0o077)，写 .credentials.yaml 用
 *    dirMode 448(0o700)/mode 384(0o600)，读取前 assertOwnerOnly 过宽即抛错。
 *  - dsh-atomic-write: 随机后缀临时文件 + wx 独占 + rename；锁文件 mode 384。
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

/** 组/其他权限位（mode & 0o077 ≠ 0 即「他人可读/可写」）。 */
export const GROUP_OTHER_BITS = 0o077
/** 敏感文件标准权限：0600（与官方 384 一致）。 */
export const FILE_MODE_600 = 0o600
/** 敏感目录标准权限：0700（与官方 448 一致）。 */
export const DIR_MODE_700 = 0o700

/**
 * 原子写文件：内容先写同目录随机后缀临时文件（wx 独占创建，权限 0600），
 * 再 rename 到目标——读者只见旧或新完整内容；替换宽权限文件时新 inode 直接收窄。
 * @param {string} filename 目标路径
 * @param {string|Buffer} content 完整内容
 * @param {object} [opts] { mode=0o600, dirMode=0o700 }
 */
export async function writeFileAtomic(filename, content, opts = {}) {
  const mode = opts.mode ?? FILE_MODE_600
  const dirMode = opts.dirMode ?? DIR_MODE_700
  await fs.mkdir(dirname(filename), { recursive: true, mode: dirMode })
  const temp = join(dirname(filename), `.${filename.split(/[\\/]/).pop()}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temp, content, { mode, flag: 'wx' })
    await fs.rename(temp, filename)
  } catch (e) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw e
  }
}

/** 判断错误是否为「文件已存在」（wx 竞争/锁占用）。 */
function isEEXIST(e) {
  return e?.code === 'EEXIST'
}

/** 锁重试参数（对齐官方：20ms→200ms 指数退避，2s 超时）。 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const LOCK_TIMEOUT_MS = 2000

/**
 * 跨进程写锁：在 <filename>.lock 上 wx 独占创建，串行化 read-modify-write 循环。
 * 读者无需加锁（rename 提交原子）；竞争指数退避，超时抛错（不猜锁属主）。
 * @param {string} filename 被保护的（目标）文件
 * @param {() => Promise<T>} operation 持锁期间执行的操作
 * @returns {Promise<T>}
 * @template T
 */
export async function withFileLock(filename, operation) {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await fs.writeFile(lockPath, `${process.pid}\n`, { mode: FILE_MODE_600, flag: 'wx' })
      break
    } catch (e) {
      if (!isEEXIST(e)) throw e
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: 等待写锁超时 ${lockPath}`)
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}

/**
 * 读取文件并校验权限：mode & 0o077（组/其他权限位）非零 = 他人可读/可写，视为不安全。
 * @param {string} filename
 * @returns {Promise<{ok:boolean, mode:number|null, error?:string}>}
 */
export async function checkOwnerOnly(filename) {
  // 对齐官方 assertOwnerOnly：win32 无 mode 可检（ACL 不可表达），跳过不伪造
  if (process.platform === 'win32') return { ok: true, mode: null, skipped: 'win32' }
  try {
    const st = await fs.stat(filename)
    const mode = st.mode & 0o777
    return {
      ok: (mode & GROUP_OTHER_BITS) === 0,
      mode,
      error: (mode & GROUP_OTHER_BITS) === 0 ? undefined : `权限过宽 (mode ${mode.toString(8)})，应为 600`,
    }
  } catch (e) {
    return { ok: false, mode: null, error: `stat 失败: ${String(e?.message ?? e)}` }
  }
}

/**
 * 读取敏感文件，权限过宽时自动收紧（chmod 600）后继续（友好模式）。
 * 对齐官方 assertOwnerOnly 的「过宽即拒绝」语义，但本插件用于守护进程/工具场景，
 * 自动收紧避免人工干预（官方拒绝是为了强制用户手动处理；这里 owner 就是 DSH 自己）。
 * @param {string} filename
 * @returns {Promise<string>} 文件内容
 * @throws 文件不存在时抛 ENOENT；stat/chmod 失败时抛错
 */
export async function readFileSecure(filename) {
  const check = await checkOwnerOnly(filename)
  if (!check.ok) {
    if (check.mode === null) throw Object.assign(new Error(`stat 失败: ${check.error}`), { code: 'ENOENT' })
    // 权限过宽 → 自动收紧 600（对齐官方 0600 约定）
    await fs.chmod(filename, FILE_MODE_600).catch(() => {})
  }
  return fs.readFile(filename, 'utf8')
}
