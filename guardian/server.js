/**
 * dsh-git-rescue 2.5.0 guardian — 独立守护进程（③⑤⑥⑦）
 *
 * 独立于 DSH 运行（DSH 崩了它照样活着）。功能：
 * 1. 定时健康检查 DSH（GET http://<host>:<port>）
 * 2. 连续失败 N 次 → 自动救援：
 *    a. 专项恢复工具诊断修复（⑤，简单修复优先）
 *    b. git commit 当前坏状态（保留现场）
 *    c. 给当前 HEAD 打 bad 标记（防止回退后再次回到同一坏点）
 *    d. git reset --hard 到最后一个「好」提交（⑥）
 *    e. 重启 DSH + 健康检查
 * 3. 无法恢复时唤起纯净环境（⑦），纯净 dsh 加载救援插件 skills 协助
 * 4. 救援前插件自更新（从 2.0.0 起具备自动更新）
 * 5. 开机自启注册（③，启动命令在 .dsh 目录这一层）
 * 6. 网页 http://<listen>:<webPort> 可查看状态 / 手动回退 / 手动启动
 *
 * 回退源：~/.dsh git 仓库（dsh-git-rescue 插件维护），不依赖 zip 快照。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'
import { runGit, commit, headRef, markBad, lastGoodCommit, hardReset, restoreProfileOnly } from '../lib/git.js'
// 2026-08-21 对齐官方权限设计：原子写 + 敏感文件权限守卫
import { writeFileAtomic, readFileSecure } from '../lib/atomic.js'
import { createFlappingDetector } from '../lib/flapping.js'
import { probeDshHealth } from '../lib/probe.js'
import { startDshWithLog, captureExitContext, readLogTail } from '../lib/process-capture.js'
import { classifyFault, probeSystemHints, computeMaxOldSpace, readMemSummary } from '../lib/fault-classify.js'
import { isRescueEnv, startRescueEnv, rescueEnvStatus, rescueEnvName } from '../lib/rescue-env.js'
import { isTestHomePath } from '../lib/test-home.js'
import { runRepairTools } from '../lib/repair-tools.js'
import { bootAutostartStatus, installBootAutostart, startScriptPath } from '../lib/boot-startup.js'
import { AUTO_UPDATE_ENABLED, checkForUpdate, applyUpdate } from '../lib/self-update.js'
// 救机闭环（需求2/3/4/5/6，2026-08-20）：诊断报告/救机清单/经验固化/zip 还原点
import {
  writeDiagnosticReport, writeRescueTaskList, appendRescueExperience,
  packageChangedFiles, collectChangedFiles,
} from '../lib/rescue-report.js'
// guardian 直连 LLM 自治诊断（2026-08-20 EIGHTfs 需求：不一定要纯净环境）
import { llmDiagnoseRescue, validateLlmAction } from '../lib/llm.js'

// ============ 配置（可用环境变量覆盖） ============
const CFG = {
  dshHost: process.env.DSH_HOST || '127.0.0.1',
  dshPort: Number(process.env.DSH_PORT || 3081),
  webPort: Number(process.env.GUARDIAN_PORT || 3082),
  checkIntervalMs: Number(process.env.GUARDIAN_INTERVAL_MS || 10_000),
  failThreshold: Number(process.env.GUARDIAN_FAIL_THRESHOLD || 3),
  startWaitMs: Number(process.env.GUARDIAN_START_WAIT_MS || 15_000),
  dshStartCmd: process.env.DSH_START_CMD || '',
  autoRecover: process.env.GUARDIAN_AUTO_RECOVER !== '0',
  dshHome: process.env.DSH_HOME || join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.dsh'),
  // flapping 检测：窗口内 ≥maxRestarts 次重启 → 升级处理（防"无限重启"无声）
  flappingWindowMs: Number(process.env.GUARDIAN_FLAPPING_WINDOW_MS || 10 * 60 * 1000),
  flappingMaxRestarts: Number(process.env.GUARDIAN_FLAPPING_MAX_RESTARTS || 3),
  // 业务就绪探活：根通但 API 未就绪（假活）也算失败
  probeApiPath: process.env.GUARDIAN_PROBE_API_PATH || '/api/git-rescue/status',
  probeToolsPath: process.env.GUARDIAN_PROBE_TOOLS_PATH || null,
  // 活跃对话判定：装了 session-manager 用 running||continueRunning，未装降级事件流
  sessionListPath: process.env.GUARDIAN_SESSION_LIST_PATH || '/api/session-manager/list',
  // 手动重启前记录变动的文件（时间窗，默认 10 分钟）
  preRestartChangeWindowMs: Number(process.env.GUARDIAN_PRERESTART_WINDOW_MS || 10 * 60 * 1000),
  // 救援前插件自更新（默认跟随 AUTO_UPDATE_ENABLED；GUARDIAN_SELF_UPDATE=0 可关）
  selfUpdate: process.env.GUARDIAN_SELF_UPDATE !== '0' && AUTO_UPDATE_ENABLED,
  // 3080 透明代理守护（官方 proxy.js：0.0.0.0:3080 -> 127.0.0.1:3081）
  proxyEnabled: process.env.GUARDIAN_PROXY_ENABLED !== '0',
  // 内置 LLM 诊断（默认关闭，2026-08-25 用户要求；设 GUARDIAN_LLM_ENABLED=1 开启）
  llmEnabled: process.env.GUARDIAN_LLM_ENABLED === '1',
  proxyListenHost: process.env.GUARDIAN_PROXY_HOST || '0.0.0.0',
  proxyListenPort: Number(process.env.GUARDIAN_PROXY_PORT || 3080),
  proxyTargetHost: process.env.GUARDIAN_PROXY_TARGET_HOST || '127.0.0.1',
  proxyTargetPort: Number(process.env.GUARDIAN_PROXY_TARGET_PORT || 3081),
  workspace: process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace',
}

// 是否救援环境（Save-clean / Save-test）：救援环境不自动 git 回退（开发者自行解决）
const IS_RESCUE_HOME = isRescueEnv(CFG.dshHome)

// 是否测试环境（v2.0.0 补回 v1.11.0 保护）：测试环境不自动救援——插件编写导致的崩溃由开发者自行解决
// 2026-08-21 教训：v2.0.0 重构时误删此判定，测试实例崩溃被 guardian 误当主环境触发 git 回退 → 全还原
const IS_TEST_HOME = isTestHomePath(CFG.dshHome)
// 任一环境命中（测试环境 / 救援环境）即禁止自动 git 回退救援，只保留现场
const IS_SAFE_NO_RESCUE_HOME = IS_TEST_HOME || IS_RESCUE_HOME

const LOG_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-dsh.log')
const EVENTS_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-events.jsonl')
const STDERR_FILE = join(CFG.dshHome, 'git-rescue', 'dsh-stderr.log')
const RESTART_REQUEST_FILE = join(CFG.dshHome, 'git-rescue', 'restart-request.json')
const DEVICE_LAST_FILE = join(CFG.dshHome, 'git-rescue', 'device-last.json')

// ============ 状态 ============
const state = {
  dsh: 'unknown',            // 'running' | 'stopped' | 'recovering'
  proxy: 'unknown',          // 'running' | 'stopped' | 'starting'
  proxyStartAt: null,
  lastOkAt: null,
  lastErrorAt: null,
  failCount: 0,
  lastRecoveryAt: null,
  lastRecoveryResult: null,
  log: [],                   // [{time, level, msg}]
  manualBusy: false,
  flappingCooldownUntil: null,
  manualStop: false,         // 手动停止标志：为 true 时 tick 不累计失败、不自动拉起（补回旧版 /api/stop 功能）
  gateInitialized: false,    // 自动续跑闸门是否已初始化（首次恢复健康时置 closed，2026-08-20）
  // 最近一次故障分类上下文（tick 里 classifyFault 后暂存，recover 里用于诊断报告/救机清单）
  lastFault: null,
  lastFaultReason: '',
}

// flapping 检测器：记录每次"检出失败→恢复"或"重启"事件，识别反复拉起即崩
const flapping = createFlappingDetector({
  windowMs: CFG.flappingWindowMs,
  maxRestarts: CFG.flappingMaxRestarts,
})

function log(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg }
  state.log.push(entry)
  if (state.log.length > 500) state.log = state.log.slice(-500)
  console.log(`[${entry.time.slice(11, 19)}][${level}] ${msg}`)
  fs.appendFile(EVENTS_FILE, JSON.stringify(entry) + '\n').catch(() => {})
}

// ============ DSH 健康检查 ============

/** 业务就绪探活：healthy（根+API 通）/ degraded（假活）/ down。 */
async function probeDsh() {
  const r = await probeDshHealth(fetch, CFG.dshHost, CFG.dshPort, {
    apiPath: CFG.probeApiPath,
    toolsPath: CFG.probeToolsPath,
  })
  if (r.level === 'healthy') return { ok: true, level: 'healthy' }
  return { ok: false, level: r.level, detail: r.detail }
}

// ============ DSH 进程管理 ============

function resolveDshStartCmd() {
  if (CFG.dshStartCmd) return CFG.dshStartCmd
  const nodeBin = process.execPath
  // 跨平台（2026-08-20）：Linux 是 .../bin/node，Windows 是 ...\node.exe
  const appDir = process.platform === 'win32'
    ? nodeBin.replace(/\\node(\.exe)?$/, '')
    : nodeBin.replace(/\/bin\/node$/, '')
  const dshBin = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return `${nodeBin} ${dshBin} web --host ${CFG.dshHost} --port ${CFG.dshPort}`
}

/**
 * 查找 DSH 进程 PID（跨平台，2026-08-20 Windows 适配）：
 *  - Linux/macOS：ps aux 按命令行匹配（bin.js + web + --port）
 *  - Windows：wmic/tasklist 按命令行匹配（win32 无 ps）
 */
async function findDshPid() {
  const { execFile } = await import('node:child_process')
  if (process.platform === 'win32') {
    try {
      // wmic 已弃用但 Win10/11 仍可用；优先 PowerShell Get-CimInstance 按 CommandLine 过滤。
      // 正则转义链（实测验证）：JS 模板写 \\.js → 求值 1 反斜杠（bin\.js）→ PS 单引号
      // 字符串原样传给 .NET 正则 → \. 匹配字面点 → 命中真实命令行里的 bin.js ✅
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bin\\.js' -and $_.CommandLine -match 'web' -and $_.CommandLine -match '--port ${CFG.dshPort}' } | Select-Object -ExpandProperty ProcessId`
      const out = await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
      })
      const pid = String(out).trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
      return pid[0] || null
    } catch { return null }
  }
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('ps', ['aux'], (err, stdout) => err ? reject(err) : resolve(stdout))
    })
    for (const line of String(out).split('\n')) {
      if (line.includes('bin.js') && line.includes('web') && line.includes(`--port ${CFG.dshPort}`)) {
        return Number(line.trim().split(/\s+/)[1])
      }
    }
  } catch { /* ps 不可用 */ }
  return null
}

function startDsh() {
  const cmd = resolveDshStartCmd()
  log('info', `启动 DSH: ${cmd}`)
  fs.mkdir(join(CFG.dshHome, 'git-rescue'), { recursive: true }).catch(() => {})
  // 防 OOM（2026-08-20 救援教训）：数据写坏时启动吃满 Node 默认 2GB heap → SIGABRT。
  // 2026-08-21 升级为自适应：按物理内存 50%（下限 2048 / 上限 8192），env DSH_MAX_OLD_SPACE 可覆盖。
  // NODE_OPTIONS 由 spawn 环境继承，--max-old-space-size 防启动期 OOM 循环。
  const memOpt = computeMaxOldSpace()
  const child = startDshWithLog(cmd, {
    logFile: STDERR_FILE,
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || memOpt },
  })
  if (!child) {
    log('error', `DSH spawn 失败: ${cmd}`)
    return
  }
  child.unref()
}

/** 停止 DSH：SIGTERM → 等待退出（最多 10s）→ SIGKILL 兜底；Windows 用 taskkill（2026-08-20 适配）。 */
async function stopDsh() {
  const pid = await findDshPid()
  if (!pid) {
    log('info', 'DSH 未在运行，无需停止')
    state.manualStop = true // 即使已停也置位：防止 tick 将"停止态"误判为故障拉起
    return true
  }
  const isWin = process.platform === 'win32'
  const { execFile } = await import('node:child_process')
  const killPid = (mode) => new Promise((resolve) => {
    if (isWin) {
      // Windows 无 SIGTERM 语义：taskkill 不带 /F = 温和请求；带 /F = 强杀
      execFile('taskkill', ['/PID', String(pid), mode === 'force' ? '/F' : '/T'], (err) => resolve(!err))
    } else {
      try { process.kill(pid, mode === 'force' ? 'SIGKILL' : 'SIGTERM'); resolve(true) } catch { resolve(false) }
    }
  })
  try {
    const sent = await killPid('soft')
    log('info', `已发送停止信号给 DSH (PID ${pid})${sent ? '' : '（信号发送失败，继续等待检测）'}`)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const p = await findDshPid()
      if (!p) {
        log('info', 'DSH 已退出')
        state.manualStop = true
        state.dsh = 'stopped'
        return true
      }
    }
    await killPid('force')
    log('warn', 'DSH 未在 10 秒内退出，已强制终止')
    state.manualStop = true
    state.dsh = 'stopped'
    return true
  } catch (e) {
    log('error', `停止 DSH 失败: ${String(e?.message ?? e)}`)
    return false
  }
}

// ============ 3080 透明代理守护 ============
// 官方 start.sh/runner.js 是"3081 web + 3080 proxy"一起拉起；但主实例常被
// 绕过 runner 直接拉起（孤儿进程），3080 从此无人托管。guardian 兜底。

/** 解析官方 proxy.js 启动命令。 */
function resolveProxyStartCmd() {
  const nodeBin = process.execPath
  const appDir = process.platform === 'win32'
    ? nodeBin.replace(/\\node(\.exe)?$/, '')
    : nodeBin.replace(/\/bin\/node$/, '')
  const proxyBin = join(appDir, 'bin', 'proxy.js')
  return `${nodeBin} ${proxyBin}`
}

/** 查找监听 CFG.proxyListenPort 的进程 PID（按端口精确匹配，防多实例串扰；2026-08-20 Windows 适配）。 */
async function findProxyPid() {
  const { execFile } = await import('node:child_process')
  if (process.platform === 'win32') {
    try {
      // Windows：netstat -ano 按端口找 PID（LISTENING 行最后一列）
      const out = await new Promise((resolve, reject) => {
        execFile('netstat', ['-ano'], { timeout: 8000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
      })
      for (const line of String(out).split('\n')) {
        if (!/LISTENING/i.test(line)) continue
        if (!line.includes(`:${CFG.proxyListenPort}`)) continue
        const parts = line.trim().split(/\s+/)
        const pid = Number(parts[parts.length - 1])
        if (Number.isFinite(pid) && pid > 0) return pid
      }
    } catch { /* netstat 不可用 */ }
    return null
  }
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('ss', ['-tlnp'], (err, stdout) => err ? reject(err) : resolve(stdout))
    })
    for (const line of String(out).split('\n')) {
      if (!line.includes(`:${CFG.proxyListenPort}`)) continue
      const m = line.match(/pid=(\d+)/)
      if (m) return Number(m[1])
    }
  } catch { /* ss 不可用 */ }
  return null
}

/** 拉起 3080 透明代理（官方 proxy.js，env 注入覆盖默认值）。 */
function startProxy() {
  if (!CFG.proxyEnabled) return
  const cmd = resolveProxyStartCmd()
  log('info', `启动透明代理: ${cmd} (${CFG.proxyListenHost}:${CFG.proxyListenPort} -> ${CFG.proxyTargetHost}:${CFG.proxyTargetPort})`)
  fs.mkdir(join(CFG.dshHome, 'git-rescue'), { recursive: true }).catch(() => {})
  const child = startDshWithLog(cmd, {
    logFile: STDERR_FILE,
    env: {
      ...process.env,
      PROXY_LISTEN_HOST: CFG.proxyListenHost,
      PROXY_LISTEN_PORT: String(CFG.proxyListenPort),
      PROXY_TARGET_HOST: CFG.proxyTargetHost,
      PROXY_TARGET_PORT: String(CFG.proxyTargetPort),
    },
  })
  if (!child) {
    log('error', `proxy spawn 失败: ${cmd}`)
    return
  }
  child.unref()
}

/** 兜底检查：DSH 健康时若 proxy 缺失则拉起。返回当前 proxy 状态。 */
async function ensureProxy() {
  if (!CFG.proxyEnabled) {
    state.proxy = 'unknown'
    return state.proxy
  }
  const pid = await findProxyPid()
  if (pid) {
    state.proxy = 'running'
    return state.proxy
  }
  if (state.proxy === 'starting' && state.proxyStartAt && Date.now() - state.proxyStartAt < 30_000) {
    return state.proxy
  }
  state.proxy = 'starting'
  state.proxyStartAt = Date.now()
  startProxy()
  return state.proxy
}

// ============ git 救援核心 ============

async function git(dir, args) {
  return runGit(args, { cwd: dir })
}

/** 探测命令执行器（mount/dmesg），供 probeSystemHints 使用。 */
async function execProbe(cmdArgs) {
  const { execFile } = await import('node:child_process')
  const [bin, ...args] = cmdArgs
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve(''); return }
      resolve(String(stdout ?? ''))
    })
  })
}

/** 插件配置是否有未提交变更（有 = 疑似装/改插件 → 可回退）。 */
async function pluginConfigChangedFlag() {
  const files = ['profiles/web/cordis.patch.yml', 'profiles/web/package.json', 'profiles/web/cordis.yml']
  try {
    const r = await git(CFG.dshHome, ['status', '--porcelain'])
    const out = r.stdout ?? ''
    return files.some((f) => out.includes(f) || out.includes(f.split('/').pop()))
  } catch { return false }
}

/**
 * 系统故障自动修复（可选，依赖 sudo-key）。
 * 读 data/sensitive/sudo-key（600 权限）→ 尝试 remount rw。
 */
async function trySystemFixWithSudo() {
  const sensitiveKey = join(CFG.workspace, 'data', 'sensitive', 'sudo-key')
  const legacyKey = join(CFG.dshHome, 'git-rescue', 'sudo-key')
  let key = ''
  try { key = (await fs.readFile(sensitiveKey, 'utf8')).trim() } catch { /* 回退旧路径 */ }
  if (!key) {
    try { key = (await fs.readFile(legacyKey, 'utf8')).trim() } catch { /* 未配置 */ }
  }
  if (!key) return { ok: false, sudoKeyMissing: true, detail: '未配置 sudo-key' }
  try {
    const { execFile } = await import('node:child_process')
    const targets = ['/vol1', '/']
    for (const t of targets) {
      const out = await new Promise((resolve) => {
        const child = execFile('sudo', ['-S', '-p', '', 'mount', '-s', '-o', 'remount,rw', t], {
          timeout: 8000,
          env: { ...process.env },
        }, (err, stdout, stderr) => {
          if (err) resolve({ ok: false, stderr: String(stderr ?? '') })
          else resolve({ ok: true })
        })
        child.stdin.write(key + '\n')
        child.stdin.end()
      })
      if (out.ok) return { ok: true, detail: `已 remount rw ${t}` }
    }
    return { ok: false, error: 'remount 尝试全部失败（可能卷健康/无 I-O 错误，或密码错误）' }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ 活跃对话检测 ============

/** 检测是否存在「进行中活跃对话」（装 session-manager 口径；未装降级事件流；DSH down 视为无活跃）。 */
async function detectActiveConversations() {
  const base = `http://${CFG.dshHost}:${CFG.dshPort}`
  try {
    const res = await fetch(base + CFG.sessionListPath, { signal: AbortSignal.timeout(5000) })
    if (res.status === 200) {
      const j = await res.json().catch(() => null)
      const sessions = Array.isArray(j?.sessions) ? j.sessions : []
      const active = sessions.filter((s) => s.running || s.continueRunning)
      const detail = active.map((s) => `${s.title || s.id}`).join('、') || '无'
      return { mode: 'session-manager', count: active.length, active, detail }
    }
    if (res.status === 404) return scanEventsForRunning()
    return { mode: 'down', count: 0, active: [], detail: 'session-manager API 异常，视为无活跃对话' }
  } catch {
    return { mode: 'down', count: 0, active: [], detail: 'DSH API 不可达，视为无活跃对话' }
  }
}

/** 降级口径：扫描 sessions 事件流，判定最后事件是否为 turn/start 未 end。 */
async function scanEventsForRunning() {
  const { execFile } = await import('node:child_process')
  const sessionsRoot = join(CFG.dshHome, 'sessions')
  let files = []
  try { files = await walkSessionLogs(sessionsRoot) } catch { /* 无会话目录 */ }
  const active = []
  for (const file of files.slice(0, 50)) {
    try {
      const tail = await new Promise((resolve) => {
        execFile('zstdcat', [file], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve('')
          resolve(String(stdout ?? ''))
        })
      })
      const lines = tail.split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        let ev = null
        try { ev = JSON.parse(lines[i]) } catch { continue }
        const t = ev?.type
        if (t === 'turn/end') break
        if (t === 'turn/start') { active.push({ id: file.split('/').filter(Boolean).pop()?.replace(/^session-/, '') || file }); break }
      }
    } catch { /* 单文件解析失败跳过 */ }
  }
  const detail = active.map((a) => a.id).join('、') || '无'
  return { mode: 'eventscan', count: active.length, active, detail }
}

/** 递归收集 sessions 下所有 session.jsonl.zstd（深度 ≤4）。 */
async function walkSessionLogs(root, depth = 0) {
  if (depth > 4) return []
  const { readdir } = await import('node:fs/promises')
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) out.push(...await walkSessionLogs(p, depth + 1))
    else if (e.name === 'session.jsonl.zstd' || e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

/** 落盘「重启申请」：存在活跃对话时 guardian 不重启，等对话结束后处理。 */
async function submitRestartRequest({ active, source }) {
  const req = {
    ts: new Date().toISOString(),
    type: 'restart-request',
    source,
    activeConversationCount: active.count,
    activeConversations: (active.active || []).map((s) => ({ id: s.id, title: s.title, running: s.running, continueRunning: s.continueRunning })),
    detail: active.detail,
    mode: active.mode,
    dshPort: CFG.dshPort,
    dshHome: CFG.dshHome,
    status: 'pending',
    note: '存在进行中活跃对话，guardian 已挂起重启；等对话结束后人工处理（或调用 /api/recover 手动救援）',
  }
  try {
    await fs.mkdir(join(CFG.dshHome, 'git-rescue'), { recursive: true })
    await fs.writeFile(RESTART_REQUEST_FILE, JSON.stringify(req, null, 2))
    return { ok: true, file: RESTART_REQUEST_FILE }
  } catch (e) {
    log('error', `重启申请落盘失败: ${String(e?.message ?? e)}`)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 手动 recover 前置：记录重启前 N 分钟内变动的文件（防回退丢刚写的代码）。 */
async function recordPreRestartChanges() {
  const { execFile } = await import('node:child_process')
  const out = { ts: new Date().toISOString(), windowMs: CFG.preRestartChangeWindowMs, files: [] }
  try {
    const status = await git(CFG.dshHome, ['status', '--porcelain'])
    const lines = (status.stdout ?? '').split('\n').filter(Boolean)
    const now = Date.now()
    for (const line of lines) {
      const path = line.slice(3).trim()
      if (!path) continue
      let inWindow = false
      try {
        const st = await import('node:fs').then((m) => m.promises.stat(join(CFG.dshHome, path)))
        inWindow = now - st.mtimeMs <= CFG.preRestartChangeWindowMs
      } catch { inWindow = true }
      if (inWindow) out.files.push({ path, flag: line.slice(0, 2) })
    }
    await fs.mkdir(join(CFG.dshHome, 'git-rescue'), { recursive: true })
    const file = join(CFG.dshHome, 'git-rescue', `pre-restart-changes-${Date.now()}.json`)
    await fs.writeFile(file, JSON.stringify(out, null, 2))
    log('warn', `📝 手动重启前 ${CFG.preRestartChangeWindowMs / 60000} 分钟内变动文件已记录（${out.files.length} 个）: ${file}`)
    return { ok: true, file, count: out.files.length }
  } catch (e) {
    log('error', `重启前变动文件记录失败: ${String(e?.message ?? e)}`)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ 救援前插件自更新（从 2.0.0 起具备） ============

/** 读取 GitHub token：data/sensitive/github-token（新约定）优先，git-rescue/token 回退。权限过宽自动收紧（2026-08-21 对齐官方）。 */
async function readTokenForUpdate() {
  try {
    const t = (await readFileSecure(join(CFG.workspace, 'data', 'sensitive', 'github-token'), 'utf8')).trim()
    if (t) return t
  } catch { /* 回退旧路径 */ }
  try { return (await readFileSecure(join(CFG.dshHome, 'git-rescue', 'token'))).trim() } catch { return '' }
}

/** 探测 SSH key 是否可用（~/.ssh 下存在非空 id_* key）。 */
async function sshKeyAvailable() {
  try {
    const sshDir = join(homedir(), '.ssh')
    const entries = await fs.readdir(sshDir).catch(() => [])
    for (const e of entries) {
      if (e.startsWith('id_') && !e.endsWith('.pub') && !e.includes('known')) {
        const st = await fs.stat(join(sshDir, e)).catch(() => null)
        if (st?.size > 0) return true
      }
    }
  } catch { /* 无 .ssh 目录 */ }
  return false
}

/**
 * 远端认证配置状态（②：守护进程管理 token/SSH key）。
 * 只报"是否已配置"，绝不显示明文（token 脱敏、SSH 只报文件名）。
 */
async function authStatus() {
  const token = await readTokenForUpdate()
  const ssh = await sshKeyAvailable()
  return {
    tokenSet: !!token,
    tokenMasked: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '',
    sshKeyAvailable: ssh,
    // token 文件位置（提示用，不显示内容）
    tokenSource: token ? 'data/sensitive/github-token 或 git-rescue/token' : null,
    sshKeyDir: join(homedir(), '.ssh'),
    method: ssh ? 'ssh' : (token ? 'token' : 'none'),
  }
}

/**
 * 配置 GitHub token（写入 data/sensitive/github-token，600 权限）。
 * @param {string} token
 */
async function saveToken(token) {
  const dir = join(CFG.workspace, 'data', 'sensitive')
  await fs.mkdir(dir, { recursive: true })
  await writeFileAtomic(join(dir, 'github-token'), String(token).trim())
  return { ok: true }
}

/**
 * 救援前插件自更新：guardian 救援逻辑本身也要保持最新——
 * 万一旧版 rescue 代码有 bug，用旧版救援 = 带病救人。recover 开始前先检查
 * 远端是否有新版 dsh-git-rescue，有则 applyUpdate（下载→校验→原子替换→回滚保护）。
 * 任何失败不阻断救援（fail-soft，记日志继续）。
 */
async function selfUpdateBeforeRecover() {
  if (!CFG.selfUpdate) {
    log('info', '救援前插件自更新: 已关闭（GUARDIAN_SELF_UPDATE=0）')
    return { ok: true, skipped: true }
  }
  try {
    const token = await readTokenForUpdate()
    const check = await checkForUpdate(token)
    if (!check.ok) {
      log('warn', `救援前插件自更新检查失败（不影响救援）: ${check.detail || check.error || '未知'}`)
      return { ok: false, error: check.detail || 'check failed' }
    }
    if (!check.updateAvailable) return { ok: true, skipped: true, installedVersion: check.installedVersion }
    log('warn', `⬆️ 救援前检测到插件新版本 ${check.installedVersion} → ${check.remoteVersion}，先应用自更新再救援…`)
    const r = await applyUpdate(token)
    if (r.ok && r.updated) {
      log('warn', `✅ 插件已自更新 ${r.from} → ${r.to}（磁盘已换新，guardian 重启后生效；本次救援继续用当前进程逻辑）`)
      return { ok: true, updated: true, from: r.from, to: r.to }
    }
    if (r.ok && !r.updated) {
      log('info', `插件自更新检查通过，无实际变更（${r.from} → ${r.to || r.from}）`)
      return { ok: true, skipped: true, from: r.from, to: r.to }
    }
    log('error', `插件自更新失败（不影响救援，继续用当前版本）: ${r.error}`)
    return { ok: false, error: r.error }
  } catch (e) {
    log('error', `救援前插件自更新异常（不影响救援）: ${String(e?.message ?? e)}`)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ ⑦ 纯净环境兜底 ============

/**
 * 唤起纯净环境兜底：主环境长时间无法恢复（flapping/救援失败）时，
 * 拉起 <dsh版本>@Save-clean 纯净实例（④ 救援环境），让人先有可用入口，
 * 且纯净 dsh 可加载救援插件 skills 目录协助恢复主环境（⑦）。
 * 幂等：已运行则跳过；脚本缺失则静默（不影响 guardian 主流程）。
 */
async function wakeCleanEnv(reason = '') {
  try {
    const { getDshVersion } = await import('../lib/device.js')
    const version = (await getDshVersion()) || 'unknown'
    const r = await startRescueEnv('clean', version, {
      appDir: process.execPath.replace(/\/bin\/node$/, ''),
      workspace: CFG.workspace,
    })
    if (r.ok) {
      log('warn', `⛑ 已唤起纯净环境 ${r.name || rescueEnvName(version, 'clean')}（${reason}）端口 :${r.port}`)
    } else {
      log('error', `唤起纯净环境失败（${reason}）: ${r.error || '未知'}`)
    }
    fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'clean-env-wake', msg: `唤起纯净环境: ${reason} → ${r.ok ? `:${r.port}` : r.error}` }) + '\n').catch(() => {})
    return r
  } catch (e) {
    log('error', `唤起纯净环境失败: ${String(e?.message ?? e)}`)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ 救援流程 ============

/**
 * 高峰续跑恢复（2026-08-20 救援经验 3 代码化）：
 * 救援成功后，若 session-manager 因高峰暂停了自动续跑（pauseAutoContinue），
 * 调 peak-resume 恢复——让崩溃时中断的会话能被继续。
 * fail-soft：session-manager 未装/高峰外/调用失败都不阻断。
 */
async function resumePeakIfPaused() {
  try {
    const base = `http://${CFG.dshHost}:${CFG.dshPort}`
    const st = await fetch(`${base}/api/session-manager/peak-status`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null)
    if (st?.ok && st.pauseAutoContinue) {
      const r = await fetch(`${base}/api/session-manager/peak-resume`, { method: 'POST', signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null)
      log('info', `⛑ 高峰自动续跑已恢复（peak-resume）${r?.ok ? '' : '（调用未确认）'}`)
      fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'peak-resume', msg: '救援后恢复高峰自动续跑' }) + '\n').catch(() => {})
    }
  } catch { /* fail-soft：不阻断救援 */ }
}

/** 救援流程：专项工具 → 保留现场 → 标记坏点 → 回退 → 重启 → 健康检查。 */
async function recover(source = 'auto') {
  if (state.manualBusy) return { ok: false, error: 'busy' }
  state.manualBusy = true
  state.dsh = 'recovering'
  // 故障分类上下文（tick 里 classifyFault 后暂存；手动 recover 可能无，兜底空对象）
  const faultInfo = state.lastFault || {}
  const reasonInfo = state.lastFaultReason || ''
  try {
    // ===== 前置：救援前插件自更新（从 2.0.0 起具备；测试环境也允许，自更新≠自动救援）=====
    await selfUpdateBeforeRecover()

    // ===== 前置闸门 =====

    // 0.0) 测试环境 / 救援环境（dsh-test-home* / @Save-clean / @Save-test）：不自动 git 回退（开发者自行解决），保留现场
    if (IS_SAFE_NO_RESCUE_HOME) {
      try {
        const pid = await findDshPid()
        if (pid || (await readLogTail(STDERR_FILE, 1))) {
          const ctx = await captureExitContext(pid, CFG.dshPort, { stderrFile: STDERR_FILE })
          log('warn', `退出现场（${IS_TEST_HOME ? '测试环境' : '救援环境'}，不自动救援）:\n${ctx}`)
          fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'exit-context', msg: ctx }) + '\n').catch(() => {})
        }
      } catch { /* 现场捕获失败不影响 */ }
      log('warn', `⛔ ${IS_TEST_HOME ? '测试环境' : '救援环境'}不自动救援：崩溃由开发者/纯净基线自行解决（git 回退/拉起已禁用）。现场已保留。`)
      fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: IS_TEST_HOME ? 'test-env-no-rescue' : 'rescue-env-no-rescue', msg: '非正式环境自动救援已禁用（现场已保留，由开发者处理）' }) + '\n').catch(() => {})
      state.failCount = 0
      state.flappingCooldownUntil = Date.now() + CFG.flappingWindowMs
      state.dsh = 'stopped'
      return { ok: false, testEnv: IS_TEST_HOME, rescueEnv: IS_RESCUE_HOME, blocked: IS_TEST_HOME ? 'test-env-no-rescue' : 'rescue-env-no-rescue', error: `${IS_TEST_HOME ? '测试环境' : '救援环境'}不自动救援（崩溃由开发者自行解决）` }
    }

    // 0.05) OOM 故障（2026-08-21 新增）：git 回退无意义（内存问题不是配置问题），
    //       崩溃后进程已退出、内存已释放 → 记录内存诊断后直接拉起（不回退、不标记 bad）。
    //       由 tick 的 !recoverable 分支特判进入（fault.type === 'oom'）。
    if (faultInfo.type === 'oom') {
      const mem = readMemSummary()
      log('error', `⛔ OOM 内存不足——跳过 git 回退（回退无意义），直接拉起。内存: ${mem.detail}`)
      fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'oom-detected', mem, msg: faultInfo.reason }) + '\n').catch(() => {})
      // 更新 NODE_OPTIONS 生效：若之前已用旧上限拉起过，内存诊断时点显式记录
      log('info', `  OOM 防护: ${computeMaxOldSpace()}（env DSH_MAX_OLD_SPACE 可覆盖）`)
      state.manualStop = false
      startDsh()
      const deadline = Date.now() + CFG.startWaitMs
      let ok = false
      while (Date.now() < deadline) {
        const p = await probeDsh()
        if (p.ok) { ok = true; break }
        await new Promise((r) => setTimeout(r, 1000))
      }
      state.lastRecoveryResult = { ok, oom: true, at: new Date().toISOString() }
      state.lastRecoveryAt = Date.now()
      state.dsh = ok ? 'running' : 'stopped'
      log(ok ? 'info' : 'warn', `OOM 后拉起: ${ok ? '✅ DSH 恢复正常（内存已释放）' : '❌ 仍失败——请人工释放内存（清理其他进程/加内存）后重试'}`)
      return { ok, oom: true, mem, error: ok ? undefined : 'OOM 拉起失败，需人工释放内存' }
    }

    // 0.1) 存在进行中活跃对话 → 不重启，提交重启申请
    const active = await detectActiveConversations()
    if (active.count > 0) {
      await submitRestartRequest({ active, source })
      log('warn', `⏸ 存在 ${active.count} 个进行中活跃对话——不自动重启，已提交重启申请: ${RESTART_REQUEST_FILE}`)
      state.failCount = 0
      state.flappingCooldownUntil = Date.now() + CFG.flappingWindowMs
      state.dsh = 'stopped'
      return { ok: false, blocked: 'active-conversation', request: RESTART_REQUEST_FILE, error: `存在 ${active.count} 个进行中活跃对话，已提交重启申请` }
    }

    // 0.2) 手动 recover：记录重启前变动的文件
    if (source === 'manual') {
      await recordPreRestartChanges()
    }

    // ===== ⑤ 专项恢复工具：先简单修复，修复后重新探活 =====
    log('warn', '开始救援：先跑专项恢复工具（⑤）…')
    const repair = await runRepairTools(CFG.dshHome, { sudoKey: '' })
    if (repair.hits.length) {
      log('warn', `专项工具命中 ${repair.hits.length} 个故障类型: ${repair.hits.map((h) => `${h.id}(${h.findings.length})`).join(', ')}`)
      for (const f of repair.fixes) {
        log(f.ok ? 'info' : 'warn', `  工具 ${f.id}: ${f.detail || (f.ok ? '已修复' : '未完全修复')}`)
      }
      // 修复后先探活一次：若已恢复则无需 git 回退
      const afterFix = await probeDsh()
      if (afterFix.ok) {
        log('info', `✅ 专项工具修复后 DSH 已恢复健康（无需 git 回退）`)
        state.dsh = 'running'
        state.failCount = 0
        fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'repair-tools-fixed', msg: JSON.stringify(repair.fixes) }) + '\n').catch(() => {})
        return { ok: true, repaired: true, hits: repair.hits, fixes: repair.fixes }
      }
    }

    log('warn', '专项工具未能恢复，继续 git 回退（⑥）')

    // 0.3) TERM 来源追踪：抓取进程退出上下文
    const pid = await findDshPid()
    if (pid || (await readLogTail(STDERR_FILE, 1))) {
      const ctx = await captureExitContext(pid, CFG.dshPort, { stderrFile: STDERR_FILE })
      log('warn', `退出现场:\n${ctx}`)
      fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'exit-context', msg: ctx }) + '\n').catch(() => {})
    }

    // 0.4) 插件安装事故识别：回退前提示疑似装/改插件
    const pluginFiles = ['profiles/web/cordis.patch.yml', 'profiles/web/package.json', 'profiles/web/cordis.yml']
    try {
      const changes = await git(CFG.dshHome, ['diff', '--name-only', 'HEAD'])
      const hit = pluginFiles.filter((f) => changes.stdout?.includes(f) || changes.stdout?.includes(f.split('/').pop()))
      if (hit.length) {
        log('warn', `🚨 疑似插件安装事故：以下插件配置文件在本次崩溃前有变更——${hit.join(', ')}。回退将恢复这些文件到上次好提交`)
      }
    } catch { /* 识别失败不影响救援 */ }

    // 1) 保留坏现场
    const pre = await commit(CFG.dshHome, 'chore(guard): crash-recovery | pre-rollback snapshot of broken state')
    if (!pre.ok) { log('error', `现场 commit 失败: ${pre.error}`); return { ok: false, error: pre.error } }

    // 2) 标记当前坏点
    const head = await headRef(CFG.dshHome)
    if (head) {
      const t = await markBad(CFG.dshHome, head)
      log('warn', `坏点标记: ${t.tag}`)
    }

    // 3) 找最后一个好提交并回退
    const good = await lastGoodCommit(CFG.dshHome)
    if (!good) { log('error', '没有可回退的好提交'); state.dsh = 'error'; return { ok: false, error: 'no good commit' } }
    // 2026-08-21 用户要求：还原只还原 profile/配置，不覆盖 sessions/storages 数据目录
    // （完整备份 commit 不变；回退仅恢复配置类路径，数据保持现状）
    const restore = await restoreProfileOnly(CFG.dshHome, good)
    if (!restore.ok) { log('error', `git 回退失败: ${restore.error}`); state.dsh = 'error'; return { ok: false, error: restore.error } }
    log('info', `已还原配置到 ${good}（from ${head || '无提交'}）: ${restore.restored.join(', ') || '(无可还原项)'}${restore.skipped.length ? `，跳过(不存在/数据): ${restore.skipped.join(', ')}` : ''}`)
    log('info', `数据目录已解除跟踪（sessions/storages 等不被回退覆盖）: ${restore.removed?.join(', ') || '(无)'}`)

    // 3.5) 插件树健康体检（合并自旧版拦截方案，2026-08-20）：
    //       git 回退后、拉起前体检——带病插件即使从 git 历史回退出来，也在拉起前被修掉（00:22 崩溃类型）
    // 2026-08-21 增强：体检发现的问题插件（invalid plugin / client 声明无产物等）修复无效时，
    //       优先备份式卸载并记录（plugin-error-uninstall-first skill：不反复修，先卸载恢复页面）
    try {
      const { pluginTreeHealthCheck, uninstallProblemPlugin } = await import('../lib/plugin-health.js')
      const ph = await pluginTreeHealthCheck(CFG.dshHome)
      if (ph.findings.length) {
        log('warn', `插件树体检发现 ${ph.findings.length} 项: ${ph.findings.map((f) => f.detail).join('; ')}`)
        // 体检后仍存在且修复无效的问题插件 → 备份式卸载（invalid plugin 类直接卸载）
        for (const f of ph.findings) {
          if (!f.plugin) continue
          const un = await uninstallProblemPlugin(CFG.dshHome, f.plugin, { dryRun: false })
          if (un.ok) {
            log('warn', `⚠️ 问题插件已备份式卸载（${f.type}）: ${f.plugin} → ${un.backups?.join(',') || '已移走'}；记录见任务清单/留痕`)
          } else {
            log('warn', `⚠️ 问题插件卸载失败（${f.type}）: ${f.plugin} → ${un.detail}`)
          }
        }
      }
      if (ph.fixes.length) log('warn', `插件树体检已修复 ${ph.fixes.length} 项（拉起前）`)
    } catch (e) { log('warn', `插件树体检失败（不影响拉起）: ${String(e?.message ?? e)}`) }

    // 4) 重启 DSH（手动救援 = 用户显式要求恢复运行 → 解除手动停止暂停）
    state.manualStop = false
    startDsh()

    // 5) 健康检查（等待 startWaitMs）
    const deadline = Date.now() + CFG.startWaitMs
    let ok = false
    while (Date.now() < deadline) {
      const p = await probeDsh()
      if (p.ok) { ok = true; break }
      await new Promise((r) => setTimeout(r, 1000))
    }
    state.lastRecoveryResult = { ok, to: good, from: head, at: new Date().toISOString() }
    state.lastRecoveryAt = Date.now()

    // ===== 需求6/5（2026-08-20 救机闭环）：恢复结果诊断报告 + 改动文件 zip 还原点 =====
    const changedFiles = await collectChangedFiles(CFG.dshHome, runGit)
    const reportInfo = {
      dshHome: CFG.dshHome,
      fault: faultInfo || {},
      reason: reasonInfo || '',
      preHead: head || '无',
      good,
      ok,
      repairHits: repair.hits || [],
      changedFiles,
      manualSteps: ok
        ? ['DSH 已恢复健康，无需手动干预；若后续异常可用还原点 zip 恢复改动文件']
        : ['DSH 未能自动恢复，参考本报告根因手动修复；或用还原点 zip 恢复改动文件后重启 DSH'],
    }
    const diag = await writeDiagnosticReport(CFG.dshHome, reportInfo)
    if (diag.ok) log('info', `📋 救援诊断报告已生成: ${diag.path}`)
    // 需求5：改动文件打包成 zip 还原点（放原 .dsh 根目录，快照归档）
    const zip = await packageChangedFiles({ dshHome: CFG.dshHome, gitFileList: changedFiles })
    if (zip.ok && zip.path) log('info', `📦 还原点压缩包已生成（${zip.count} 个文件）: ${zip.path}`)
    // 需求3+2：崩溃前活跃会话 → 救机任务清单（不可恢复/未恢复时给纯净环境 AI）
    const activeNow = await detectActiveConversations().catch(() => ({ count: 0, active: [] }))
    if (!ok) {
      const task = await writeRescueTaskList(CFG.dshHome, {
        dshHome: CFG.dshHome,
        reason: reasonInfo || `recover-ok=false (rolled back to ${good})`,
        fault: faultInfo || {},
        activeSessions: (activeNow.active || []).map((s) => ({ id: s.id, title: s.title, running: s.running })),
      })
      if (task.ok) log('warn', `🆘 救机任务清单已生成（供纯净环境 AI 阅读执行）: ${task.path}`)
    }

    if (ok) {
      state.dsh = 'running'
      log('info', `✅ 救援成功：回退到 ${good} 后 DSH 恢复正常`)
      // 经验3 代码化（2026-08-20）：高峰续跑被暂停时恢复——崩溃恢复后自动续跑中断会话
      await resumePeakIfPaused()
      // 需求4（2026-08-20）：救援成功 → 经验追加到权威 skill（去重防重复；测试环境跳过）
      const exp = await appendRescueExperience({
        rootCause: `救援成功: 回退到 ${good}`,
        detail: `fault=${(faultInfo || {}).type || 'unknown'}${reasonInfo ? `, reason=${reasonInfo}` : ''}`,
        dshHome: CFG.dshHome,
      })
      if (exp.ok && exp.appended) log('info', `🧠 救援经验已追加到权威 skill: ${exp.path}`)
    } else {
      // ===== guardian 直连 LLM 自治诊断（2026-08-20，默认关闭 2026-08-25） =====
      let llmResult = null
      if (CFG.llmEnabled) {
        try {
        const bootTail = await readLogTail(STDERR_FILE, 40)
        const gitLogR = await git(CFG.dshHome, ['log', '--oneline', '-n', '8'])
        llmResult = await llmDiagnoseRescue({
          dshHome: CFG.dshHome,
          fault: faultInfo || {},
          reason: reasonInfo || `recover-ok=false (rolled back to ${good})`,
          bootLog: bootTail || '',
          gitLog: gitLogR.ok ? gitLogR.stdout : '',
          repairHits: repair.hits || [],
        })
        if (llmResult.ok) {
          log('warn', `🤖 LLM 诊断: severity=${llmResult.severity} | ${(llmResult.analysis || '').slice(0, 160)}`)
          for (const a of llmResult.suggestedActions) {
            log('info', `  LLM 建议动作 [${a.type}]: ${a.reason || ''}`)
          }
          // ===== LLM 建议动作自动执行（2026-08-20 放开，所有用户默认可用）=====
          // 白名单 + commit 存在校验 + repair-tools fixId 限定；恢复健康即成功；上限 3 个防循环
          const llmExec = await executeLlmActions(llmResult.suggestedActions)
          for (const r of llmExec.results) {
            log(r.ok ? 'info' : 'warn', `  LLM 动作结果 [${r.type}]: ${r.detail || r.error || (r.skipped ? '跳过(仅分析)' : '')}${r.recoveredAfter ? ' → 已恢复健康' : ''}`)
          }
          if (llmExec.executed.length) log('info', `🤖 LLM 自动执行完成: ${llmExec.executed.join('、')}`)
          if (llmExec.recovered) {
            // LLM 动作修复成功：更新状态并复用成功路径（经验固化等由外层 ok 分支处理）
            log('warn', `✅ LLM 自治修复成功（无需纯净环境）`)
            ok = true
            state.dsh = 'running'
            state.failCount = 0
          }
          // LLM 分析结果并入诊断报告（落盘）
          const diag2 = await writeDiagnosticReport(CFG.dshHome, {
            ...reportInfo,
            ok,
            llmAnalysis: llmResult.analysis,
            llmActions: llmResult.suggestedActions,
            llmSeverity: llmResult.severity,
            llmExecResults: llmExec.results,
          })
          if (diag2.ok) log('info', `🤖 LLM 诊断已并入报告: ${diag2.path}`)
        } else {
          log('warn', `LLM 诊断不可用（回退模板报告）: ${llmResult.error || '未知'}`)
        }
        } catch (e) {
          log('warn', `LLM 诊断异常（不影响后续）: ${String(e?.message ?? e)}`)
        }
      }
      if (!ok) {
        state.dsh = 'error'
        log('error', `救援完成但 DSH 仍未健康（回退到 ${good}）`)
        await wakeCleanEnv(`recover-ok=false (rolled back to ${good})`)
      } else {
        // LLM 自治修复成功：补经验固化（测试环境跳过）
        const exp = await appendRescueExperience({
          rootCause: `LLM 自治修复成功: ${llmExec?.executed?.join('+') || 'unknown'}`,
          detail: `fault=${(faultInfo || {}).type || 'unknown'}（LLM 自动执行，未拉纯净环境）`,
          dshHome: CFG.dshHome,
        })
        if (exp.ok && exp.appended) log('info', `🧠 救援经验已追加到权威 skill: ${exp.path}`)
      }
    }
    return { ok, to: good, from: head }
  } catch (e) {
    state.dsh = 'error'
    log('error', `救援异常: ${String(e?.message ?? e)}`)
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    state.manualBusy = false
  }
}

// ============ 主循环 ============

/**
 * 执行 LLM 建议的白名单动作（2026-08-20 放开自动执行，所有用户默认可用）。
 * 安全约束：
 *  - 仅执行 validateLlmAction 已校验的白名单动作（report_only 跳过）
 *  - suggest_git_reset：commit 必须存在于仓库（git cat-file -e 校验），再 hardReset
 *  - suggest_config_fix：仅执行 repair-tools 已知 fixId 修复（不接受任意路径写入）
 *  - 每个动作执行后重新探活：恢复健康即返回成功
 *  - 上限 maxActions（默认 3），防 LLM 反复建议导致无限操作
 * @returns {Promise<{recovered:boolean, executed:string[], results:object[]}>}
 */
async function executeLlmActions(actions, { maxActions = 3 } = {}) {
  const executed = []
  const results = []
  const list = Array.isArray(actions) ? actions.slice(0, maxActions) : []
  for (const a of list) {
    const v = validateLlmAction(a)
    if (!v.ok) { results.push({ type: a?.type, ok: false, error: v.error }); continue }
    const act = v.action
    try {
      if (act.type === 'report_only') {
        results.push({ type: 'report_only', ok: true, skipped: true })
        continue
      }
      if (act.type === 'suggest_restart') {
        log('warn', `🤖 LLM 动作自动执行 [restart]: ${act.reason || ''}`)
        state.manualStop = false
        startDsh()
        executed.push('restart')
        const deadline = Date.now() + CFG.startWaitMs
        let ok = false
        while (Date.now() < deadline) {
          const p = await probeDsh()
          if (p.ok) { ok = true; break }
          await new Promise((r) => setTimeout(r, 1000))
        }
        results.push({ type: 'restart', ok, detail: ok ? '重启后 DSH 恢复健康' : '重启后仍未健康' })
        if (ok) return { recovered: true, executed, results }
        continue
      }
      if (act.type === 'suggest_git_reset') {
        // commit 必须真实存在（防 LLM 幻觉 commit）
        const verify = await git(CFG.dshHome, ['cat-file', '-e', `${act.commit}^{commit}`])
        if (!verify.ok) {
          results.push({ type: 'git_reset', ok: false, error: `commit 不存在: ${act.commit}` })
          continue
        }
        log('warn', `🤖 LLM 动作自动执行 [git_reset → ${act.commit}]: ${act.reason || ''}`)
        // 先标记当前为坏点（可回滚语义）
        const head = await headRef(CFG.dshHome)
        if (head) await markBad(CFG.dshHome, head)
        // 2026-08-21：只还原配置，不覆盖数据目录（同主恢复路径）
        const reset = await restoreProfileOnly(CFG.dshHome, act.commit)
        executed.push(`git_reset:${act.commit}`)
        results.push({ type: 'git_reset', ok: reset.ok, detail: reset.ok ? `已还原配置到 ${act.commit}（${reset.restored.join(', ')}）` : reset.error })
        if (reset.ok) {
          const deadline = Date.now() + CFG.startWaitMs
          let ok = false
          while (Date.now() < deadline) {
            const p = await probeDsh()
            if (p.ok) { ok = true; break }
            await new Promise((r) => setTimeout(r, 1000))
          }
          results[results.length - 1].recoveredAfter = ok
          if (ok) return { recovered: true, executed, results }
        }
        continue
      }
      if (act.type === 'suggest_config_fix') {
        // 仅执行 repair-tools 已知修复（fixId 白名单内）；不执行任意配置写入
        log('warn', `🤖 LLM 动作自动执行 [config_fix fixId=${act.fixId}]: ${act.reason || ''}`)
        const r = await runRepairTools(CFG.dshHome, { sudoKey: '', only: act.fixId })
        const fix = (r.fixes || []).find((f) => f.id === act.fixId)
        executed.push(`config_fix:${act.fixId}`)
        results.push({ type: 'config_fix', ok: !!fix?.ok, detail: fix?.detail || `修复 ${act.fixId} 未命中或未完成` })
        if (fix?.ok) {
          const deadline = Date.now() + CFG.startWaitMs
          let ok = false
          while (Date.now() < deadline) {
            const p = await probeDsh()
            if (p.ok) { ok = true; break }
            await new Promise((r) => setTimeout(r, 1000))
          }
          results[results.length - 1].recoveredAfter = ok
          if (ok) return { recovered: true, executed, results }
        }
        continue
      }
    } catch (e) {
      results.push({ type: a?.type, ok: false, error: String(e?.message ?? e) })
    }
  }
  return { recovered: false, executed, results }
}

/**
 * 自动续跑闸门联动（2026-08-20 用户要求）：DSH 恢复健康时置
 * autoContinueGate=closed（session-manager），默认关闭自动续跑——防崩溃恢复后
 * 自动续跑批量建空壳会话。用户手动开启或第一次手动对话后由 session-manager 自动置 open。
 * fail-soft：session-manager 未装 / API 不可达时静默跳过，不影响守护。
 */
async function closeAutoContinueGate() {
  try {
    const base = `http://${CFG.dshHost}:${CFG.dshPort}`
    const r = await fetch(base + '/api/session-manager/auto-continue-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gate: 'closed' }),
      signal: AbortSignal.timeout(4000),
    })
    if (r.status === 404) return // 未装 session-manager
    const j = await r.json().catch(() => null)
    if (j?.ok) {
      log('info', `🔒 自动续跑闸门已关闭（autoContinueGate=closed）：崩溃恢复/启动后默认不自动续跑，用户手动对话后放行`)
    } else {
      log('warn', `自动续跑闸门关闭未确认: ${j?.message || r.status}`)
    }
  } catch { /* fail-soft */ }
}

async function tick() {
  if (state.manualBusy) return
  const p = await probeDsh()
  if (p.ok) {
    const wasDown = state.dsh !== 'running'
    if (wasDown) log('info', 'DSH 恢复健康')
    state.dsh = 'running'
    state.lastOkAt = Date.now()
    state.failCount = 0
    // 2026-08-20 联动：DSH 恢复健康（含崩溃恢复与首次启动）→ 置自动续跑闸门 closed
    if (wasDown || !state.gateInitialized) {
      state.gateInitialized = true
      await closeAutoContinueGate()
    }
    const prevProxy = state.proxy
    await ensureProxy()
    if (prevProxy !== 'starting' && state.proxy === 'starting') {
      log('warn', '透明代理缺失，已触发拉起（下一轮 tick 复核）')
    } else if (prevProxy === 'starting' && state.proxy === 'running') {
      log('info', '透明代理已恢复')
    }
    return
  }
  // 手动停止期间：不累计失败、不自动拉起（旧版 /api/stop 语义，2026-08-20 补回）
  if (state.manualStop) {
    state.failCount = 0
    state.lastErrorAt = Date.now()
    return
  }
  // flapping 冷却期：检出无限重启后暂停自动救援，给人介入窗口
  if (state.flappingCooldownUntil && Date.now() < state.flappingCooldownUntil) {
    state.failCount = 0
    return
  }
  state.lastErrorAt = Date.now()
  state.failCount += 1
  const level = p.level || 'down'
  log('warn', `健康检查失败[${level}]（连续 ${state.failCount}/${CFG.failThreshold}）`)
  if (state.failCount >= CFG.failThreshold) {
    if (CFG.autoRecover) {
      // P0/P1 故障分类：先分清"能回退"与"不能回退"再决定救援方式
      const fault = await classifyFault({
        systemHints: await probeSystemHints(execProbe),
        bootHints: await readLogTail(STDERR_FILE, 40),
        pluginConfigChanged: await pluginConfigChangedFlag(),
      })
      log('warn', `故障分类: [${fault.type}] ${fault.reason}`)
      // 暂存故障上下文（供 recover 诊断报告/救机清单使用）
      state.lastFault = fault
      state.lastFaultReason = fault.reason || ''
      if (!fault.recoverable) {
        if (fault.type === 'oom') {
          // OOM 特判（2026-08-21）：不可回退，但 recover 内部有 OOM 分支——跳过 git 回退直接拉起
          state.failCount = 0
          await recover()
          return
        }
        if (fault.type === 'system') {
          const fixed = await trySystemFixWithSudo()
          if (fixed.ok) {
            log('warn', `✅ 系统故障已自动修复（${fixed.detail}）——继续正常探活`)
            fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'system-fixed', msg: fixed.detail }) + '\n').catch(() => {})
            state.failCount = 0
            return
          }
          if (fixed.sudoKeyMissing) {
            log('error', `⛔ 系统故障（${fault.type}）且未配置 sudo-key——无法自动修复，请人工处理：${fault.reason}`)
          } else {
            log('error', `⛔ 系统故障自动修复失败：${fixed.error}——请人工处理：${fault.reason}`)
          }
        } else {
          log('error', `⛔ 不可回退故障（${fault.type}）——停止自动救援，请人工处理：${fault.reason}`)
        }
        fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'unrecoverable', type: fault.type, msg: fault.reason }) + '\n').catch(() => {})
        state.failCount = 0
        state.flappingCooldownUntil = Date.now() + CFG.flappingWindowMs
        return
      }
      // 可回退：走正常 git 回退救援
      state.failCount = 0
      await recover()
      const flap = flapping.record(Date.now(), `recover#${state.lastRecoveryResult?.to || '?'}`)
      if (flap.level === 'flapping') {
        log('error', `🚨 flapping 检出：${CFG.flappingWindowMs / 60000} 分钟内 ${flap.count} 次重启——停止自动拉起循环，保留现场，告警人工介入`)
        fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'flapping', msg: `flapping-detected: ${flap.count} restarts in ${CFG.flappingWindowMs / 60000}min` }) + '\n').catch(() => {})
        await wakeCleanEnv(`flapping-detected: ${flap.count} restarts in ${CFG.flappingWindowMs / 60000}min`)
        flapping.reset()
        state.failCount = 0
        state.flappingCooldownUntil = Date.now() + CFG.flappingWindowMs
        log('warn', `flapping 冷却至 ${new Date(state.flappingCooldownUntil).toISOString()}（此期间不再自动救援）`)
      }
    } else {
      log('warn', '达到失败阈值，但自动救援已关闭（GUARDIAN_AUTO_RECOVER=0）')
    }
  }
}

// ============ HTTP（状态/控制/UI） ============

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

function startWeb() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const path = url.pathname
    try {
      if (path === '/' || path === '/index.html') {
        const html = await fs.readFile(new URL('./public/index.html', import.meta.url))
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.end(html)
      }
      if (path === '/app.js') {
        const js = await fs.readFile(new URL('./public/app.js', import.meta.url))
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        return res.end(js)
      }
      if (path === '/style.css') {
        const css = await fs.readFile(new URL('./public/style.css', import.meta.url))
        res.setHeader('Content-Type', 'text/css; charset=utf-8')
        return res.end(css)
      }
      if (path === '/inject.js') {
        // 救援入口注入脚本（2026-08-21）：DSH 页面 <script src="http://<host>:3082/inject.js"></script>
        // 轮询 /api/status，DSH 异常时页面弹横幅引导去救援面板
        const js = await fs.readFile(new URL('./public/inject.js', import.meta.url))
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        return res.end(js)
      }
      if (path === '/api/status') {
        return send(res, 200, {
          ok: true,
          testHome: IS_TEST_HOME,
          rescueEnv: IS_RESCUE_HOME,
          selfUpdate: { enabled: CFG.selfUpdate, autoUpdateEnabled: AUTO_UPDATE_ENABLED },
          auth: await authStatus(),
          restartRequest: await readRestartRequest(),
          mem: readMemSummary(),
          oomProtection: computeMaxOldSpace(),
          state: {
            dsh: state.dsh, proxy: state.proxy, lastOkAt: state.lastOkAt, lastErrorAt: state.lastErrorAt,
            failCount: state.failCount, lastRecoveryAt: state.lastRecoveryAt,
            lastRecoveryResult: state.lastRecoveryResult,
            manualStop: state.manualStop,
            flapping: { restarts: flapping.restarts, cooldownUntil: state.flappingCooldownUntil },
          },
          config: CFG,
          log: state.log.slice(-100),
        })
      }
      if (path === '/api/auth' && req.method === 'GET') {
        // ② 远端认证配置状态（token/SSH key，只报是否配置，不显示明文）
        return send(res, 200, { ok: true, ...(await authStatus()) })
      }
      if (path === '/api/auth' && req.method === 'POST') {
        // 配置 GitHub token（写入 data/sensitive/github-token，600 权限）
        const body = await readJson(req)
        if (!body.githubToken) return send(res, 400, { ok: false, error: '缺少 githubToken' })
        await saveToken(body.githubToken)
        log('warn', 'GitHub token 已更新（通过 guardian 网页配置）')
        return send(res, 200, { ok: true, ...(await authStatus()) })
      }
      if (path === '/api/admin-password' && req.method === 'GET') {
        // 管理员密码状态（只报是否配置，不返回明文）
        const { adminPasswordStatus } = await import('../lib/admin-password.js')
        return send(res, 200, { ok: true, ...(await adminPasswordStatus(CFG.workspace)) })
      }
      if (path === '/api/admin-password' && req.method === 'POST') {
        // 设置管理员密码（写入 data/sensitive/admin-password，600 权限；不进 git）
        const body = await readJson(req)
        const { saveAdminPassword, clearAdminPassword, adminPasswordStatus } = await import('../lib/admin-password.js')
        if (body?.clear === true) {
          await clearAdminPassword(CFG.workspace)
          log('warn', '管理员密码已清除（通过 guardian 网页）')
          return send(res, 200, { ok: true, ...(await adminPasswordStatus(CFG.workspace)) })
        }
        const r = await saveAdminPassword(CFG.workspace, body?.adminPassword || '')
        if (!r.ok) return send(res, 400, r)
        log('warn', '管理员密码已配置（通过 guardian 网页，data/sensitive/admin-password，600 权限）')
        return send(res, 200, { ok: true, ...(await adminPasswordStatus(CFG.workspace)) })
      }
      // ===== web 多选备份（会话/skill 定向备份，2026-08-20）=====
      if (path === '/api/backup-select/tree' && req.method === 'GET') {
        // 生成可选目录树（dir-tree，根默认 .dsh；可 ?root= 指定）
        const { buildSelectableTree, readSelectConfig } = await import('../lib/backup-select.js')
        const root = url.searchParams.get('root') || CFG.dshHome
        const r = await buildSelectableTree(root)
        return send(res, r.ok ? 200 : 400, { ok: r.ok, ...r, current: await readSelectConfig(CFG.dshHome) })
      }
      if (path === '/api/backup-select' && req.method === 'GET') {
        // 读取当前勾选配置
        const { readSelectConfig } = await import('../lib/backup-select.js')
        const cfg = await readSelectConfig(CFG.dshHome)
        return send(res, 200, { ok: true, config: cfg })
      }
      if (path === '/api/backup-select' && req.method === 'POST') {
        // 保存勾选配置 {root, selected: string[]}
        const body = await readJson(req)
        const { saveSelectConfig } = await import('../lib/backup-select.js')
        const r = await saveSelectConfig(CFG.dshHome, { root: body?.root || CFG.dshHome, selected: body?.selected || [] })
        log('info', `web 多选备份配置已保存（${(body?.selected || []).length} 个目录）`)
        return send(res, r.ok ? 200 : 400, r)
      }
      if (path === '/api/backup-select/apply' && req.method === 'POST') {
        // 按勾选写 .gitignore（反向白名单）
        const { readSelectConfig, applyGitignoreBySelection } = await import('../lib/backup-select.js')
        const cfg = await readSelectConfig(CFG.dshHome)
        if (!cfg) return send(res, 400, { ok: false, error: '未保存勾选配置' })
        const r = await applyGitignoreBySelection(CFG.dshHome, cfg)
        log(r.ok ? 'info' : 'warn', `按勾选写 .gitignore: ${r.ok ? `${r.selectedCount} 个目录` : r.error}`)
        return send(res, r.ok ? 200 : 400, r)
      }
      if (path === '/api/backup-select/push' && req.method === 'POST') {
        // 按勾选推送（git add -f 选中 → commit → push 备份仓）
        const { readSelectConfig, pushSelected } = await import('../lib/backup-select.js')
        const cfg = await readSelectConfig(CFG.dshHome)
        if (!cfg) return send(res, 400, { ok: false, error: '未保存勾选配置' })
        const r = await pushSelected(CFG.dshHome, cfg, runGit)
        log(r.ok ? 'info' : 'warn', `按勾选推送: ${r.ok ? `${r.selectedCount} 个目录已推送` : r.error}`)
        return send(res, r.ok ? 200 : 400, r)
      }
      if (path === '/api/gitlog') {
        const n = Number(url.searchParams.get('n') || 15)
        const r = await runGit(['log', '--oneline', '-n', String(n)], { cwd: CFG.dshHome })
        return send(res, 200, { ok: true, commits: r.ok ? r.stdout.split('\n').filter(Boolean) : [] })
      }
      if (path === '/api/snapshot/create' && req.method === 'POST') {
        // web 快照面板（2026-08-20）：手动创建快照 = git commit（chore(snapshot): manual）
        const body = await readJson(req).catch(() => ({}))
        const note = body?.note || 'manual'
        const safeNote = String(note).replace(/[^\w\u4e00-\u9fa5 -]/g, '').slice(0, 40)
        const r = await commit(CFG.dshHome, `chore(snapshot): ${safeNote || 'manual'}`)
        if (r.ok && !r.empty) {
          log('info', `📸 手动创建快照（git commit）: ${r.hash}`)
          return send(res, 200, { ok: true, hash: r.hash, snapshot: true })
        }
        if (r.ok && r.empty) {
          return send(res, 200, { ok: true, snapshot: true, note: '无变更，未产生新快照（当前状态已是快照）' })
        }
        return send(res, 500, { ok: false, error: r.error || '快照创建失败' })
      }
      if (path === '/api/recover' && req.method === 'POST') {
        const r = await recover('manual')
        return send(res, r.ok ? 200 : 500, r)
      }
      if (path === '/api/recover-auto' && req.method === 'POST') {
        const r = await recover('auto')
        return send(res, r.ok ? 200 : 500, r)
      }
      if (path === '/api/repair-tools' && req.method === 'GET') {
        // ⑤ 专项恢复工具诊断（只读）
        const { repairTools } = await import('../lib/repair-tools.js')
        const hits = []
        for (const t of repairTools(CFG.dshHome)) {
          try { hits.push({ id: t.id, name: t.name, ...(await t.diagnose()) }) } catch { /* 忽略 */ }
        }
        return send(res, 200, { ok: true, hits })
      }
      if (path === '/api/repair-tools' && req.method === 'POST') {
        // ⑤ 专项恢复工具尝试修复
        const r = await runRepairTools(CFG.dshHome, { sudoKey: '' })
        return send(res, 200, { ok: true, ...r })
      }
      if (path === '/api/rescue-env/status' && req.method === 'GET') {
        return send(res, 200, { ok: true, ...(await rescueEnvStatus()) })
      }
      if (path === '/api/rescue-env/start' && req.method === 'POST') {
        const body = await readJson(req)
        const { getDshVersion } = await import('../lib/device.js')
        const version = (await getDshVersion()) || 'unknown'
        const r = await startRescueEnv(body?.kind || 'clean', version, { workspace: CFG.workspace })
        return send(res, r.ok ? 200 : 500, r)
      }
      if (path === '/api/boot-autostart/status' && req.method === 'GET') {
        return send(res, 200, { ok: true, ...(await bootAutostartStatus(CFG.dshHome)) })
      }
      if (path === '/api/boot-autostart/install' && req.method === 'POST') {
        const r = await installBootAutostart(CFG.dshHome, {
          dshHome: CFG.dshHome,
          dshPort: CFG.dshPort,
          guardianPort: CFG.webPort,
          nodeBin: process.execPath,
          guardianServer: new URL('./server.js', import.meta.url).pathname,
        })
        return send(res, r.ok ? 200 : 500, r)
      }
      if (path === '/api/restart-request' && req.method === 'DELETE') {
        try { await fs.rm(RESTART_REQUEST_FILE, { force: true }); return send(res, 200, { ok: true }) }
        catch (e) { return send(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      }
      if (path === '/api/start' && req.method === 'POST') {
        // 插件安装门禁（2026-08-20）：检测到未测试插件 → 阻止主环境重启，提示先测试
        const { pendingPlugins } = await import('../lib/plugin-gate.js')
        const gate = await pendingPlugins({ dshHome: CFG.dshHome, mainProfile: join(CFG.dshHome, 'profiles', 'web') })
        if (gate.blocked) {
          const names = gate.pending.map((p) => p.id).join('、')
          log('warn', `⛔ 插件门禁拦截重启：以下插件未经测试环境验证——${names}（先去测试环境部署+测试，通过后 registry 更新为 passed 才放行）`)
          return send(res, 403, {
            ok: false,
            blocked: 'plugin-gate',
            pending: gate.pending.map((p) => p.id),
            error: `插件门禁：${names} 未在测试环境验证通过，已阻止主环境重启。请先在测试环境部署测试，通过后重试。`,
          })
        }
        state.manualStop = false // 手动启动 = 解除停止暂停（tick 恢复自动守护）
        startDsh()
        return send(res, 200, { ok: true })
      }
      if (path === '/api/stop' && req.method === 'POST') {
        // 旧版 /api/stop 功能补回（2026-08-20）：SIGTERM 优雅停止；置 manualStop 暂停自动拉起
        const r = await stopDsh()
        return send(res, r ? 200 : 500, { ok: r })
      }
      if (path === '/api/plugin-gate/scan' && req.method === 'POST') {
        // 插件门禁扫描（2026-08-20）：检测新插件 → 复制 skill → 标记 pending
        const pg = await import('../lib/plugin-gate.js')
        const mainProfile = join(CFG.dshHome, 'profiles', 'web')
        const det = await pg.detectNewPlugins({ dshHome: CFG.dshHome, mainProfile })
        const reg = await pg.readRegistry(CFG.dshHome)
        const results = []
        for (const p of det.newPlugins) {
          // 存量信任：registry 已有记录 → 按记录状态（不覆盖存量 passed）
          const isKnown = reg.plugins?.[p.id]
          if (isKnown) {
            results.push({ id: p.id, status: isKnown.testEnv || 'passed', note: 'registry 已有记录' })
            continue
          }
          // 无 registry 记录 = 新装插件（2026-08-21 用户确认修正）：
          // 复制 skills 到本地 → 标 pending → 阻止主环境重启，直到测试环境测试通过放行。
          // （存量插件在启用门禁时已批量登记，此后新增插件一律 pending，不再默认放行）
          const nmLocal = join(mainProfile, 'node_modules_local', p.id)
          const nm = join(mainProfile, 'node_modules', p.id)
          const pluginDir = await fs.access(nmLocal).then(() => nmLocal).catch(() => nm)
          const cp = await pg.copyPluginSkills(pluginDir, CFG.dshHome).catch(() => ({ ok: false, copied: [] }))
          await pg.updatePluginStatus(CFG.dshHome, { id: p.id, name: p.name, testEnv: 'pending' })
          results.push({ id: p.id, skillsCopied: cp.copied, status: 'pending', note: '新装插件：待测试环境验证（测试通过后 /api/plugin-gate/pass 放行重启）' })
        }
        log(`插件门禁扫描: ${results.length ? results.map((r) => `${r.id}(${r.status})`).join('、') : '无变更'}`)
        return send(res, 200, { ok: true, scanned: results.length, results })
      }
      if (path === '/api/plugin-gate/pass' && req.method === 'POST') {
        // 测试通过放行（2026-08-20）：{id} 更新 registry 为 passed，解除重启拦截
        const body = await readJson(req)
        if (!body?.id) return send(res, 400, { ok: false, error: '缺少 id' })
        const pg = await import('../lib/plugin-gate.js')
        const r = await pg.updatePluginStatus(CFG.dshHome, { id: body.id, name: body.name || '', testEnv: 'passed' })
        log(`插件门禁放行: ${body.id}（测试通过，registry → passed）`)
        return send(res, 200, { ok: true, plugin: r })
      }
      if (path === '/api/plugin-gate' && req.method === 'GET') {
        // 插件门禁状态（registry + pending 列表）
        const pg = await import('../lib/plugin-gate.js')
        const reg = await pg.readRegistry(CFG.dshHome)
        const mainProfile = join(CFG.dshHome, 'profiles', 'web')
        const p = await pg.pendingPlugins({ dshHome: CFG.dshHome, mainProfile })
        return send(res, 200, { ok: true, registry: reg.plugins, blocked: p.blocked, pending: p.pending.map((x) => x.id) })
      }
      if (path === '/api/proxy/start' && req.method === 'POST') {
        if (!CFG.proxyEnabled) return send(res, 400, { ok: false, error: 'proxy 守护已禁用 (GUARDIAN_PROXY_ENABLED=0)' })
        const pid = await findProxyPid()
        if (pid) return send(res, 200, { ok: true, alreadyRunning: true, pid })
        startProxy()
        return send(res, 200, { ok: true, started: true })
      }
      if (path === '/api/proxy/status' && req.method === 'GET') {
        const pid = await findProxyPid()
        return send(res, 200, { ok: true, enabled: CFG.proxyEnabled, pid, state: state.proxy })
      }
      if (path === '/api/ssh/enable' && req.method === 'POST') {
        // 开启 SSH（2026-08-20）：Windows 自动装 OpenSSH Server + 启服务 + 防火墙放行 22
        // 管理员密码：guardian 网页先填（data/sensitive/admin-password），提权执行免 UAC 弹窗
        const { enableSshOnWindows } = await import('../lib/ssh-enable.js')
        const { readAdminPassword } = await import('../lib/admin-password.js')
        const body = await readJson(req).catch(() => ({}))
        const adminPassword = body?.adminPassword || (await readAdminPassword(CFG.workspace)) || ''
        const r = await enableSshOnWindows({ adminPassword })
        if (r.ok) {
          log('info', `SSH 开启: ${r.noop ? '非 Windows 无需开启' : `22 端口已监听${r.needAdmin ? '（管理员上下文）' : ''}`}`)
        } else {
          log('warn', `SSH 开启未完成: ${r.error || '未知'}${r.needAdmin ? '（需管理员密码/权限）' : ''}`)
        }
        return send(res, r.ok ? 200 : (r.needAdmin ? 403 : 500), r)
      }
      return send(res, 404, { ok: false, error: `unknown route ${path}` })
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  })
  server.listen(CFG.webPort, '0.0.0.0', () => {
    log('info', `guardian 网页: http://0.0.0.0:${CFG.webPort}`)
  })
}

// ============ 入口 ============

/**
 * 需求1（2026-08-20）：启动时校验设备身份。
 * 读取当前设备 machine-id，与上次启动记录比对：
 *  - 首次运行：记录当前设备，正常。
 *  - 同一设备：正常（来源 machine-id 稳定）。
 *  - 设备变化（中途换设备/数据被拷到另一台机）：告警 + 事件留痕（仅告警不暂停，按用户确认）。
 * 救援插件每次启动都读设备信息——防止换设备后仍把另一台机的 .dsh 当本机救援。
 */
async function checkDeviceIdentity() {
  try {
    const { getDeviceId } = await import('../lib/device.js')
    const stateRoot = join(CFG.dshHome, 'git-rescue')
    const dev = await getDeviceId(stateRoot)
    let last = null
    try { last = JSON.parse(await fs.readFile(DEVICE_LAST_FILE, 'utf8')) } catch { /* 首次 */ }
    const now = { id: dev.id, source: dev.source, at: new Date().toISOString() }
    await fs.mkdir(stateRoot, { recursive: true })
    await fs.writeFile(DEVICE_LAST_FILE, JSON.stringify(now, null, 2), { mode: 0o600 })
    if (!last) {
      log('info', `设备身份已登记: ${dev.id.slice(0, 12)}…（source=${dev.source}，首次运行）`)
      return { ok: true, firstRun: true, id: dev.id }
    }
    if (last.id === dev.id) {
      log('info', `设备身份校验通过: ${dev.id.slice(0, 12)}…（source=${dev.source}，与上次一致）`)
      return { ok: true, id: dev.id }
    }
    // 设备变化：告警 + 留痕，不阻断（仅告警不暂停）
    const msg = `⚠️ 设备身份变化：上次=${last.id.slice(0, 12)}…(${last.source}@${(last.at || '').slice(0, 19)})，本次=${dev.id.slice(0, 12)}…(${dev.source})——疑似中途换设备/数据被拷贝到另一台机；本次仍按本机继续守护，请人工确认 .dsh 数据归属`
    log('warn', msg)
    fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'device-changed', msg, from: last, to: now }) + '\n').catch(() => {})
    return { ok: true, changed: true, from: last.id, to: dev.id }
  } catch (e) {
    log('warn', `设备身份校验失败（不影响启动）: ${String(e?.message ?? e)}`)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 读取当前待处理的重启申请（无则 null）。 */
async function readRestartRequest() {
  try {
    const raw = await fs.readFile(RESTART_REQUEST_FILE, 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

log('info', `dsh-git-rescue guardian 启动: probe=${CFG.dshHost}:${CFG.dshPort}, gitHome=${CFG.dshHome}, interval=${CFG.checkIntervalMs}ms, threshold=${CFG.failThreshold}${IS_TEST_HOME ? ' [测试环境：自动救援已禁用]' : IS_RESCUE_HOME ? ' [救援环境：自动救援已禁用]' : ''}`)
log('info', `透明代理守护: ${CFG.proxyEnabled ? `ON (${CFG.proxyListenHost}:${CFG.proxyListenPort} -> ${CFG.proxyTargetHost}:${CFG.proxyTargetPort})` : 'OFF (GUARDIAN_PROXY_ENABLED=0)'}`)
// 需求1（2026-08-20）：每次启动校验设备身份（换设备告警留痕，仅告警不暂停）
checkDeviceIdentity().then(() => {}).catch(() => {})
// ③ 开机自启状态提示（不自动写入系统，避免无 root 权限失败）
bootAutostartStatus(CFG.dshHome).then((b) => {
  log('info', `开机自启: ${b.registered ? `已注册 (${b.rcLocal})` : `未注册（脚本 ${b.script}${b.hasScript ? '' : ' 未生成'}，用 /api/boot-autostart/install 注册或人工执行）`}`)
}).catch(() => {})
startWeb()
setInterval(tick, CFG.checkIntervalMs)
tick()
