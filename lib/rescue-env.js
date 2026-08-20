/**
 * dsh-git-rescue 2.0.0 — 救援环境管理（④）
 *
 * 救援环境 = 纯净环境（Save-clean）+ 测试环境（Save-test），统一命名：
 *   <dsh版本>@Save-clean   纯净环境（初始、无插件、带防装插件锁定）
 *   <dsh版本>@Save-test    测试环境（开发者随便折腾）
 *
 * 职责：
 *  1. 目录命名与解析（getRescueEnvName / parseRescueEnvName）
 *  2. 探测本实例是否运行于救援环境（isRescueEnv / isSaveClean）
 *  3. 生成纯净环境（createCleanEnv，唯一插件 = 救援插件本身）
 *  4. 启停/状态（start / stop / status）
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export const RESCUE_ENV_RE = /@Save-(clean|test)$/i

/**
 * 判断路径是否为救援环境目录（含 @Save-clean / @Save-test）。
 * @param {string|null|undefined} dir
 * @returns {boolean}
 */
export function isRescueEnv(dir) {
  if (!dir) return false
  return RESCUE_ENV_RE.test(String(dir).replace(/\\/g, '/'))
}

/** 判断路径是否为纯净环境目录（@Save-clean）。 */
export function isSaveClean(dir) {
  if (!dir) return false
  return /@Save-clean$/i.test(String(dir).replace(/\\/g, '/'))
}

/** 判断路径是否为测试环境目录（@Save-test）。 */
export function isSaveTest(dir) {
  if (!dir) return false
  return /@Save-test$/i.test(String(dir).replace(/\\/g, '/'))
}

/** 解析救援环境名 → { version, kind: 'clean'|'test' }；非救援环境名返回 null。 */
export function parseRescueEnvName(name) {
  const m = String(name).match(/^(.+)@Save-(clean|test)$/i)
  if (!m) return null
  return { version: m[1], kind: m[2].toLowerCase() }
}

/**
 * 生成救援环境目录名：<dsh版本>@Save-clean / <dsh版本>@Save-test。
 * @param {string} dshVersion 如 '0.1.0-rc.6'
 * @param {'clean'|'test'} kind
 * @returns {string}
 */
export function rescueEnvName(dshVersion, kind) {
  const ver = dshVersion || 'unknown'
  return kind === 'clean' ? `${ver}@Save-clean` : `${ver}@Save-test`
}

/** 环境目录根（与 dsh-clean-env.sh 一致，放 workspace 下）。 */
export function rescueEnvRoot() {
  return process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace'
}

/**
 * 创建纯净环境（Save-clean）：
 *  - 目录结构：profiles/web/sessions/storages/skills
 *  - 唯一插件 = 救援插件本体（dsh-git-rescue 源码复制进 node_modules_local，patch 注册）
 *  - 防装插件锁定：写入 .dsh-env-lock 标记（插件启动时检测此标记启用 save-lock）
 * @param {string} dshVersion
 * @param {object} opts
 * @returns {Promise<{ok:boolean, dir:string, error?:string, existed?:boolean}>}
 */
export async function createCleanEnv(dshVersion, { force = false, rescueSrc = null } = {}) {
  const root = rescueEnvRoot()
  const name = rescueEnvName(dshVersion, 'clean')
  const dir = join(root, name)
  try {
    if (await fs.access(dir).then(() => true).catch(() => false)) {
      if (!force) return { ok: true, dir, existed: true }
      await fs.rm(dir, { recursive: true, force: true })
    }
    // 目录骨架
    for (const sub of ['profiles/web/node_modules_local', 'sessions', 'storages', 'skills']) {
      await fs.mkdir(join(dir, sub), { recursive: true })
    }
    // 空 profile 基线（与 dsh-clean-env.sh 相同的空 cordis.yml）
    await fs.writeFile(join(dir, 'profiles/web/cordis.yml'), '# dsh profile root — an empty entry list. The tree is composed as patches:\n', 'utf8')
    // 防装插件锁定标记（插件启动检测：纯净环境只允许救援插件自身，其余一律拒绝注册）
    await fs.writeFile(join(dir, '.dsh-env-lock'), `clean-env-lock v1\ncreated: ${new Date().toISOString()}\n`, 'utf8')
    // 注册唯一插件 = 救援插件（复制源码）
    if (rescueSrc) {
      const pkgName = 'dsh-git-rescue'
      const target = join(dir, 'profiles/web/node_modules_local', pkgName)
      await fs.mkdir(target, { recursive: true })
      await fs.cp(rescueSrc, target, { recursive: true })
      // 写 cordis.patch.yml：只注册救援插件
      await fs.writeFile(
        join(dir, 'profiles/web/cordis.patch.yml'),
        `- insert:\n    - id: git-rescue\n      name: '${pkgName}'\n`,
        'utf8',
      )
    }
    return { ok: true, dir, name }
  } catch (e) {
    return { ok: false, dir, error: String(e?.message ?? e) }
  }
}

/** 读取救援环境端口文件（由启动脚本写入）。 */
async function readEnvPort(dir) {
  try {
    const raw = await fs.readFile(join(dir, '.dsh-env-port'), 'utf8')
    const port = Number(raw.trim())
    return Number.isInteger(port) && port > 0 ? port : null
  } catch { return null }
}

/** 环境是否在运行（进程 + 端口探活）。 */
export async function isEnvRunning(dir) {
  const port = await readEnvPort(dir)
  if (!port) return false
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch { return false }
}

/**
 * 启动救援环境：setsid nohup 拉起 dsh web（绑 127.0.0.1，首个空闲端口 3083+）。
 * @param {'clean'|'test'} kind
 * @param {string} dshVersion
 * @param {object} opts { appDir, force }
 * @returns {Promise<{ok:boolean, dir?:string, port?:number, error?:string}>}
 */
export async function startRescueEnv(kind, dshVersion, { appDir = '/vol1/@appcenter/deepseek-harness', force = false } = {}) {
  const root = rescueEnvRoot()
  const name = rescueEnvName(dshVersion, kind)
  const dir = join(root, name)
  try {
    // 纯净环境不存在则创建（测试环境由调用方决定是否创建）
    if (kind === 'clean' && !(await fs.access(dir).then(() => true).catch(() => false))) {
      const created = await createCleanEnv(dshVersion, { force, rescueSrc: join(root, 'dsh-git-rescue') })
      if (!created.ok) return { ok: false, error: `纯净环境创建失败: ${created.error}` }
    }
    if (!(await fs.access(dir).then(() => true).catch(() => false))) {
      return { ok: false, error: `救援环境不存在: ${dir}` }
    }
    if (await isEnvRunning(dir)) {
      return { ok: true, dir, port: await readEnvPort(dir), already: true }
    }
    // 找首个空闲端口（3083-3182）
    let port = 0
    const { execFile } = await import('node:child_process')
    const ssOut = await new Promise((resolve) => {
      execFile('ss', ['-tln'], (err, stdout) => resolve(err ? '' : String(stdout)))
    })
    for (let p = 3083; p <= 3182; p++) {
      if (!ssOut.includes(`:${p} `)) { port = p; break }
    }
    if (!port) return { ok: false, error: '无空闲端口（3083-3182 全占用）' }

    const nodeBin = join(appDir, 'bin', 'node')
    const dshBin = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const cmd = `${nodeBin} ${dshBin} web --host 127.0.0.1 --port ${port}`

    // 启动（setsid 脱离会话，日志落盘环境目录）
    const logFile = join(dir, 'dsh-env.log')
    const child = spawn('setsid', ['nohup', 'sh', '-c', cmd], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: dir, DSH_WORKSPACE: root },
    })
    child.stdout?.on('data', (d) => fs.appendFile(logFile, d).catch(() => {}))
    child.stderr?.on('data', (d) => fs.appendFile(logFile, d).catch(() => {}))
    child.unref()

    // 记录端口（供 isEnvRunning / 反代使用）
    await fs.writeFile(join(dir, '.dsh-env-port'), String(port), 'utf8')

    // 等待就绪（最多 40s）
    const deadline = Date.now() + 40_000
    let ready = false
    while (Date.now() < deadline) {
      if (await isEnvRunning(dir)) { ready = true; break }
      await new Promise((r) => setTimeout(r, 1000))
    }
    return { ok: ready, dir, port, ready }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 停止救援环境（按 .dsh-env-port 找进程 TERM）。 */
export async function stopRescueEnv(dir) {
  const port = await readEnvPort(dir)
  if (!port) return { ok: true, stopped: false, detail: '无端口记录' }
  try {
    const { execFile } = await import('node:child_process')
    const psOut = await new Promise((resolve) => {
      execFile('ps', ['aux'], (err, stdout) => resolve(err ? '' : String(stdout)))
    })
    for (const line of psOut.split('\n')) {
      if (line.includes('bin.js') && line.includes('web') && line.includes(`--port ${port}`)) {
        const pid = Number(line.trim().split(/\s+/)[1])
        if (pid) process.kill(pid, 'SIGTERM')
        return { ok: true, stopped: true, pid, port }
      }
    }
    return { ok: true, stopped: false, port, detail: '进程未找到（可能已停止）' }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 救援环境状态汇总。 */
export async function rescueEnvStatus() {
  const root = rescueEnvRoot()
  const { getDshVersion } = await import('./device.js')
  const version = (await getDshVersion()) || 'unknown'
  const out = { version, clean: null, test: null }
  for (const kind of ['clean', 'test']) {
    const name = rescueEnvName(version, kind)
    const dir = join(root, name)
    const exists = await fs.access(dir).then(() => true).catch(() => false)
    out[kind] = {
      name, dir, exists,
      running: exists ? await isEnvRunning(dir) : false,
      port: exists ? await readEnvPort(dir) : null,
      locked: exists ? await fs.access(join(dir, '.dsh-env-lock')).then(() => true).catch(() => false) : false,
    }
  }
  return out
}
