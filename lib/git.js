/**
 * dsh-git-rescue — git 命令包装层
 *
 * - 检测系统 git 是否可用（git --version）
 * - 检测 git-remote-https 助手是否缺失（缺失 = HTTPS git 操作不可用 → 远端推送走 REST API 降级）
 * - 封装 init / add / commit / log / status / reset / tag 等常用命令
 * - 所有命令通过 spawn 执行，捕获 stdout/stderr/exitCode
 */

import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'

export const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_CONFIG_NOSYSTEM: '1',
}

/** 执行一条 git 命令，返回 { ok, stdout, stderr, code }。 */
export function runGit(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: String(e?.message ?? e), code: -1 }))
    child.on('close', (code) => resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim(), code }))
  })
}

/** git --version → '2.43.0' 或 null（git 不可用）。 */
export async function gitVersion() {
  const r = await runGit(['--version'])
  if (!r.ok) return null
  const m = r.stdout.match(/(\d+\.\d+(?:\.\d+)?)/)
  return m ? m[1] : r.stdout
}

/** 检查 git-remote-https 助手是否存在（本地快速检测，不联网）。 */
export async function httpsHelperMissing() {
  try {
    const { execFileSync } = await import('node:child_process')
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    const helper = join(execPath, 'git-remote-https')
    const exists = existsSync(helper)
    if (!exists) {
      // 有的发行版 helper 在 libexec/git-core 下，再试一次 find
      const alt = join(execPath, '..', 'libexec', 'git-core', 'git-remote-https')
      return !existsSync(alt)
    }
    return false
  } catch {
    // 无法检测时保守假定可用（让实际推送结果说话）
    return false
  }
}

/** 检查一个目录是否是 git 仓库。 */
export async function isRepo(dir) {
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir })
  return r.ok && r.stdout === 'true'
}

/** 初始化仓库（已存在则跳过），并设置本地 user.name/email。 */
export async function initRepo(dir, user = { name: 'dsh-git-rescue', email: 'git-rescue@dsh.local' }) {
  await fs.mkdir(dir, { recursive: true })
  if (!(await isRepo(dir))) {
    const init = await runGit(['init', '-b', 'main'], { cwd: dir })
    if (!init.ok) return { ok: false, error: init.stderr || 'git init 失败' }
  }
  await runGit(['config', 'user.name', user.name], { cwd: dir })
  await runGit(['config', 'user.email', user.email], { cwd: dir })
  // 大文件保护
  await runGit(['config', 'core.compression', '9'], { cwd: dir })
  return { ok: true }
}

/** 当前 HEAD 短哈希；无提交返回 null。 */
export async function headRef(dir) {
  const r = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })
  return r.ok ? r.stdout : null
}

/** 工作区是否有变更。 */
export async function hasChanges(dir) {
  const r = await runGit(['status', '--porcelain'], { cwd: dir })
  return r.ok && r.stdout.length > 0
}

/** add -A + commit；无变更时返回 { ok: true, empty: true }。 */
export async function commit(dir, message, extraArgs = []) {
  if (!(await hasChanges(dir))) return { ok: true, empty: true }
  const add = await runGit(['add', '-A'], { cwd: dir })
  if (!add.ok) return { ok: false, error: add.stderr || 'git add 失败' }
  const cm = await runGit(['commit', '-m', message, ...extraArgs], { cwd: dir })
  if (!cm.ok) return { ok: false, error: cm.stderr || 'git commit 失败' }
  return { ok: true, hash: await headRef(dir) }
}

/** 最近 n 条提交。 */
export async function log(dir, n = 10) {
  const r = await runGit(['log', '--oneline', '-n', String(n)], { cwd: dir })
  return r.ok ? r.stdout.split('\n').filter(Boolean) : []
}

/** 简要状态。 */
export async function status(dir) {
  const r = await runGit(['status', '--short'], { cwd: dir })
  const lines = (r.ok ? r.stdout : '').split('\n').filter(Boolean)
  return { changed: lines.length, lines: lines.slice(0, 50) }
}

/** 列出所有 bad 标记（tag: bad-<short>）。 */
export async function listBadTags(dir) {
  const r = await runGit(['tag', '-l', 'bad-*'], { cwd: dir })
  return r.ok ? r.stdout.split('\n').filter(Boolean) : []
}

/** 给提交打坏点标记（tag bad-<short>，重复打自动覆盖）。 */
export async function markBad(dir, ref) {
  const short = String(ref).slice(0, 8)
  await runGit(['tag', '-f', `bad-${short}`, ref], { cwd: dir })
  return { ok: true, tag: `bad-${short}` }
}

/** 全量回退到某提交（reset --hard）。调用方必须自行保证已备份现场。 */
export async function hardReset(dir, ref) {
  const r = await runGit(['reset', '--hard', ref], { cwd: dir })
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'git reset 失败' }
}

/**
 * 数据目录清单（还原时绝不触碰；备份仍完整，只是回退不覆盖它们）。
 * sessions/ 会话日志、storages/ 注册表、snapshot-archive/ 快照、git-rescue/ 插件自身状态。
 * .credentials.yaml 是敏感凭据（600），回退不覆盖（保留当前有效凭据）。
 */
export const DATA_DIRS = ['sessions', 'storages', 'snapshot-archive', 'git-rescue', '.credentials.yaml']

/**
 * 从索引移除数据目录（git rm --cached -r），使其不再被 git 跟踪。
 * 数据目录本应在 .gitignore 内；历史 force-add/checkout 导致被跟踪后，
 * git reset --hard 会覆盖它们——本函数解除跟踪，防止还原覆盖数据（2026-08-21 用户要求）。
 * 文件保留在工作区（不删除），仅从 git 索引移除；移除后再次 commit 即生效（此后不再进历史）。
 * @returns {Promise<{ok:boolean, removed:string[], error?:string}>}
 */
export async function untrackDataDirs(dir) {
  const removed = []
  for (const p of DATA_DIRS) {
    const r = await runGit(['rm', '-r', '--cached', '--ignore-unmatch', '--quiet', p], { cwd: dir })
    if (r.ok) removed.push(p)
    // status 非 0 且非「无匹配」即报错；--ignore-unmatch 保证未跟踪的目录不报错
  }
  // 确保 .gitignore 覆盖数据目录（防再次被 add）
  await ensureDataGitignore(dir)
  return { ok: true, removed }
}

/** 确保 .gitignore 覆盖全部数据目录（幂等合并，不覆盖已有规则）。 */
export async function ensureDataGitignore(dir) {
  try {
    const p = join(dir, '.gitignore')
    const existing = existsSync(p) ? await fs.readFile(p, 'utf8') : ''
    const missing = DATA_DIRS.filter((d) => !existing.split('\n').some((l) => l.trim() === d))
    if (missing.length) {
      const append = (existing.endsWith('\n') || !existing ? '' : '\n') + missing.join('\n') + '\n'
      await fs.writeFile(p, existing + append, { mode: 0o600 })
    }
    // 若 .gitignore 本身被跟踪且修改了 → 需要 commit 才生效；调用方决定何时 commit
  } catch { /* .gitignore 不可写不阻断 */ }
}

/**
 * 只还原 profile/配置类路径（2026-08-21 用户要求：还原不覆盖数据目录）。
 * 完整备份（commit 快照）不变，但 git 回退只恢复配置类文件：
 *   profiles/、settings.yaml、skills/、.anonymous-user-id、.gitignore、session-transfer/
 * sessions/、storages/、git-rescue/ 等数据目录【完全不触碰】——即使曾被误跟踪也跳过。
 *
 * 实现：git checkout <ref> -- <配置路径>（逐个路径），不动数据目录；
 * 等价于"选择性还原"：配置回到好提交，数据保持现状。
 * @param {string} dir .dsh 仓库根
 * @param {string} ref 好提交
 * @returns {Promise<{ok:boolean, restored:string[], skipped:string[], error?:string}>}
 */
export async function restoreProfileOnly(dir, ref) {
  // 配置类路径（还原目标）；数据目录绝不在内
  const CONFIG_PATHS = [
    'profiles',
    'settings.yaml',
    'skills',
    '.anonymous-user-id',
    '.gitignore',
    'session-transfer',
  ]
  const restored = []
  const skipped = []
  try {
    for (const p of CONFIG_PATHS) {
      // 仅当该路径在 <ref> 中确实存在才还原（git checkout 不存在的路径会报错）
      const exists = await runGit(['cat-file', '-e', `${ref}:${p}`], { cwd: dir })
      if (!exists.ok) { skipped.push(p); continue }
      // 先移除工作区/索引中该路径（含历史误跟踪的 sessions 子项不在内——p 是配置类）
      const r = await runGit(['checkout', ref, '--', p], { cwd: dir })
      if (r.ok) restored.push(p)
      else skipped.push(p)
    }
    // 数据目录彻底解除跟踪（防后续 reset/checkout 覆盖；工作区文件保留）
    const untrack = await untrackDataDirs(dir)
    return { ok: true, restored, skipped, removed: untrack.removed }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), restored, skipped }
  }
}

/** 从 log 中找「最后一个没有 bad 标记的提交」（用于崩溃回退）。 */
export async function lastGoodCommit(dir) {
  const r = await runGit(['log', '--format=%h', '-n', '50'], { cwd: dir })
  if (!r.ok) return null
  const all = r.stdout.split('\n').filter(Boolean)
  const bad = new Set((await listBadTags(dir)).map((t) => t.replace(/^bad-/, '')))
  for (const h of all) if (!bad.has(h.slice(0, 8))) return h
  return null
}

/** 写 .gitignore（不存在才写）。@param rules 行数组 */
export async function ensureGitignore(dir, rules) {
  const p = join(dir, '.gitignore')
  if (existsSync(p)) return
  await fs.writeFile(p, rules.join('\n') + '\n', { mode: 0o600 })
}
