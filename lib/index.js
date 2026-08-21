/**
 * dsh-git-rescue 2.5.0 — 插件主入口
 *
 * 完全重构（2026-08-20 用户 7 步指令）。定位：纯救援——守护进程 + git 仓库恢复。
 * 功能：
 *  - ② .dsh 文件夹本地 git 仓库管理（会话/skill 不因启动失败丢失）
 *    - 配置 GitHub token 或 SSH key 可备份到私有库，仓名 .dsh@<dsh版本>.<设备ID>
 *  - ③ 开机自启守护进程注册（启动命令在 .dsh 目录这一层）
 *  - ④ 救援环境管理（<版本>@Save-clean / @Save-test，纯净环境防装插件锁定）
 *  - ⑤ 专项恢复工具（由 guardian 调用；本插件提供 API/工具入口）
 *  - ⑥ git 还原恢复（guardian 自动执行；本插件提供手动 API/工具）
 *  - ⑦ 纯净 dsh 协助兜底（guardian 唤起 Save-clean，加载本插件 skills 目录）
 *  - 自动更新（从 2.0.0 起具备：强制跟随 GitHub 最新稳定版，env 可关）
 *  - 心跳写入（供 guardian 探活）、崩溃检测、自动 commit、接管式重启
 *  - API：/api/git-rescue/*（status/init/commit/log/config/push/rollback/heartbeat/restart/…）
 *  - Agent 工具：git_rescue_status/init/backup/log/push/rollback/restart/…（见本文件末尾）
 */

import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import {
  gitVersion, httpsHelperMissing, initRepo, commit, log, status,
  headRef, markBad, hardReset, restoreProfileOnly, lastGoodCommit, ensureGitignore, isRepo,
} from './git.js'
import { pushSnapshot } from './github.js'
import { getDeviceId, defaultBackupRepo, getDshVersion } from './device.js'
import { AUTO_UPDATE_ENABLED, UPDATE_INTERVAL_MS, checkForUpdate, applyUpdate } from './self-update.js'
import { isLockedEnv, checkInstallAllowed, saveLockStatus } from './save-lock.js'
import { rescueEnvStatus, startRescueEnv, isRescueEnv } from './rescue-env.js'
import { runRepairTools } from './repair-tools.js'
import { bootAutostartStatus, installBootAutostart } from './boot-startup.js'
// 内存诊断（2026-08-21）：status 暴露系统内存，OOM 故障识别复用
import { readMemSummary } from './fault-classify.js'
// 合并自 v1.13.0（2026-08-21）：救援积分（事件流权威）+ 沙盒/容器能力检测 + 会话恢复联动
import { computeScoresFromEvents, refreshScoreSnapshot, scoreFileName } from './scores.js'
import { detectSandbox } from './sandbox.js'
import { linkSessionRecovery } from './session-link.js'

export const name = 'dsh-git-rescue'
export const inject = ['webServer']

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
const DSH_ROOT = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_ROOT = join(DSH_ROOT, 'git-rescue')
const CONFIG_PATH = join(STATE_ROOT, 'config.json')
// 工作区根：官方源码实证 $DSH_WORKSPACE env 不存在（官方设计理解-权限专题 2026-08-21）——
// 仅作本机约定值使用（官方机制是 runner 内部变量 + storage-json root），勿当作官方 API
const WORKSPACE = process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace'
const SENSITIVE_DIR = join(WORKSPACE, 'data', 'sensitive')
const TOKEN_PATH_LEGACY = join(STATE_ROOT, 'token')
const SUDO_KEY_PATH_LEGACY = join(STATE_ROOT, 'sudo-key')
const HEARTBEAT_PATH = join(STATE_ROOT, 'heartbeat')
const EVENTS_PATH = join(STATE_ROOT, 'events.jsonl')

/** 凭据文件解析：data/sensitive 优先，旧路径回退。 */
async function readCredential(name) {
  const legacy = join(STATE_ROOT, name)
  const sensitive = join(SENSITIVE_DIR, name)
  for (const p of [sensitive, legacy]) {
    try {
      const t = (await fs.readFile(p, 'utf8')).trim()
      if (t) return t
    } catch { /* 继续尝试下一个 */ }
  }
  return ''
}

/** .dsh 仓库的 .gitignore（②：会话/skill/配置入库；凭据/大文件/缓存排除）。 */
const DSH_GITIGNORE = [
  'node_modules/',
  'profiles/*/node_modules/',
  '.credentials.yaml',
  '.env',
  // 凭据与状态（绝不入库）
  '.anonymous-user-id',
  'git-rescue/',
  // 会话/storages 走「定期全量基线 + 短周期增量」策略（zstd 二进制，常规增量不入）
  'sessions/',
  'storages/',
  '*.log',
  '*.pid',
]

const DEFAULT_CONFIG = {
  githubOwner: '',
  githubRepo: '',
  autoCommitMs: 30 * 60 * 1000,
  heartbeatMs: 30 * 1000,
  sessionsBaselineMs: 24 * 60 * 60 * 1000,
  // ① 单仓库：仅 .dsh（workspace 不再纳入，2026-08-20 用户指令）
  workspaceEnabled: false,
  workspaceDir: '',
}

// ---------- 状态 ----------
let cfg = { ...DEFAULT_CONFIG }
let heartbeatTimer = null
let autoCommitTimer = null
let autoUpdateTimer = null
let sessionsBaselineTimer = null
let lastCrashDetectedAt = null
let autoUpdateState = { enabled: AUTO_UPDATE_ENABLED, lastCheckAt: null, lastResult: null, pendingRestart: false }
// 合并自 v1.13.0：会话恢复联动状态（crash 后自动扫描续跑）
let sessionLinkState = { available: null, lastAction: null, lastResult: null, lastAt: null }
// 2026-08-21 对齐官方权限设计：原子写 + 敏感文件权限守卫（同 dsh-atomic-write / dsh-credentials-local）
import { writeFileAtomic, readFileSecure } from './atomic.js'

// ---------- 基础工具 ----------
async function pathExists(p) { try { await fs.access(p); return true } catch { return false } }

function ts() { return new Date().toISOString() }

async function appendEvent(type, detail = {}) {
  try {
    await fs.mkdir(STATE_ROOT, { recursive: true })
    await fs.appendFile(EVENTS_PATH, JSON.stringify({ ts: ts(), type, ...detail }) + '\n')
  } catch { /* 事件日志失败不致命 */ }
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch { cfg = { ...DEFAULT_CONFIG } }
}

async function saveConfig() {
  await fs.mkdir(STATE_ROOT, { recursive: true })
  await writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

async function readToken() {
  try {
    const t = (await readFileSecure(join(SENSITIVE_DIR, 'github-token'), 'utf8')).trim()
    if (t) return t
  } catch { /* 回退旧路径 */ }
  try { return (await readFileSecure(TOKEN_PATH_LEGACY)).trim() } catch { return '' }
}

async function writeToken(token) {
  await fs.mkdir(STATE_ROOT, { recursive: true })
  await writeFileAtomic(TOKEN_PATH_LEGACY, String(token).trim())
}

async function readSudoKey() {
  try {
    const k = (await fs.readFile(join(SENSITIVE_DIR, 'sudo-key'), 'utf8')).trim()
    if (k) return k
  } catch { /* 回退旧路径 */ }
  try { return (await fs.readFile(SUDO_KEY_PATH_LEGACY, 'utf8')).trim() } catch { return '' }
}

function maskToken(t) { return t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '' }

// ---------- 仓库管理（②） ----------

/** 初始化 .dsh 仓库（git init + .gitignore + 基线 commit）。 */
async function initRepos() {
  await initRepo(DSH_ROOT)
  await ensureGitignore(DSH_ROOT, DSH_GITIGNORE)
  const dshCommit = await commit(DSH_ROOT, 'chore(guard): init | baseline snapshot of .dsh', ['--allow-empty'])
  return {
    dsh: { ok: true, initialized: !dshCommit.empty || (await headRef(DSH_ROOT)) !== null, head: await headRef(DSH_ROOT) },
  }
}

/** 提交 .dsh 仓库。profile 变化时先打包 zip 还原点（unzip 手动覆盖小功能，2026-08-21）。 */
async function commitAll(reason) {
  const out = { dsh: { ok: true, empty: true } }
  // 还原点：提交前把未提交的 profile/配置类变更打包成 zip（原始相对路径，手动 unzip 即覆盖恢复）；
  // 文件名后缀标注触发插件（推断不到回退 config）。失败不阻断提交（git 仍是主通道）。
  try {
    const { buildRestorePoint } = await import('./restore-point.js')
    const rp = await buildRestorePoint({ dshRoot: DSH_ROOT, reason })
    if (rp.ok && rp.path) {
      out.restorePoint = { ok: true, name: rp.name, plugin: rp.plugin, count: rp.count }
      await appendEvent('restore-point', { name: rp.name, plugin: rp.plugin, count: rp.count, reason })
    } else if (!rp.empty) {
      out.restorePoint = { ok: false, error: rp.error }
    }
  } catch { /* 打包失败不阻断提交 */ }
  out.dsh = await commit(DSH_ROOT, `chore(guard): ${reason} | auto snapshot`)
  return out
}

/** sessions/storages 全量基线入库（git add -f → 基线 commit → rm --cached 恢复忽略）。 */
async function commitSessionsBaseline() {
  try {
    const { runGit } = await import('./git.js')
    const dirs = []
    for (const d of ['sessions', 'storages']) {
      const p = join(DSH_ROOT, d)
      if (await pathExists(p)) dirs.push(p)
    }
    if (dirs.length === 0) return { ok: true, empty: true }
    for (const d of dirs) {
      const r = await runGit(['add', '-f', d], { cwd: DSH_ROOT })
      if (!r.ok) return { ok: false, error: `add -f ${d} 失败: ${r.stderr}` }
    }
    const cm = await runGit(['commit', '-m', 'chore(guard): sessions baseline | 定期全量基线（sessions/storages）'], { cwd: DSH_ROOT })
    if (!cm.ok) {
      await runGit(['reset'], { cwd: DSH_ROOT }).catch(() => {})
      return { ok: true, empty: true }
    }
    for (const d of dirs) {
      await runGit(['rm', '-r', '--cached', d.replace(DSH_ROOT, '.').replace(/^\//, '')], { cwd: DSH_ROOT }).catch(() => {})
    }
    await appendEvent('sessions-baseline', { ok: true, hash: await headRef(DSH_ROOT) })
    return { ok: true, hash: await headRef(DSH_ROOT) }
  } catch (e) {
    await appendEvent('sessions-baseline', { error: String(e?.message ?? e) })
    return { ok: false, error: String(e?.message ?? e) }
  }
}

async function collectStatus() {
  const heartbeat = await readHeartbeat()
  const dshHead = await headRef(DSH_ROOT)
  const dshStatus = await status(DSH_ROOT)
  const device = await getDeviceId(STATE_ROOT)
  const backup = await defaultBackupRepo(STATE_ROOT)
  const lock = await saveLockStatus(DSH_ROOT)
  return {
    ok: true,
    plugin: 'dsh-git-rescue',
    version: '2.5.0',
    git: { version: await gitVersion(), httpsHelperMissing: await httpsHelperMissing() },
    hostname: hostname(),
    device: { id: device.id, source: device.source },
    // 合并自 v1.13.0：救援积分（事件流权威，防刷分）+ 沙盒/容器能力检测
    scores: await computeScoresFromEvents(STATE_ROOT, device.id, device.source),
    sandbox: await detectSandbox(),
    mem: readMemSummary(),
    dshVersion: backup.dshVersion,
    backupRepo: backup.repo,
    rescueEnv: { isRescue: isRescueEnv(DSH_ROOT), ...(await rescueEnvStatus()) },
    saveLock: lock,
    bootAutostart: await bootAutostartStatus(DSH_ROOT),
    repos: {
      dsh: { root: DSH_ROOT, repo: await isRepo(DSH_ROOT), head: dshHead, changed: dshStatus.changed },
    },
    heartbeat: heartbeat ? { ageMs: Date.now() - heartbeat.ts, ok: Date.now() - heartbeat.ts < (cfg.heartbeatMs * 3 || 90000) } : null,
    config: { ...cfg },
    lastCrashDetectedAt,
    autoUpdate: { ...autoUpdateState },
    sessionLink: { ...sessionLinkState },
  }
}

// ---------- 心跳 ----------

async function readHeartbeat() {
  try {
    const raw = await fs.readFile(HEARTBEAT_PATH, 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

async function writeHeartbeat() {
  await fs.mkdir(STATE_ROOT, { recursive: true })
  const hb = { ts: Date.now(), pid: process.pid, plugin: name, ok: true }
  await writeFileAtomic(HEARTBEAT_PATH, JSON.stringify(hb))
  return hb
}

/** 启动时崩溃检测：上次心跳已过期 → 上次实例异常退出。 */
async function detectCrashOnStartup() {
  const hb = await readHeartbeat()
  if (!hb) return false
  const age = Date.now() - hb.ts
  if (age > (cfg.heartbeatMs * 3 || 90000)) {
    lastCrashDetectedAt = hb.ts
    await appendEvent('crash-detected', { lastHeartbeatAgeMs: age, lastPid: hb.pid })
    await commitAll('crash-detected | pre-rollback snapshot of broken state')
    // 会话恢复联动（合并自 v1.13.0，用户约定：装了 session-manager 才调用，没装不调用，不内置）
    // 崩溃后扫描全部会话并自动续跑可续的；失败静默不影响主流程
    try {
      const r = await linkSessionRecovery({ reason: 'crash-detected' })
      sessionLinkState.available = !r.skipped
      sessionLinkState.lastAction = 'scan'
      sessionLinkState.lastResult = r
      sessionLinkState.lastAt = ts()
      await appendEvent('session-recovery-link', { available: !r.skipped, result: r })
    } catch (e) {
      sessionLinkState.lastResult = { ok: false, skipped: false, detail: String(e?.message ?? e) }
      await appendEvent('session-recovery-link', { error: String(e?.message ?? e) })
    }
    return true
  }
  return false
}

// ---------- 回退（⑥） ----------

/** 回退 .dsh 仓库到指定 ref：先 commit 现场 + 打 bad 标记，再只还原配置（2026-08-21 用户要求：不覆盖数据目录）。 */
async function rollbackRepo(ref, scoreType = 'crash') {
  await commit(DSH_ROOT, `chore(guard): pre-rollback backup | .dsh @ ${await headRef(DSH_ROOT) ?? 'no-head'}`)
  const brokenHead = await headRef(DSH_ROOT)
  if (brokenHead) await markBad(DSH_ROOT, brokenHead)
  const r = await restoreProfileOnly(DSH_ROOT, ref)
  if (!r.ok) return r
  await appendEvent('rollback', { repo: 'dsh', from: brokenHead, to: ref, scoreType, mode: 'profile-only', restored: r.restored })
  return { ok: true, from: brokenHead, to: ref, mode: 'profile-only', restored: r.restored }
}

/** 自动回退到最后一个好提交（guardian 调用，或手动 API 触发）。 */
async function autoRollback(scoreType = 'crash') {
  const good = await lastGoodCommit(DSH_ROOT)
  if (!good) return { ok: false, error: '没有可回退的好提交（仓库无提交或全部被标记 bad）' }
  const res = await rollbackRepo(good, scoreType)
  return { ...res, target: good }
}

// ---------- 自动更新（从 2.0.0 起具备） ----------

/** 执行一次自动更新检查：有新版则应用，并记录状态/事件。 */
async function runAutoUpdateCheck() {
  if (!AUTO_UPDATE_ENABLED) return
  const token = await readToken()
  autoUpdateState.lastCheckAt = ts()
  try {
    const check = await checkForUpdate(token)
    autoUpdateState.lastResult = check
    if (check.ok && check.updateAvailable) {
      await appendEvent('auto-update-check', { action: 'apply', from: check.installedVersion, to: check.remoteVersion })
      const applied = await applyUpdate(token)
      if (applied.ok && applied.updated) {
        autoUpdateState.pendingRestart = true
        await appendEvent('auto-update-applied', { from: applied.from, to: applied.to })
        console.log(`[git-rescue] 已自动更新 ${applied.from} → ${applied.to}，重启 DSH 后生效`)
      } else {
        await appendEvent('auto-update-failed', { error: applied.error, from: check.installedVersion, to: check.remoteVersion })
        console.log(`[git-rescue] 自动更新失败: ${applied.error}`)
      }
    } else if (check.ok) {
      if (autoUpdateState.pendingRestart) autoUpdateState.pendingRestart = false
    }
  } catch (e) {
    autoUpdateState.lastResult = { ok: false, error: String(e?.message ?? e) }
    await appendEvent('auto-update-error', { error: String(e?.message ?? e) })
  }
}

// ---------- 接管式重启（dsh-restart-takeover 方案） ----------

/** 解析 DSH 拉起命令（Bug B 修复 2026-08-20：主环境优先 runner，防误拉起测试实例）。 */
function resolveStartCmd(port) {
  const isRescueHome = isRescueEnv(DSH_ROOT)
  if (!isRescueHome) {
    // 正式环境（主 .dsh）：用 runner.js 拉起主实例
    return `${process.execPath} /vol1/@appcenter/deepseek-harness/bin/runner.js`
  }
  // 救援/测试环境：用测试实例脚本
  const testScript = join(WORKSPACE, 'dsh-test-instance.sh')
  try {
    if (existsSync(testScript)) return `bash ${testScript}`
  } catch { /* 探测失败走兜底 */ }
  return `${process.execPath} /vol1/@appcenter/deepseek-harness/bin/runner.js`
}

/** 接管式重启 DSH：独立脚本 TERM → 轮询恢复 → 验证 → 留痕。 */
async function takeoverRestart() {
  const logFile = join(STATE_ROOT, 'restart-latest.log')
  const scriptFile = join(STATE_ROOT, 'restart-takeover.sh')
  const port = process.env.DSH_PORT || 3081
  const host = process.env.DSH_HOST || '127.0.0.1'
  const autoCmd = resolveStartCmd(port)
  const startCmd = process.env.DSH_START_CMD || autoCmd || ''

  const script = `#!/bin/bash
# dsh-git-rescue 接管式重启（自动生成）
LOG="${logFile}"
: > "$LOG"
echo "[$(date +%T)] 接管式重启开始 (port=${port})" >> "$LOG"
RPID=$(ps -eo pid,args | grep "bin/runner.js" | grep -v grep | awk '{print $1}' | head -1)
if [ -z "$RPID" ]; then
  RPID=$(ps -eo pid,args | grep "bin.js web" | grep -v grep | grep -- "--port ${port}" | awk '{print $1}' | head -1)
fi
echo "[$(date +%T)] 目标 PID=$RPID" >> "$LOG"
if [ -n "$RPID" ]; then
  kill "$RPID" 2>/dev/null
else
  echo "[$(date +%T)] ❌ 未找到任何 DSH 进程" >> "$LOG"
fi
sleep 3
UP=0
for i in $(seq 1 12); do
  sleep 5
  if curl -s -o /dev/null -w "%{http_code}" "http://${host}:${port}/" -m 3 2>/dev/null | grep -q 200; then
    UP=1; echo "[$(date +%T)] 服务自动恢复 (第 $i 轮)" >> "$LOG"; break
  fi
done
if [ "$UP" != "1" ] && [ -n "${startCmd}" ]; then
  echo "[$(date +%T)] ⏳ 60s 未自动恢复，执行拉起命令: ${startCmd}" >> "$LOG"
  (cd /vol1/@appshare/DeepSeekHarness/workspace 2>/dev/null || cd /; setsid nohup bash -c "${startCmd}" >> "$LOG" 2>&1 < /dev/null &)
fi
if [ "$UP" != "1" ]; then
  for i in $(seq 1 48); do
    sleep 5
    if curl -s -o /dev/null -w "%{http_code}" "http://${host}:${port}/" -m 3 2>/dev/null | grep -q 200; then
      UP=1; echo "[$(date +%T)] 服务恢复 (第 $i 轮/第二段)" >> "$LOG"; break
    fi
  done
fi
if [ "$UP" = 1 ]; then
  sleep 10
  echo "[$(date +%T)] --- /api/git-rescue/status ---" >> "$LOG"
  curl -s "http://${host}:${port}/api/git-rescue/status" -m 5 >> "$LOG" 2>&1
  echo "" >> "$LOG"
  echo "[$(date +%T)] ✅ 接管式重启完成" >> "$LOG"
else
  echo "[$(date +%T)] ❌ 服务未在 300s 内恢复" >> "$LOG"
fi
`
  await fs.mkdir(STATE_ROOT, { recursive: true })
  await fs.writeFile(scriptFile, script, { mode: 0o700 })
  const { spawn } = await import('node:child_process')
  const child = spawn('setsid', ['nohup', 'bash', scriptFile], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DSH_PORT: String(port), DSH_HOST: host, DSH_START_CMD: startCmd },
  })
  child.unref()
  await appendEvent('restart-takeover', { logFile, startCmd: startCmd || null })
  return { ok: true, logFile, message: `接管式重启已启动：DSH 即将重启，会话会中断；重启与验证由独立脚本完成，结果写入 ${logFile}（约 30~90s 后可查看）` }
}

// ---------- 定时器 ----------

function startTimers() {
  stopTimers()
  heartbeatTimer = setInterval(() => { writeHeartbeat().catch(() => {}) }, cfg.heartbeatMs)
  heartbeatTimer.unref?.()
  autoCommitTimer = setInterval(() => {
    commitAll('periodic').then((r) => {
      if (!r.dsh.empty) appendEvent('auto-commit', { reason: 'periodic' })
    }).catch(() => {})
  }, cfg.autoCommitMs)
  autoCommitTimer.unref?.()
  if (AUTO_UPDATE_ENABLED) {
    autoUpdateTimer = setInterval(() => { runAutoUpdateCheck().catch(() => {}) }, UPDATE_INTERVAL_MS)
    autoUpdateTimer.unref?.()
  }
  sessionsBaselineTimer = setInterval(() => { commitSessionsBaseline().catch(() => {}) }, cfg.sessionsBaselineMs)
  sessionsBaselineTimer.unref?.()
  setTimeout(() => { commitSessionsBaseline().catch(() => {}) }, 5 * 60 * 1000).unref?.()
}

function stopTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (autoCommitTimer) clearInterval(autoCommitTimer)
  if (autoUpdateTimer) clearInterval(autoUpdateTimer)
  if (sessionsBaselineTimer) clearInterval(sessionsBaselineTimer)
  heartbeatTimer = autoCommitTimer = autoUpdateTimer = sessionsBaselineTimer = null
}

// ---------- HTTP 工具 ----------

function send(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

// ---------- API ----------

async function handleApi(req, res, url, method) {
  const path = url.pathname
  if (!path.startsWith('/api/git-rescue')) return undefined

  if (method === 'GET' && path === '/api/git-rescue/status') return send(res, 200, await collectStatus())

  if (method === 'POST' && path === '/api/git-rescue/init') {
    const r = await initRepos()
    await commitAll('init')
    return send(res, 200, { ok: true, ...r })
  }

  if (method === 'POST' && path === '/api/git-rescue/commit') {
    const body = await readJson(req)
    const r = await commitAll(body?.reason || 'manual')
    return send(res, 200, { ok: true, dsh: r.dsh, restorePoint: r.restorePoint })
  }

  // unzip 还原点小功能（2026-08-21）：列表 / 手动覆盖恢复 / 删除
  if (method === 'GET' && path === '/api/git-rescue/restore-points') {
    const { listRestorePoints } = await import('./restore-point.js')
    return send(res, 200, await listRestorePoints(DSH_ROOT))
  }
  if (method === 'POST' && path === '/api/git-rescue/restore-points/build') {
    const body = await readJson(req)
    const { buildRestorePoint } = await import('./restore-point.js')
    return send(res, 200, await buildRestorePoint({ dshRoot: DSH_ROOT, reason: body?.reason || 'manual-api' }))
  }
  if (method === 'POST' && path === '/api/git-rescue/restore-points/restore') {
    const body = await readJson(req)
    const { restoreRestorePoint } = await import('./restore-point.js')
    const r = await restoreRestorePoint({ dshRoot: DSH_ROOT, name: body?.name })
    return r.ok ? send(res, 200, r) : send(res, 400, r)
  }
  if (method === 'POST' && path === '/api/git-rescue/restore-points/remove') {
    const body = await readJson(req)
    const { removeRestorePoint } = await import('./restore-point.js')
    const r = await removeRestorePoint({ dshRoot: DSH_ROOT, name: body?.name })
    return r.ok ? send(res, 200, r) : send(res, 400, r)
  }

  if (method === 'GET' && path === '/api/git-rescue/log') {
    const n = Number(url.searchParams.get('n') || 10)
    return send(res, 200, { ok: true, commits: await log(DSH_ROOT, n) })
  }

  if (method === 'GET' && path === '/api/git-rescue/config') {
    const t = await readToken()
    const sk = await readSudoKey()
    return send(res, 200, { ok: true, config: { ...cfg, githubTokenSet: !!t, githubToken: maskToken(t), sudoKeySet: !!sk } })
  }

  if (method === 'POST' && path === '/api/git-rescue/config') {
    const body = await readJson(req)
    for (const k of ['githubOwner', 'githubRepo', 'autoCommitMs', 'heartbeatMs']) {
      if (body[k] !== undefined) cfg[k] = body[k]
    }
    if (body.githubToken) {
      await writeToken(body.githubToken)
      await appendEvent('config-update', { githubToken: true })
    }
    await saveConfig()
    startTimers()
    return send(res, 200, { ok: true })
  }

  if (method === 'POST' && path === '/api/git-rescue/push') {
    // ② 远端备份：SSH key 优先，token 兜底；仓名 .dsh@<dsh版本>.<设备ID>
    const token = await readToken()
    const backup = await defaultBackupRepo(STATE_ROOT)
    const repo = cfg.githubRepo || backup.repo
    const r = await pushSnapshot({
      token,
      owner: cfg.githubOwner || '',
      repo,
      repoDir: DSH_ROOT,
      message: `dsh-git-rescue backup @ ${ts()}`,
    })
    if (!r.ok) return send(res, 500, { ok: false, error: r.error })
    await appendEvent('push', { repo: r.repo, commit: r.commit, files: r.files, method: r.method })
    return send(res, 200, { ok: true, ...r })
  }

  if (method === 'POST' && path === '/api/git-rescue/rollback') {
    const r = await autoRollback('manual')
    return r.ok ? send(res, 200, r) : send(res, 400, r)
  }

  if (method === 'POST' && path === '/api/git-rescue/heartbeat') {
    return send(res, 200, { ok: true, heartbeat: await writeHeartbeat() })
  }

  if (method === 'POST' && path === '/api/git-rescue/restart') {
    const r = await takeoverRestart()
    return send(res, 200, r)
  }

  if (method === 'GET' && path === '/api/git-rescue/restart-log') {
    try {
      const raw = await fs.readFile(join(STATE_ROOT, 'restart-latest.log'), 'utf8')
      return send(res, 200, { ok: true, log: raw })
    } catch {
      return send(res, 200, { ok: true, log: '（暂无接管式重启日志）' })
    }
  }

  // ⑤ 专项恢复工具（只读诊断 / 尝试修复）
  if (method === 'GET' && path === '/api/git-rescue/repair-tools') {
    const { repairTools } = await import('./repair-tools.js')
    const hits = []
    for (const t of repairTools(DSH_ROOT)) {
      try { hits.push({ id: t.id, name: t.name, ...(await t.diagnose()) }) } catch { /* 忽略 */ }
    }
    return send(res, 200, { ok: true, hits })
  }
  if (method === 'POST' && path === '/api/git-rescue/repair-tools') {
    const r = await runRepairTools(DSH_ROOT, { sudoKey: await readSudoKey() })
    return send(res, 200, { ok: true, ...r })
  }

  // ④ 救援环境管理
  if (method === 'GET' && path === '/api/git-rescue/rescue-env') {
    return send(res, 200, { ok: true, ...(await rescueEnvStatus()) })
  }
  if (method === 'POST' && path === '/api/git-rescue/rescue-env/start') {
    const body = await readJson(req)
    const version = (await getDshVersion()) || 'unknown'
    const r = await startRescueEnv(body?.kind || 'clean', version, { workspace: WORKSPACE })
    return send(res, r.ok ? 200 : 500, r)
  }

  // ③ 开机自启
  if (method === 'GET' && path === '/api/git-rescue/boot-autostart') {
    return send(res, 200, { ok: true, ...(await bootAutostartStatus(DSH_ROOT)) })
  }
  if (method === 'POST' && path === '/api/git-rescue/boot-autostart/install') {
    const r = await installBootAutostart(DSH_ROOT, { dshHome: DSH_ROOT })
    return send(res, r.ok ? 200 : 500, r)
  }

  // ④ 防装插件锁定
  if (method === 'GET' && path === '/api/git-rescue/save-lock') {
    return send(res, 200, { ok: true, ...(await saveLockStatus(DSH_ROOT)) })
  }
  if (method === 'POST' && path === '/api/git-rescue/save-lock/check') {
    const body = await readJson(req)
    const r = await checkInstallAllowed(DSH_ROOT, { pluginName: body?.pluginName || '' })
    return send(res, r.allowed ? 200 : 403, r)
  }

  // 会话恢复联动（合并自 v1.13.0）：探测 dsh-session-manager 是否安装，已安装则调用其 scan 自动续跑
  if (method === 'POST' && path === '/api/git-rescue/link-session-recovery') {
    const r = await linkSessionRecovery({ reason: 'manual' })
    return send(res, 200, { ok: true, ...r })
  }

  // 自动更新（检查 / 应用）
  if (method === 'POST' && path === '/api/git-rescue/auto-update') {
    const token = await readToken()
    if (url.searchParams.get('apply') === '1') {
      const r = await applyUpdate(token)
      if (r.ok && r.updated) autoUpdateState.pendingRestart = true
      await appendEvent('auto-update-manual', { updated: !!r.updated, ...r })
      return send(res, r.ok ? 200 : 500, { ok: r.ok, updated: !!r.updated, from: r.from, to: r.to, error: r.error })
    }
    const check = await checkForUpdate(token)
    autoUpdateState.lastCheckAt = ts()
    autoUpdateState.lastResult = check
    await appendEvent('auto-update-manual-check', { ...check })
    return send(res, check.ok ? 200 : 500, check)
  }

  return send(res, 404, { ok: false, error: `unknown route ${path}` })
}

// ---------- 工具 ----------

function defineToolSimple(name, description, fn, params) {
  return {
    name,
    description,
    parameters: params || { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args, exec) {
      try { return await fn(args, exec) } catch (e) { return `git-rescue 工具错误: ${String(e?.message ?? e)}` }
    },
  }
}

// ---------- 插件入口 ----------

export async function apply(ctx) {

  await loadConfig()

  // ④ 纯净环境防装插件锁定：运行于 @Save-clean 环境时拒绝其他插件注册（只允许救援插件自身）
  const lock = await isLockedEnv(DSH_ROOT)
  if (lock.locked) {
    console.log(`[git-rescue] 🔒 纯净环境锁定生效（@Save-clean）：仅允许救援插件自身，禁止安装/注册其他插件`)
  }

  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer')
    if (!webServer) return
    wctx.effect(() => {
      return webServer.register({
        kind: 'prefix',
        path: '/api/git-rescue',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh.local')
          try { return await handleApi(req, res, url, req.method ?? 'GET') } catch (e) { return send(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        },
      })
    })
  })

  const tools = ctx.get('tools')
  if (tools) {
    tools.register(defineToolSimple('git_rescue_status', '查看 git-rescue 状态（git/仓库/设备/备份仓/救援环境/开机自启/自动更新）', async () => {
      const s = await collectStatus()
      const g = s.git
      const au = s.autoUpdate
      const auLine = au.enabled
        ? (au.pendingRestart ? `自动更新: ON, 已更新待重启` : `自动更新: ON${au.lastCheckAt ? `, 最近检查 ${au.lastResult?.detail || ''}` : ''}`)
        : '自动更新: OFF (env DSH_GIT_RESCUE_AUTO_UPDATE=0)'
      return `git: ${g.version || '不可用'}${g.httpsHelperMissing ? ' (https 助手缺失→推送走 REST API)' : ''}\n` +
        `.dsh 仓库: ${s.repos.dsh.repo ? '已初始化' : '未初始化'}${s.repos.dsh.head ? ` @ ${s.repos.dsh.head}` : ''}${s.repos.dsh.changed ? `, ${s.repos.dsh.changed} 项未提交` : ''}\n` +
        `设备: ${s.device.id.slice(0, 12)} (${s.device.source}) / dsh版本: ${s.dshVersion || '未知'}\n` +
        `远端备份仓: ${s.backupRepo}\n` +
        `系统内存: ${s.mem?.detail || '未知'}\n` +
        `救援环境: ${s.rescueEnv.isRescue ? '本实例运行于救援环境' : '正式环境'} (clean: ${s.rescueEnv.clean?.exists ? (s.rescueEnv.clean.running ? '运行中' : '未运行') : '未创建'}, test: ${s.rescueEnv.test?.exists ? (s.rescueEnv.test.running ? '运行中' : '未运行') : '未创建'})\n` +
        `防装插件锁定: ${s.saveLock.locked ? '生效（纯净环境）' : '未启用'}\n` +
        `开机自启: ${s.bootAutostart.registered ? '已注册' : '未注册'}\n` +
        `心跳: ${s.heartbeat ? (s.heartbeat.ok ? '正常' : '过期') : '无'}\n` +
        auLine
    }))
    tools.register(defineToolSimple('git_rescue_init', '初始化 .dsh git 仓库（git init + .gitignore + 基线 commit）', async () => {
      const r = await initRepos()
      await commitAll('init')
      return `已初始化 .dsh 仓库${r.dsh.head ? ` @ ${r.dsh.head}` : ''}`
    }))
    tools.register(defineToolSimple('git_rescue_backup', '立即 commit 当前状态（自动备份点）', async (args) => {
      const r = await commitAll(args?.reason || 'tool')
      return r.dsh.empty ? '无变更，跳过 commit' : `已提交 .dsh (${r.dsh.hash})`
    }, { type: 'object', properties: { reason: { type: 'string', description: '提交原因，将写入 commit message' } } }))
    tools.register(defineToolSimple('git_rescue_log', '查看最近提交记录', async (args) => {
      const lines = await log(DSH_ROOT, Number(args?.n || 10))
      return lines.length ? lines.join('\n') : '暂无提交'
    }, { type: 'object', properties: { n: { type: 'integer', description: '查看最近 N 条提交记录，默认 10' } } }))
    tools.register(defineToolSimple('git_rescue_restorepoints', '查看 profile 还原点 zip 列表（提交 git 时自动打包，手动 unzip 可覆盖恢复）', async () => {
      const { listRestorePoints } = await import('./restore-point.js')
      const r = await listRestorePoints(DSH_ROOT)
      if (!r.ok) return `读取失败: ${r.error}`
      if (!r.points.length) return '暂无还原点（profile 变化提交 git 时自动生成）'
      return '还原点列表（位于 .dsh/git-rescue/restore-points/）:\n' +
        r.points.map((p) => `  ${p.name} (${p.size} B, ${new Date(p.mtimeMs).toLocaleString()})`).join('\n')
    }))
    tools.register(defineToolSimple('git_rescue_restorepoint_build', '手动打包一次 profile 还原点 zip（unzip 手动覆盖用）', async (args) => {
      const { buildRestorePoint } = await import('./restore-point.js')
      const r = await buildRestorePoint({ dshRoot: DSH_ROOT, reason: args?.reason || 'tool' })
      if (!r.ok) return `打包失败: ${r.error}`
      if (r.empty) return '无未提交的 profile/配置类变更，无需打包'
      return `已打包还原点: ${r.name}（${r.count} 个文件${r.plugin ? `，触发插件 ${r.plugin}` : '，未识别插件' }）`
    }, { type: 'object', properties: { reason: { type: 'string', description: '打包原因' } } }))
    tools.register(defineToolSimple('git_rescue_restorepoint_restore', '手动覆盖恢复：解压还原点 zip 覆盖 .dsh 同名文件（谨慎操作）', async (args) => {
      const { restoreRestorePoint } = await import('./restore-point.js')
      const r = await restoreRestorePoint({ dshRoot: DSH_ROOT, name: args?.name })
      if (!r.ok) return `恢复失败: ${r.error}`
      return `已恢复 ${r.restored.length} 个文件: ${r.restored.join(', ') || '(无)'}${r.skipped?.length ? `（跳过 ${r.skipped.length} 个不安全路径）` : ''}`
    }, { type: 'object', properties: { name: { type: 'string', description: '还原点文件名（含 .zip，可用 git_rescue_restorepoints 查看）' } } }))
    tools.register(defineToolSimple('git_rescue_rollback', '回退到最后一个好提交（当前坏状态先备份+标记 bad）', async () => {
      const r = await autoRollback('manual')
      return r.ok ? `已回退 ${r.from || '?'} → ${r.to}` : `回退失败: ${r.error}`
    }))
    tools.register(defineToolSimple('git_rescue_push', '推送当前快照到 GitHub 私有备份仓库（SSH key/token 双方案，仓名 .dsh@<版本>.<设备ID>）', async () => {
      const token = await readToken()
      const backup = await defaultBackupRepo(STATE_ROOT)
      const repo = cfg.githubRepo || backup.repo
      const r = await pushSnapshot({
        token,
        owner: cfg.githubOwner || '',
        repo,
        repoDir: DSH_ROOT,
        message: `dsh-git-rescue backup @ ${ts()}`,
      })
      return r.ok ? `已推送 ${r.files} 个文件 → ${r.url} (${String(r.commit).slice(0, 8)}) [${r.method}]` : `推送失败: ${r.error}`
    }))
    tools.register(defineToolSimple('git_rescue_restart', '接管式重启 DSH（独立脚本 TERM→轮询恢复→验证；当前会话会中断，结果写入 restart-latest.log 供后续查看）', async () => {
      const r = await takeoverRestart()
      return r.message
    }))
    tools.register(defineToolSimple('git_rescue_repair', '⑤ 专项恢复工具：诊断并尝试修复常见故障（插件配置/引导软链/只读卷/插件加载）', async () => {
      const r = await runRepairTools(DSH_ROOT, { sudoKey: await readSudoKey() })
      if (!r.hits.length) return '专项工具诊断：无命中故障'
      return `专项工具命中 ${r.hits.length} 类:\n` + r.fixes.map((f) => `  ${f.id}: ${f.detail}`).join('\n')
    }))
    tools.register(defineToolSimple('git_rescue_rescue_env', '④ 救援环境状态与启动（Save-clean 纯净环境 / Save-test 测试环境）', async (args) => {
      const version = (await getDshVersion()) || 'unknown'
      if (args?.action === 'start') {
        const r = await startRescueEnv(args?.kind || 'clean', version, { workspace: WORKSPACE })
        return r.ok ? `救援环境已启动: ${r.dir} (port ${r.port}${r.already ? ', 已运行' : ''})` : `启动失败: ${r.error}`
      }
      const st = await rescueEnvStatus()
      return `dsh版本: ${st.version}\n` +
        `clean: ${st.clean.exists ? (st.clean.running ? `运行中 :${st.clean.port}` : '未运行') : '未创建'} ${st.clean.name}\n` +
        `test:  ${st.test.exists ? (st.test.running ? `运行中 :${st.test.port}` : '未运行') : '未创建'} ${st.test.name}`
    }, { type: 'object', properties: { action: { type: 'string', description: 'start 或 查看（默认）' }, kind: { type: 'string', description: 'clean 或 test' } } }))
    tools.register(defineToolSimple('git_rescue_boot_autostart', '③ 开机自启状态/注册（守护进程启动命令在 .dsh 目录这一层）', async (args) => {
      if (args?.action === 'install') {
        const r = await installBootAutostart(DSH_ROOT, { dshHome: DSH_ROOT })
        return r.ok ? `已注册开机自启: ${r.rcLocal}（启动脚本 ${r.script}）` : `注册失败: ${r.error}${r.manual ? `\n人工操作指引:\n${r.manual}` : ''}`
      }
      const b = await bootAutostartStatus(DSH_ROOT)
      return `启动脚本: ${b.script} (${b.hasScript ? '已生成' : '未生成'})\n` +
        `rc.local: ${b.rcLocal || '未找到'} (${b.rcRegistered ? '已注册' : '未注册'})\n` +
        `状态: ${b.registered ? '✅ 已注册' : '❌ 未注册'}`
    }, { type: 'object', properties: { action: { type: 'string', description: 'install 或 查看（默认）' } } }))
    tools.register(defineToolSimple('git_rescue_link_recovery', '触发会话恢复联动：探测 dsh-session-manager 是否安装，已安装则调用其 scan 自动续跑被中断的会话（未安装则跳过，不内置会话恢复）', async () => {
      const r = await linkSessionRecovery({ reason: 'tool' })
      return r.skipped
        ? 'dsh-session-manager 未安装，跳过会话恢复联动（不内置）'
        : `会话恢复联动完成: ${r.detail || JSON.stringify(r)}`
    }))
  }

  // 启动流程：崩溃检测 → 心跳 → 定时器
  await fs.mkdir(STATE_ROOT, { recursive: true }).catch(() => {})
  await detectCrashOnStartup()
  await writeHeartbeat()
  try {
    if (await isRepo(DSH_ROOT)) {
      const existing = await fs.readFile(join(DSH_ROOT, '.gitignore'), 'utf8').catch(() => '')
      const merged = existing ? [...new Set([...existing.split('\n').filter(Boolean), ...DSH_GITIGNORE])].join('\n') + '\n' : DSH_GITIGNORE.join('\n') + '\n'
      await fs.writeFile(join(DSH_ROOT, '.gitignore'), merged)
    }
  } catch { /* 非仓库/不可写则跳过 */ }
  // 合并旧版功能（2026-08-20）：插件树健康体检——崩溃后启动自检，
  // 发现"声明 client 但无产物"的带病插件自动修复（00:22 崩溃类型），再启动定时器
  try {
    const { pluginTreeHealthCheck } = await import('./plugin-health.js')
    const ph = await pluginTreeHealthCheck(DSH_ROOT)
    if (ph.findings.length) {
      console.log(`[git-rescue] 插件树体检发现 ${ph.findings.length} 项问题:`, ph.findings.map((f) => f.detail).join('; '))
    }
    if (ph.fixes.length) {
      console.log(`[git-rescue] 插件树体检已修复 ${ph.fixes.length} 项（合并自旧版拦截方案）`)
    }
  } catch { /* 体检失败不影响启动 */ }
  startTimers()

  const bootDevice = await getDeviceId(STATE_ROOT).catch(() => ({ id: 'unknown', source: 'unknown' }))
  await appendEvent('startup', { pid: process.pid, device: { id: bootDevice.id, source: bootDevice.source } })

  // 自动更新：启动后 30s 首次检查（从 2.0.0 起具备，不阻塞启动）
  if (AUTO_UPDATE_ENABLED) {
    setTimeout(() => { runAutoUpdateCheck().catch(() => {}) }, 30_000).unref?.()
  }

  const gv = await gitVersion()
  const backup = await defaultBackupRepo(STATE_ROOT)
  console.log(`[git-rescue] 已启动 v2.5.0: git=${gv || '不可用'}, dshRoot=${DSH_ROOT}, 备份仓=${backup.repo}, autoUpdate=${AUTO_UPDATE_ENABLED ? 'ON(强制)' : 'OFF(env)'}`)
}
