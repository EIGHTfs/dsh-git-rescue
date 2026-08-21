/**
 * dsh-git-rescue — 插件主入口（组件 C）
 *
 * 功能（v1 = git 版本管理）：
 * - git 环境检测（git 是否可用、git-remote-https 是否缺失）
 * - 双仓库管理：~/.dsh（配置+会话+skills，默认）+ workspace（白名单，可选）
 * - 心跳写入（heartbeat 文件，供 guardian 探活）
 * - 启动时崩溃检测（心跳过期 → 记录崩溃事件 + 自动 commit 现场）
 * - 自动 commit（启动/定时/事件/手动）
 * - GitHub token 配置 + 远端快照推送（REST API 降级）
 * - API：/api/git-rescue/*（status/init/commit/log/config/push/rollback/heartbeat）
 * - Agent 工具：git_rescue_status/init/backup/log/push/rollback
 */

import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import {
  gitVersion, httpsHelperMissing, initRepo, commit, log, status,
  headRef, markBad, hardReset, lastGoodCommit, ensureGitignore, isRepo,
} from './git.js'
import { verifyToken, pushSnapshot } from './github.js'
import { getDeviceId, defaultBackupRepo } from './device.js'
import { computeScoresFromEvents, refreshScoreSnapshot, scoreFileName } from './scores.js'
import { AUTO_UPDATE_ENABLED, UPDATE_INTERVAL_MS, checkForUpdate, applyUpdate } from './self-update.js'
import { linkSessionRecovery } from './session-link.js'
import { detectSandbox } from './sandbox.js'

export const name = 'dsh-git-rescue'
export const inject = ['webServer']

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
// DSH_HOME 存在时优先（测试实例隔离、多 profile 场景均依赖它）
const DSH_ROOT = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_ROOT = join(DSH_ROOT, 'git-rescue')
const CONFIG_PATH = join(STATE_ROOT, 'config.json')
// 凭据统一存放（2026-08-19 用户约定：data/sensitive/，见 credentials-locator skill）：
// 优先读 data/sensitive，缺则回退旧路径 $DSH_HOME/git-rescue/（兼容未迁移/插件写入场景）
const WORKSPACE = process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace'
const SENSITIVE_DIR = join(WORKSPACE, 'data', 'sensitive')
const TOKEN_PATH_LEGACY = join(STATE_ROOT, 'token')
const SUDO_KEY_PATH_LEGACY = join(STATE_ROOT, 'sudo-key') // v1.8.0：可选 sudo 密码（600 权限，单独文件，绝不明文显示）
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

/** .dsh 仓库的 .gitignore（配置+skills 入库；sessions/storages 走基线+增量策略，敏感/大文件/缓存排除）。 */
const DSH_GITIGNORE = [
  'node_modules/',
  'profiles/*/node_modules/',
  '.credentials.yaml',
  '.env',
  // v1.6.0 ⑥：sessions/storages 排除出常规增量 commit（zstd 二进制变化大），
  // 由定期基线策略（sessionsBaselineMs，默认 24h）强制全量入库
  'sessions/',
  'storages/',
  'snapshot-archive/',
  'git-rescue/',
  '*.log',
  '*.pid',
]

const DEFAULT_CONFIG = {
  githubOwner: '',
  githubRepo: '',
  autoCommitMs: 30 * 60 * 1000,
  heartbeatMs: 30 * 1000,
  sessionsBaselineMs: 24 * 60 * 60 * 1000, // v1.6.0 ⑥：sessions 全量基线周期（默认每天一次）
  workspaceEnabled: false,
  workspaceDir: '',
  workspaceWhitelist: [],
}

// ---------- 状态 ----------
let cfg = { ...DEFAULT_CONFIG }
let heartbeatTimer = null
let autoCommitTimer = null
let autoUpdateTimer = null
let sessionsBaselineTimer = null
let lastCrashDetectedAt = null
let autoUpdateState = { enabled: AUTO_UPDATE_ENABLED, lastCheckAt: null, lastResult: null, pendingRestart: false }
let sessionLinkState = { available: null, lastAction: null, lastResult: null, lastAt: null }

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
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

async function readToken() {
  // data/sensitive/github-token（新约定）优先，旧路径 git-rescue/token 回退
  try {
    const t = (await fs.readFile(join(SENSITIVE_DIR, 'github-token'), 'utf8')).trim()
    if (t) return t
  } catch { /* 回退旧路径 */ }
  try { return (await fs.readFile(TOKEN_PATH_LEGACY, 'utf8')).trim() } catch { return '' }
}

async function writeToken(token) {
  await fs.mkdir(STATE_ROOT, { recursive: true })
  await fs.writeFile(TOKEN_PATH_LEGACY, String(token).trim(), { mode: 0o600 })
}

// ---------- sudo-key（v1.8.0：可选，用于系统故障自动修复/开机自启） ----------
// 安全：单独文件 600 权限；API 回显只报"是否已设置"，绝不显示密码本身（明文/脱敏都不显示）

async function readSudoKey() {
  // data/sensitive/sudo-key（新约定）优先，旧路径 git-rescue/sudo-key 回退
  try {
    const k = (await fs.readFile(join(SENSITIVE_DIR, 'sudo-key'), 'utf8')).trim()
    if (k) return k
  } catch { /* 回退旧路径 */ }
  try { return (await fs.readFile(SUDO_KEY_PATH_LEGACY, 'utf8')).trim() } catch { return '' }
}

async function writeSudoKey(key) {
  await fs.mkdir(STATE_ROOT, { recursive: true })
  await fs.writeFile(SUDO_KEY_PATH_LEGACY, String(key).trim(), { mode: 0o600 })
}

async function clearSudoKey() {
  await fs.rm(SUDO_KEY_PATH_LEGACY, { force: true }).catch(() => {})
}

function maskToken(t) { return t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '' }

// ---------- 仓库管理 ----------

function wsRepoDir() {
  return cfg.workspaceEnabled && cfg.workspaceDir ? cfg.workspaceDir : null
}

async function ensureWorkspaceGitignore(dir) {
  // 白名单模式：根层全忽略，仅放行白名单条目
  const entries = cfg.workspaceWhitelist || []
  const rules = ['*', '!.gitignore']
  for (const e of entries) {
    const clean = e.replace(/^\/+|\/+$/g, '')
    if (!clean) continue
    rules.push(`!${clean}/`, `!${clean}/**`)
  }
  const p = join(dir, '.gitignore')
  await fs.writeFile(p, rules.join('\n') + '\n')
}

/** 初始化两个仓库（git init + .gitignore + 基线 commit）。 */
async function initRepos() {
  const results = {}
  // 1) .dsh 仓库
  await initRepo(DSH_ROOT)
  await ensureGitignore(DSH_ROOT, DSH_GITIGNORE)
  const dshCommit = await commit(DSH_ROOT, 'chore(guard): init | baseline snapshot of .dsh', ['--allow-empty'])
  results.dsh = { ok: true, initialized: !dshCommit.empty || (await headRef(DSH_ROOT)) !== null, head: await headRef(DSH_ROOT) }

  // 2) workspace 仓库（可选）
  const ws = wsRepoDir()
  if (ws) {
    await fs.mkdir(ws, { recursive: true })
    await initRepo(ws)
    await ensureWorkspaceGitignore(ws)
    const wsCommit = await commit(ws, 'chore(guard): init | baseline snapshot of workspace', ['--allow-empty'])
    results.workspace = { ok: true, head: await headRef(ws) }
  }
  return results
}

/** 提交两个仓库（reason 用于 commit message）。 */
async function commitAll(reason) {
  const out = { dsh: { ok: true, empty: true }, workspace: null }
  out.dsh = await commit(DSH_ROOT, `chore(guard): ${reason} | auto snapshot`)
  const ws = wsRepoDir()
  if (ws) out.workspace = await commit(ws, `chore(guard): ${reason} | workspace snapshot`)
  return out
}

/**
 * v1.6.0 ⑥：sessions 全量基线入库。
 * sessions/storages 平时被 .gitignore 排除（zstd 二进制变化大，避免增量膨胀），
 * 此函数用 git add -f 强制入库 → 基线 commit → git rm -r --cached 恢复忽略
 * （文件保留在磁盘，只是回到"未跟踪"状态，后续增量 commit 不再包含）。
 */
async function commitSessionsBaseline() {
  try {
    const sessionsDir = join(DSH_ROOT, 'sessions')
    const storagesDir = join(DSH_ROOT, 'storages')
    const { runGit } = await import('./git.js')
    const dirs = []
    if (await pathExists(sessionsDir)) dirs.push(sessionsDir)
    if (await pathExists(storagesDir)) dirs.push(storagesDir)
    if (dirs.length === 0) return { ok: true, empty: true }

    for (const d of dirs) {
      const r = await runGit(['add', '-f', d], { cwd: DSH_ROOT })
      if (!r.ok) return { ok: false, error: `add -f ${d} 失败: ${r.stderr}` }
    }
    const cm = await runGit(['commit', '-m', 'chore(guard): sessions baseline | 定期全量基线（sessions/storages）'], { cwd: DSH_ROOT })
    if (!cm.ok) {
      // 可能无变更（与上次基线相同）
      await runGit(['reset'], { cwd: DSH_ROOT }).catch(() => {})
      return { ok: true, empty: true }
    }
    // 恢复忽略：从索引移除（文件保留），后续增量 commit 不再含 sessions/storages
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
  const ws = wsRepoDir()
  const device = await getDeviceId(STATE_ROOT)
  return {
    ok: true,
    plugin: 'dsh-git-rescue',
    git: { version: await gitVersion(), httpsHelperMissing: await httpsHelperMissing() },
    hostname: hostname(),
    device: { id: device.id, source: device.source, defaultBackupRepo: await defaultBackupRepo(STATE_ROOT) },
    scores: await computeScoresFromEvents(STATE_ROOT, device.id, device.source),
    repos: {
      dsh: { root: DSH_ROOT, repo: await isRepo(DSH_ROOT), head: dshHead, changed: dshStatus.changed },
      workspace: ws ? { root: ws, repo: await isRepo(ws), head: await headRef(ws), changed: (await status(ws)).changed } : null,
    },
    heartbeat: heartbeat ? { ageMs: Date.now() - heartbeat.ts, ok: Date.now() - heartbeat.ts < (cfg.heartbeatMs * 3 || 90000) } : null,
    config: { ...cfg },
    lastCrashDetectedAt,
    autoUpdate: { ...autoUpdateState },
    sessionLink: { ...sessionLinkState },
    // v1.10.0：沙盒/容器环境能力检测（NoNewPrivs/CapEff/sudo 可行性/只读挂载）
    sandbox: await detectSandbox(),
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
  await fs.writeFile(HEARTBEAT_PATH, JSON.stringify(hb), { mode: 0o600 })
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
    // 会话恢复联动（用户约定：装了 session-manager 才调用，没装不调用，不内置）
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

// ---------- 回退 ----------

/** 回退某个仓库到指定 ref：先 commit 现场 + 打 bad 标记，再 reset --hard。 */
async function rollbackRepo(dir, ref, which, scoreType = 'crash') {
  // 1) 先 commit 坏现场（生成的提交 = 坏提交，事后可分析）
  await commit(dir, `chore(guard): pre-rollback backup | ${which} @ ${await headRef(dir) ?? 'no-head'}`)
  // 2) 给【坏提交】（刚生成的 HEAD）打 bad 标记，而不是给目标 ref 打
  const brokenHead = await headRef(dir)
  if (brokenHead) await markBad(dir, brokenHead)
  // 3) 回退
  const r = await hardReset(dir, ref)
  if (!r.ok) return r
  // 4) 救援积分（防刷分：不写可篡改计分文件，靠本事件留档，启动时从事件流实时计算）
  await appendEvent('rollback', { repo: which, from: brokenHead, to: ref, scoreType })
  return { ok: true, from: brokenHead, to: ref }
}

/** 自动回退到最后一个好提交（guardian 调用，或手动 API 触发）。 */
async function autoRollback(which = 'dsh', scoreType = 'crash') {
  const dir = which === 'workspace' ? wsRepoDir() : DSH_ROOT
  if (!dir) return { ok: false, error: 'workspace 未启用' }
  const good = await lastGoodCommit(dir)
  if (!good) return { ok: false, error: '没有可回退的好提交（仓库无提交或全部被标记 bad）' }
  const res = await rollbackRepo(dir, good, which, scoreType)
  return { ...res, target: good }
}

// ---------- 自动更新 ----------

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
        // 更新的是插件文件；当前进程仍是旧代码，需 DSH 重启生效（仅记录，不自动重启）
        console.log(`[git-rescue] 已自动更新 ${applied.from} → ${applied.to}，重启 DSH 后生效`)
      } else {
        await appendEvent('auto-update-failed', { error: applied.error, from: check.installedVersion, to: check.remoteVersion })
        console.log(`[git-rescue] 自动更新失败: ${applied.error}`)
      }
    } else if (check.ok) {
      // 已是最新，无事发生
      if (autoUpdateState.pendingRestart) autoUpdateState.pendingRestart = false
    }
  } catch (e) {
    autoUpdateState.lastResult = { ok: false, error: String(e?.message ?? e) }
    await appendEvent('auto-update-error', { error: String(e?.message ?? e) })
  }
}

// ---------- 接管式重启（dsh-restart-takeover 方案） ----------

/**
 * 解析 DSH 拉起命令（接管脚本 60s 未恢复时主动拉起用）。
 * 优先级：
 *  1. 环境变量 DSH_START_CMD（显式指定，最高优先，外部覆盖）
 *  2. 测试实例启动脚本 dsh-test-instance.sh（存在时——手动启动实例 kill 后必须靠它拉起）
 *  3. 兜底：runner.js 拉起（主实例场景；一般轮不到，s6 会先自动重拉）
 * @param {number} port DSH 端口
 */
function resolveStartCmd(port) {
  const wsDir = '/vol1/@appshare/DeepSeekHarness/workspace'
  const testScript = join(wsDir, 'dsh-test-instance.sh')
  try {
    if (existsSync(testScript)) {
      return `bash ${testScript}`
    }
  } catch { /* 探测失败走兜底 */ }
  // 兜底：主实例 runner（s6 通常已自动拉起，这里只是最后手段）
  return `${process.execPath} /vol1/@appcenter/deepseek-harness/bin/runner.js`
}

/**
 * 接管式重启 DSH：生成独立脚本 → setsid 脱离进程组 → 脚本负责
 *  TERM runner → 轮询端口恢复 → 验证插件 API → 结果写日志文件。
 *
 * 为什么必须独立进程：DSH 重启会中断所有会话（含当前回合），任何同步
 * 的"kill → 等恢复 → 验证"都会在 kill 瞬间断掉。脚本脱离后自持完整流程，
 * 会话恢复后再读日志文件确认结果。
 *
 * @returns {{ok:boolean, logFile:string, message:string}}
 */
async function takeoverRestart() {
  const logFile = join(STATE_ROOT, 'restart-latest.log')
  const scriptFile = join(STATE_ROOT, 'restart-takeover.sh')
  const port = process.env.DSH_PORT || 3081
  const host = process.env.DSH_HOST || '127.0.0.1'

  // 拉起命令来源（优先级）：环境变量 DSH_START_CMD > 自动推导（测试实例脚本 / 兜底命令）
  // 为什么需要主动拉起：主实例由 fnOS s6 管理（TERM 后自动重拉 15~26s）；
  // 但手动启动的实例（如 dsh-test-instance.sh 起的测试实例）kill 后没人拉起——
  // 轮询 60s 未恢复就必须自己执行启动命令，否则永远等不到。
  const autoCmd = resolveStartCmd(port)
  const startCmd = process.env.DSH_START_CMD || autoCmd || ''

  // 独立脚本内容（含完整重启+验证流程，脱离 DSH 后自持）
  const script = `#!/bin/bash
# dsh-git-rescue 接管式重启（自动生成，dsh-restart-takeover 方案）
LOG="${logFile}"
: > "$LOG"
echo "[$(date +%T)] 接管式重启开始 (port=${port})" >> "$LOG"

# 1) 先落一条"重启中"事件（插件自身可能马上断，靠文件留痕）
echo "[$(date +%T)] 触发重启: TERM runner（主实例 s6 自动重拉）" >> "$LOG"

# 2) 找 runner 并 TERM（主实例 runner.js；若找不到则回退到找 dsh web 进程）
RPID=$(ps -eo pid,args | grep "bin/runner.js" | grep -v grep | awk '{print $1}' | head -1)
if [ -z "$RPID" ]; then
  RPID=$(ps -eo pid,args | grep "bin.js web" | grep -v grep | grep -- "--port ${port}" | awk '{print $1}' | head -1)
  echo "[$(date +%T)] 未找到 runner，回退 TERM dsh web PID=$RPID" >> "$LOG"
fi
echo "[$(date +%T)] 目标 PID=$RPID" >> "$LOG"
if [ -n "$RPID" ]; then
  # 只发 TERM，绝不 kill -9：s6-supervise 对 SIGKILL 会进入退避等待，
  # 实测重拉延迟从 15~26s 暴涨到 ~4 分钟（TERM 是受控停止，s6 立即重拉）
  kill "$RPID" 2>/dev/null
else
  echo "[$(date +%T)] ❌ 未找到任何 DSH 进程（可能已停机？）" >> "$LOG"
fi

# 2.5 轮询前先给 s6 一点响应时间（TERM 后 runner 优雅退出 dsh → s6 立即重拉）
sleep 3

# 3) 第一段轮询：等 s6/守护自动重拉（最多 60s = 12 轮）
UP=0
for i in $(seq 1 12); do
  sleep 5
  if curl -s -o /dev/null -w "%{http_code}" "http://${host}:${port}/" -m 3 2>/dev/null | grep -q 200; then
    UP=1; echo "[$(date +%T)] 服务自动恢复 (第 $i 轮)" >> "$LOG"; break
  fi
  echo "[$(date +%T)] 等待自动恢复... ($i/12)" >> "$LOG"
done

# 3.5 60s 未恢复 → 主动拉起（手动启动的实例 kill 后没人自动拉，必须自己拉）
if [ "$UP" != "1" ]; then
  if [ -n "${startCmd}" ]; then
    echo "[$(date +%T)] ⏳ 60s 未自动恢复，执行拉起命令: ${startCmd}" >> "$LOG"
    (cd /vol1/@appshare/DeepSeekHarness/workspace 2>/dev/null || cd /; setsid nohup bash -c "${startCmd}" >> "$LOG" 2>&1 < /dev/null &)
    echo "[$(date +%T)] 拉起命令已执行，继续轮询..." >> "$LOG"
  else
    echo "[$(date +%T)] ⚠️ 60s 未自动恢复，且无可用拉起命令（DSH_START_CMD 未设置）" >> "$LOG"
  fi
fi

# 4) 第二段轮询：拉起后继续等（最多 240s = 48 轮）
if [ "$UP" != "1" ]; then
  for i in $(seq 1 48); do
    sleep 5
    if curl -s -o /dev/null -w "%{http_code}" "http://${host}:${port}/" -m 3 2>/dev/null | grep -q 200; then
      UP=1; echo "[$(date +%T)] 服务恢复 (第 $i 轮/第二段)" >> "$LOG"; break
    fi
    echo "[$(date +%T)] 等待恢复... ($i/48)" >> "$LOG"
  done
fi

# 5) 恢复后等插件加载，验证 git-rescue API
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

  // setsid 脱离进程组启动；脚本完全独立于本进程
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
      const changed = (r.dsh && !r.dsh.empty) || (r.workspace && !r.workspace.empty)
      if (changed) appendEvent('auto-commit', { reason: 'periodic' })
    }).catch(() => {})
  }, cfg.autoCommitMs)
  autoCommitTimer.unref?.()
  // 自动更新：强制开启（隐藏开关，环境变量 DSH_GIT_RESCUE_AUTO_UPDATE=0 可关）
  if (AUTO_UPDATE_ENABLED) {
    autoUpdateTimer = setInterval(() => { runAutoUpdateCheck().catch(() => {}) }, UPDATE_INTERVAL_MS)
    autoUpdateTimer.unref?.()
  }
  // v1.6.0 ⑥：sessions 全量基线（默认每天一次；启动 5 分钟后首跑，方便首次部署立即建基线）
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
    return send(res, 200, { ok: true, dsh: r.dsh, workspace: r.workspace })
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
    for (const k of ['githubOwner', 'githubRepo', 'autoCommitMs', 'heartbeatMs', 'workspaceEnabled', 'workspaceDir', 'workspaceWhitelist']) {
      if (body[k] !== undefined) cfg[k] = body[k]
    }
    if (body.githubToken) {
      await writeToken(body.githubToken)
      await appendEvent('config-update', { githubToken: true })
    }
    // sudo-key（v1.8.0）：可设置或清除（传 sudoKey='' 或 'clear' 清除）；不写入 config.json，单独 600 文件
    if (body.sudoKey !== undefined) {
      if (body.sudoKey === '' || body.sudoKey === 'clear') {
        await clearSudoKey()
        await appendEvent('config-update', { sudoKey: false })
      } else {
        await writeSudoKey(body.sudoKey)
        await appendEvent('config-update', { sudoKey: true })
      }
    }
    await saveConfig()
    startTimers()
    return send(res, 200, { ok: true })
  }

  if (method === 'POST' && path === '/api/git-rescue/push') {
    const token = await readToken()
    if (!token) return send(res, 400, { ok: false, error: '未配置 GitHub token（POST /config 填写 githubToken）' })
    const repo = cfg.githubRepo || (await defaultBackupRepo(STATE_ROOT))
    const r = await pushSnapshot(token, cfg.githubOwner || '', repo, DSH_ROOT, `dsh-git-rescue backup @ ${ts()}`)
    if (!r.ok) return send(res, 500, { ok: false, error: r.error })
    await appendEvent('push', { repo: r.repo, commit: r.commit, files: r.files })
    return send(res, 200, { ok: true, ...r })
  }

  if (method === 'POST' && path === '/api/git-rescue/rollback') {
    const body = await readJson(req)
    const r = await autoRollback(body?.repo || 'dsh', 'manual')
    return r.ok ? send(res, 200, r) : send(res, 400, r)
  }

  if (method === 'POST' && path === '/api/git-rescue/heartbeat') {
    return send(res, 200, { ok: true, heartbeat: await writeHeartbeat() })
  }

  // 接管式重启：独立脚本接管 TERM → 轮询恢复 → 验证，规避会话中断
  if (method === 'POST' && path === '/api/git-rescue/restart') {
    const r = await takeoverRestart()
    return send(res, 200, r)
  }

  // 查看最近一次接管式重启的结果日志
  if (method === 'GET' && path === '/api/git-rescue/restart-log') {
    try {
      const raw = await fs.readFile(join(STATE_ROOT, 'restart-latest.log'), 'utf8')
      return send(res, 200, { ok: true, log: raw })
    } catch {
      return send(res, 200, { ok: true, log: '（暂无接管式重启日志）' })
    }
  }

  // 手动触发会话恢复联动（探测 session-manager → 有则 scan 续跑，无则跳过）
  if (method === 'POST' && path === '/api/git-rescue/link-session-recovery') {
    const r = await linkSessionRecovery({ reason: 'manual' })
    sessionLinkState.available = !r.skipped
    sessionLinkState.lastAction = 'scan'
    sessionLinkState.lastResult = r
    sessionLinkState.lastAt = ts()
    await appendEvent('session-recovery-link', { available: !r.skipped, manual: true, result: r })
    return send(res, r.ok ? 200 : 500, { ok: r.ok, linked: r.linked, skipped: r.skipped, detail: r.detail, available: !r.skipped })
  }

  // 手动触发自动更新检查（不应用，只检查）；带 ?apply=1 则直接应用
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
    // tools.register 要求 parameters 是 lossless JSON（schema 投影时 snapshotJsonValue 校验，
    // 缺省会抛 "parameters must be lossless JSON before schema projection"）
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

  // webServer 注册走 ctx.inject（apply 运行时刻 webServer fiber 可能尚未创建）
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
    tools.register(defineToolSimple('git_rescue_status', '查看 git-rescue 状态（git 可用性/仓库/心跳/自动更新/配置摘要）', async () => {
      const s = await collectStatus()
      const g = s.git
      const au = s.autoUpdate
      const auLine = au.enabled
        ? (au.pendingRestart ? `自动更新: ON, 已更新待重启（${au.lastResult?.detail || ''}）` : `自动更新: ON${au.lastCheckAt ? `, 最近检查 ${au.lastResult?.detail || au.lastResult?.error || ''}` : ''}`)
        : '自动更新: OFF (env DSH_GIT_RESCUE_AUTO_UPDATE=0)'
      const sl = s.sessionLink
      const slLine = sl.available === null
        ? '会话恢复联动: 未探测'
        : (sl.available ? `会话恢复联动: session-manager 已安装${sl.lastResult ? `, 最近 ${sl.lastResult.detail || ''}` : ''}` : '会话恢复联动: session-manager 未安装（跳过）')
      return `git: ${g.version || '不可用'}${g.httpsHelperMissing ? ' (https 助手缺失→推送走 REST API)' : ''}\n` +
        `.dsh 仓库: ${s.repos.dsh.repo ? '已初始化' : '未初始化'}${s.repos.dsh.head ? ` @ ${s.repos.dsh.head}` : ''}${s.repos.dsh.changed ? `, ${s.repos.dsh.changed} 项未提交` : ''}\n` +
        (s.repos.workspace ? `workspace 仓库: ${s.repos.workspace.repo ? '已初始化' : '未初始化'}${s.repos.workspace.head ? ` @ ${s.repos.workspace.head}` : ''}\n` : '') +
        `心跳: ${s.heartbeat ? (s.heartbeat.ok ? '正常' : '过期') : '无'}\n` +
        auLine + '\n' +
        slLine
    }))
    tools.register(defineToolSimple('git_rescue_init', '初始化 git-rescue 仓库（git init + .gitignore + 基线 commit）', async () => {
      const r = await initRepos()
      await commitAll('init')
      return `已初始化 .dsh 仓库${r.workspace ? ' + workspace 仓库' : ''}`
    }))
    tools.register(defineToolSimple('git_rescue_backup', '立即 commit 当前状态（自动备份点）', async (args) => {
      const r = await commitAll(args?.reason || 'tool')
      return r.dsh.empty ? '无变更，跳过 commit' : `已提交 .dsh (${r.dsh.hash})`
    }, { type: 'object', properties: { reason: { type: 'string', description: '提交原因，将写入 commit message' } } }))
    tools.register(defineToolSimple('git_rescue_log', '查看最近提交记录', async (args) => {
      const lines = await log(DSH_ROOT, Number(args?.n || 10))
      return lines.length ? lines.join('\n') : '暂无提交'
    }, { type: 'object', properties: { n: { type: 'integer', description: '查看最近 N 条提交记录，默认 10' } } }))
    tools.register(defineToolSimple('git_rescue_rollback', '回退到最后一个好提交（当前坏状态先备份+标记 bad）', async () => {
      const r = await autoRollback('dsh', 'manual')
      return r.ok ? `已回退 ${r.from || '?'} → ${r.to}` : `回退失败: ${r.error}`
    }))
    tools.register(defineToolSimple('git_rescue_push', '推送当前快照到 GitHub 备份仓库（token 方案）', async () => {
      const token = await readToken()
      if (!token) return '未配置 GitHub token'
      const repo = cfg.githubRepo || (await defaultBackupRepo(STATE_ROOT))
      const r = await pushSnapshot(token, cfg.githubOwner || '', repo, DSH_ROOT, `dsh-git-rescue backup @ ${ts()}`)
      return r.ok ? `已推送 ${r.files} 个文件 → ${r.url} (${r.commit.slice(0, 8)})` : `推送失败: ${r.error}`
    }))
    tools.register(defineToolSimple('git_rescue_restart', '接管式重启 DSH（独立脚本 TERM→轮询恢复→验证；当前会话会中断，结果写入 restart-latest.log 供后续查看）', async () => {
      const r = await takeoverRestart()
      return r.message
    }))
    tools.register(defineToolSimple('git_rescue_link_recovery', '触发会话恢复联动：探测 dsh-session-manager 是否安装，已安装则调用其 scan 自动续跑被中断的会话（未安装则跳过，不内置会话恢复）', async () => {
      const r = await linkSessionRecovery({ reason: 'tool' })
      sessionLinkState.available = !r.skipped
      sessionLinkState.lastAction = 'scan'
      sessionLinkState.lastResult = r
      sessionLinkState.lastAt = ts()
      await appendEvent('session-recovery-link', { available: !r.skipped, tool: true, result: r })
      return r.detail || (r.skipped ? 'session-manager 未安装，跳过会话恢复联动' : '会话恢复联动已触发')
    }))
  }

  // 启动流程：崩溃检测 → 心跳 → 定时器
  await fs.mkdir(STATE_ROOT, { recursive: true }).catch(() => {})
  await detectCrashOnStartup()
  await writeHeartbeat()
  // v1.6.0 ⑥：刷新 .gitignore 规则（已存在的仓库也获得新规则——sessions/storages 移出常规增量）
  try {
    if (await isRepo(DSH_ROOT)) {
      const existing = await fs.readFile(join(DSH_ROOT, '.gitignore'), 'utf8').catch(() => '')
      const merged = existing ? [...new Set([...existing.split('\n').filter(Boolean), ...DSH_GITIGNORE])].join('\n') + '\n' : DSH_GITIGNORE.join('\n') + '\n'
      await fs.writeFile(join(DSH_ROOT, '.gitignore'), merged)
    }
  } catch { /* 非仓库/不可写则跳过 */ }
  startTimers()
  // 2026-08-20 增强（用户要求）：每次启动记录设备指纹，中途换设备可从 events 对比发现
  const bootDevice = await getDeviceId(STATE_ROOT).catch(() => ({ id: 'unknown', source: 'unknown' }))
  await appendEvent('startup', { pid: process.pid, device: { id: bootDevice.id, source: bootDevice.source } })

  // 插件树健康体检（2026-08-20 整合）：启动自检，发现「声明 client 但产物缺失」自动修复
  // ——即使带病插件被装上，也在本次启动就修掉，防下一次 Failed to load plugins 崩溃
  try {
    const { pluginTreeHealthCheck } = await import('./plugin-health.js')
    const ph = await pluginTreeHealthCheck(DSH_ROOT)
    if (ph.findings.length) {
      console.log(`[git-rescue] 🩺 插件树体检发现 ${ph.findings.length} 个问题:`)
      for (const f of ph.findings) console.log(`[git-rescue]   [${f.plugin}] ${f.type}: ${f.detail}`)
    }
    for (const x of ph.fixes) console.log(`[git-rescue] 🩺 自动修复: ${x.action} — ${x.detail}`)
    if (!ph.findings.length && !ph.fixes.length) console.log('[git-rescue] 🩺 插件树体检通过')
  } catch { /* 体检失败不影响启动 */ }

  // 救援积分：DSH 启动后从事件流实时计算并缓存快照（防刷分——权威是事件流，不是可写文件）
  try {
    const device = await getDeviceId(STATE_ROOT)
    await refreshScoreSnapshot(STATE_ROOT, device.id, device.source)
  } catch { /* 积分计算失败不影响启动 */ }

  // 自动更新：启动后 30s 首次检查（不阻塞启动；失败不影响主流程）
  if (AUTO_UPDATE_ENABLED) {
    setTimeout(() => { runAutoUpdateCheck().catch(() => {}) }, 30_000).unref?.()
  }

  const gv = await gitVersion()
  console.log(`[git-rescue] 已启动: git=${gv || '不可用'}, dshRoot=${DSH_ROOT}, workspace=${wsRepoDir() || '未启用'}, autoUpdate=${AUTO_UPDATE_ENABLED ? 'ON(强制)' : 'OFF(env)'}`)

  // 首次启动提示（v1.8.0）：sudo-key 完全可选，不填也完整可用；避免用户对 root 密码敏感
  const sk = await readSudoKey().catch(() => '')
  if (!sk) {
    console.log(`[git-rescue] 🔓 sudo-key 未配置（完全可选，不强求）：核心功能无需 root；如需系统只读故障自动修复，可在插件配置填写 sudo-key（绝不明文存储）。敏感用户可忽略此提示。`)
  }
}
