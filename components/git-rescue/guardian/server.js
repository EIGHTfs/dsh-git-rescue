/**
 * dsh-git-rescue guardian — 独立守护进程（git 回退版）
 *
 * 独立于 DSH 运行（DSH 崩了它照样活着）。功能：
 * 1. 定时健康检查 DSH（GET http://<host>:<port>）
 * 2. 连续失败 N 次 → 自动救援：
 *    a. git commit 当前坏状态（保留现场）
 *    b. 给当前 HEAD 打 bad 标记（防止回退后再次回到同一坏点）
 *    c. git reset --hard 到最后一个「好」提交
 *    d. 重启 DSH + 健康检查
 * 3. 网页 http://<listen>:<webPort> 可查看状态 / 手动回退 / 手动启动
 *
 * 回退源：~/.dsh git 仓库（dsh-git-rescue 插件维护），不依赖 zip 快照。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'
import { runGit, commit, headRef, markBad, lastGoodCommit, hardReset } from '../lib/git.js'
import { createFlappingDetector } from '../lib/flapping.js'
import { probeDshHealth } from '../lib/probe.js'
import { startDshWithLog, captureExitContext, readLogTail } from '../lib/process-capture.js'
import { classifyFault, probeSystemHints } from '../lib/fault-classify.js'
import { isTestHomePath } from '../lib/test-home.js'
import { AUTO_UPDATE_ENABLED, checkForUpdate, applyUpdate } from '../lib/self-update.js'

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
  // flapping 检测（v1.6.0）：窗口内 ≥maxRestarts 次重启 → 升级处理（防"无限重启"无声）
  flappingWindowMs: Number(process.env.GUARDIAN_FLAPPING_WINDOW_MS || 10 * 60 * 1000),
  flappingMaxRestarts: Number(process.env.GUARDIAN_FLAPPING_MAX_RESTARTS || 3),
  // 业务就绪探活（v1.6.0）：根通但 API 未就绪（假活）也算失败
  probeApiPath: process.env.GUARDIAN_PROBE_API_PATH || '/api/git-rescue/status',
  // tools 枚举探测默认关闭（DSH 无标准 /api/tools；显式配置才启用）
  probeToolsPath: process.env.GUARDIAN_PROBE_TOOLS_PATH || null,
  // 活跃对话判定（v1.11.0）：装了 session-manager 用 running||continueRunning（口径1），
  // 未装则降级扫描事件流仅 running（口径3）。DSH down（API 不可达）→ 视为无活跃对话，正常救援。
  sessionListPath: process.env.GUARDIAN_SESSION_LIST_PATH || '/api/session-manager/list',
  // 手动重启前记录变动的文件（时间窗，默认 10 分钟）
  preRestartChangeWindowMs: Number(process.env.GUARDIAN_PRERESTART_WINDOW_MS || 10 * 60 * 1000),
  // v1.12.0：救援前插件自更新（默认跟随 AUTO_UPDATE_ENABLED；GUARDIAN_SELF_UPDATE=0 可关）
  selfUpdate: process.env.GUARDIAN_SELF_UPDATE !== '0' && AUTO_UPDATE_ENABLED,
  // v1.13.0：3080 透明代理守护（官方 proxy.js：0.0.0.0:3080 -> 127.0.0.1:3081）
  // 主实例 3081 常被绕过 runner 直接拉起，导致配套 3080 代理无人托管（2026-08-20 实测）。
  // guardian 在此兜底：DSH 健康时若 proxy.js 进程缺失 → 自动拉起（GUARDIAN_PROXY_ENABLED=0 可关）。
  proxyEnabled: process.env.GUARDIAN_PROXY_ENABLED !== '0',
  proxyListenHost: process.env.GUARDIAN_PROXY_HOST || '0.0.0.0',
  proxyListenPort: Number(process.env.GUARDIAN_PROXY_PORT || 3080),
  proxyTargetHost: process.env.GUARDIAN_PROXY_TARGET_HOST || '127.0.0.1',
  proxyTargetPort: Number(process.env.GUARDIAN_PROXY_TARGET_PORT || 3081),
}

// 是否测试环境（v1.11.0）：测试环境不自动救援——插件编写导致的崩溃由开发者自行解决
const IS_TEST_HOME = isTestHomePath(CFG.dshHome)

const LOG_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-dsh.log')
const EVENTS_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-events.jsonl')
const STDERR_FILE = join(CFG.dshHome, 'git-rescue', 'dsh-stderr.log')
// v1.11.0：存在进行中活跃对话时，不自动重启，落盘「重启申请」供人工/后续处理
const RESTART_REQUEST_FILE = join(CFG.dshHome, 'git-rescue', 'restart-request.json')

// ============ 状态 ============
const state = {
  dsh: 'unknown',            // 'running' | 'stopped' | 'recovering'
  proxy: 'unknown',          // v1.13.0：'running' | 'stopped' | 'starting'
  proxyStartAt: null,        // v1.13.0：最近一次触发 proxy 拉起的时间（防重复 spawn）
  lastOkAt: null,
  lastErrorAt: null,
  failCount: 0,
  lastRecoveryAt: null,
  lastRecoveryResult: null,
  log: [],                   // [{time, level, msg}]
  manualBusy: false,
  flappingCooldownUntil: null, // flapping 检出后的冷却截止时间（此期间不自动救援）
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

/**
 * 业务就绪探活（v1.6.0，替代旧"GET / 200"）：
 *  - healthy  ：根通 + 业务 API 通（+ 工具端点通）——真正健康
 *  - degraded ：根通但业务端点失败 → 假活（服务未就绪），按失败处理触发救援
 *  - down     ：根都不通 → 进程挂了
 */
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
  const dshBin = join(nodeBin.replace(/\/bin\/node$/, ''), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return `${nodeBin} ${dshBin} web --host ${CFG.dshHost} --port ${CFG.dshPort}`
}

async function findDshPid() {
  try {
    const { execFile } = await import('node:child_process')
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
  // v1.6.0：stderr/stdout 落盘（dsh-stderr.log，滚动 500KB），崩溃时留证
  const child = startDshWithLog(cmd, { logFile: STDERR_FILE })
  if (!child) {
    log('error', `DSH spawn 失败: ${cmd}`)
    return
  }
  child.unref()
}

// ============ 3080 透明代理守护（v1.13.0） ============
// 背景：官方 start.sh/runner.js 是"3081 web + 3080 proxy"一起拉起；但主实例常被
// 绕过 runner 直接 `bin.js web --port 3081` 拉起（孤儿进程），3080 从此无人托管。
// guardian 在此兜底：DSH 健康时若 proxy.js 进程缺失 → 用官方 proxy.js 拉起。

/** 解析官方 proxy.js 启动命令（与 resolveDshStartCmd 同根推导）。 */
function resolveProxyStartCmd() {
  const nodeBin = process.execPath
  const proxyBin = join(nodeBin.replace(/\/bin\/node$/, ''), 'bin', 'proxy.js')
  return `${nodeBin} ${proxyBin}`
}

/** 查找监听 CFG.proxyListenPort 的进程 PID（按端口精确匹配，防多实例串扰）。 */
async function findProxyPid() {
  try {
    const { execFile } = await import('node:child_process')
    const out = await new Promise((resolve, reject) => {
      execFile('ss', ['-tlnp'], (err, stdout) => err ? reject(err) : resolve(stdout))
    })
    for (const line of String(out).split('\n')) {
      // ss 行示例: LISTEN 0 511 0.0.0.0:3080 0.0.0.0:* users:(("node",pid=1234,fd=21))
      if (!line.includes(`:${CFG.proxyListenPort}`)) continue
      const m = line.match(/pid=(\d+)/)
      if (m) return Number(m[1])
    }
  } catch { /* ss 不可用 */ }
  return null
}

/** 拉起 3080 透明代理（官方 proxy.js，端口来自 CFG，env 注入覆盖默认值）。 */
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
  // 已触发拉起但进程未就绪（spawn 需时间）→ 30s 内不重复 spawn
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
 * v1.8.0：系统故障自动修复（可选，依赖 sudo-key）。
 * 读 ~/.dsh/git-rescue/sudo-key（600 权限，插件侧配置，绝不明文显示）→ 尝试 remount rw。
 * @returns {{ok:boolean, sudoKeyMissing?:boolean, detail?:string, error?:string}}
 */
async function trySystemFixWithSudo() {
  // 读 sudo-key：data/sensitive（2026-08-19 用户约定）优先，旧路径 git-rescue/sudo-key 回退
  const workspace = process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace'
  const sensitiveKey = join(workspace, 'data', 'sensitive', 'sudo-key')
  const legacyKey = join(CFG.dshHome, 'git-rescue', 'sudo-key')
  let key = ''
  try { key = (await fs.readFile(sensitiveKey, 'utf8')).trim() } catch { /* 回退旧路径 */ }
  if (!key) {
    try { key = (await fs.readFile(legacyKey, 'utf8')).trim() } catch { /* 未配置 */ }
  }
  if (!key) return { ok: false, sudoKeyMissing: true, detail: '未配置 sudo-key' }

  // 尝试 remount /vol1 rw（或 /，看哪个 ro）
  // 注：-s 忽略未知挂载选项（fnOS ZFS 的 trimacl 等专有选项，无 -s 会报 invalid option）
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
      if (out.ok) {
        return { ok: true, detail: `已 remount rw ${t}` }
      }
      // 目标不是 ro 时忽略该目标错误，继续下一个
    }
    return { ok: false, error: 'remount 尝试全部失败（可能卷健康/无 I-O 错误，或密码错误）' }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ 活跃对话检测（v1.11.0） ============

/**
 * 检测是否存在「进行中活跃对话」。
 * 口径（用户约定）：
 *  - 装了 session-manager（/api/session-manager/list 可达）→ running || continueRunning
 *  - 未装（404）→ 降级扫描事件流，仅 running（hasOpenTurn：最后事件是 turn/start 未 turn/end）
 *  - DSH down（API 不可达）→ 视为无活跃对话，正常救援
 * @returns {{mode:'session-manager'|'eventscan'|'down', count:number, active:Array, detail:string}}
 */
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
    if (res.status === 404) {
      // 未装 session-manager → 降级事件流扫描（仅 running 口径）
      return scanEventsForRunning()
    }
    // 其他错误（500 等）→ 保守按无活跃处理（服务异常，检测不到就当没有）
    return { mode: 'down', count: 0, active: [], detail: 'session-manager API 异常，视为无活跃对话' }
  } catch {
    // fetch 失败/超时 = DSH down → 无活跃对话，正常救援
    return { mode: 'down', count: 0, active: [], detail: 'DSH API 不可达，视为无活跃对话' }
  }
}

/**
 * 降级口径：扫描 $DSH_HOME/sessions 下各 session 目录的 session.jsonl.zstd 事件流，
 * 判定最后事件是否为 turn/start 未 end（进行中回合）。
 * 用 zstdcat（系统命令，多帧拼接 zstd 文件也能解）读尾部，逐条 JSON 解析。
 */
async function scanEventsForRunning() {
  const { execFile } = await import('node:child_process')
  const sessionsRoot = join(CFG.dshHome, 'sessions')
  let files = []
  try {
    files = await walkSessionLogs(sessionsRoot)
  } catch { /* 无会话目录 */ }
  const active = []
  for (const file of files.slice(0, 50)) { // 上限 50 个会话，防扫描过慢
    try {
      const tail = await new Promise((resolve) => {
        execFile('zstdcat', [file], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve('')
          resolve(String(stdout ?? ''))
        })
      })
      const lines = tail.split('\n').filter(Boolean)
      // 从尾部向前找 turn/start / turn/end
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

/** 递归收集 sessions 下所有 session.jsonl.zstd（深度 ≤4，防异常深目录）。 */
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

/**
 * 落盘「重启申请」restart-request.json：存在进行中活跃对话时，guardian 不重启，
 * 把申请写进文件（人工查看 / 后续对话结束后由脚本处理），避免打断活跃对话。
 */
async function submitRestartRequest({ active, source }) {
  const req = {
    ts: new Date().toISOString(),
    type: 'restart-request',
    source,                          // 'auto' | 'manual'
    activeConversationCount: active.count,
    activeConversations: (active.active || []).map((s) => ({ id: s.id, title: s.title, running: s.running, continueRunning: s.continueRunning })),
    detail: active.detail,
    mode: active.mode,
    dshPort: CFG.dshPort,
    dshHome: CFG.dshHome,
    status: 'pending',               // 'pending'（待处理）→ 人工确认/后续脚本处理后置 'handled'
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

/**
 * 手动 recover 前置：记录重启前 N 分钟内（默认 10 分钟）变动的文件。
 * git 无法直接按"修改时间"列未提交文件，用两个信号合并：
 *  - git status --porcelain：未提交/未跟踪的改动文件
 *  - fs.stat mtime 在窗口内（仅对 status 列出的文件，命中窗口才算"近期变动"）
 * 记录到 restart-request 同目录 pre-restart-changes-<ts>.json，防回退丢开发者刚写的文件。
 */
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
      } catch { inWindow = true } // stat 失败（已删除等）保守计入
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

// ============ 救援前插件自更新（v1.12.0） ============

/**
 * 读取 GitHub token：data/sensitive/github-token（新约定）优先，git-rescue/token 回退。
 * guardian 是独立进程，需自行解析（与插件侧 readToken 同路径约定）。
 */
async function readTokenForUpdate() {
  const workspace = process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace'
  try {
    const t = (await fs.readFile(join(workspace, 'data', 'sensitive', 'github-token'), 'utf8')).trim()
    if (t) return t
  } catch { /* 回退旧路径 */ }
  try { return (await fs.readFile(join(CFG.dshHome, 'git-rescue', 'token'), 'utf8')).trim() } catch { return '' }
}

/**
 * 救援前插件自更新：guardian 救援逻辑本身也要保持最新——
 * 万一旧版 rescue 代码有 bug，用旧版救援 = 带病救人。因此 recover 开始前先
 * 检查远端是否有新版 dsh-git-rescue，有则 applyUpdate（下载→校验→原子替换→回滚保护），
 * 替换磁盘上的插件文件；当前 guardian 进程仍运行旧代码（Node 已加载），
 * 磁盘已换新 → 下次 guardian/DSH 重启即用新代码。测试环境同样允许（自更新≠自动救援）。
 * 任何失败不阻断救援（fail-soft，记日志继续）。
 * @returns {Promise<{ok:boolean, updated?:boolean, from?:string, to?:string, skipped?:boolean, error?:string}>}
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
    const ev = { time: new Date().toISOString(), level: r.ok ? 'info' : 'error', msg: `self-update ${r.ok ? (r.updated ? `${r.from} → ${r.to}` : 'no-op') : r.error}` }
    fs.appendFile(EVENTS_FILE, JSON.stringify(ev) + '\n').catch(() => {})
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

/** 救援流程：保留现场 → 标记坏点 → 回退 → 重启 → 健康检查。
 * @param {string} source 'auto'（探活自动触发）| 'manual'（手动 /api/recover）
 * v1.11.0：
 *  - 测试环境：不自动救援（插件编写导致的崩溃由开发者自行解决），保留现场 + 冷却，不 git 回退。
 *  - 存在进行中活跃对话（running || continueRunning，装了 session-manager 口径；未装降级事件流仅 running）：
 *    不重启，落盘 restart-request.json 提交「重启申请」，等活跃对话结束后人工/自动处理。
 *  - 手动 recover（source=manual）：先拦截活跃对话；无活跃对话时，记录重启前 10 分钟内变动的文件，
 *    记录完毕再重启（防回退丢掉开发者刚写的文件）。
 */
/**
 * 唤起纯净环境兜底（2026-08-20 用户约定）：主环境长时间无法恢复（flapping/救援失败）时，
 * 拉起 dsh-test-home-clean 纯净实例（3083 起首个空闲端口 + 反代 3084），
 * 让人先有一个可用的 DSH 入口，再按 skill 恢复流程处理主环境。
 * 幂等：已运行则跳过；纯净环境不可用/脚本缺失则静默（不影响 guardian 主流程）。
 */
async function wakeCleanEnv(reason = '') {
  try {
    const script = '/vol1/@appshare/DeepSeekHarness/workspace/dsh-clean-env.sh'
    const name = 'dsh-test-home-clean'
    const portFile = '/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home-clean/.dsh-env-port'
    // 已运行则跳过（读端口文件 + 探活）
    try {
      const port = (await fs.readFile(portFile, 'utf8')).trim()
      if (port) {
        const p = await probeDshHealth(fetch, '127.0.0.1', Number(port), { apiPath: CFG.probeApiPath, toolsPath: CFG.probeToolsPath })
        if (p.ok) {
          log('info', `纯净环境已在运行（${reason}），无需唤起（:${port}）`)
          return { ok: true, already: true, port }
        }
      }
    } catch { /* 未运行或读端口失败，继续唤起 */ }
    try {
      await fs.access(script)
    } catch {
      log('warn', `唤起纯净环境失败：脚本不存在 ${script}（${reason}）`)
      return { ok: false, error: 'script missing' }
    }
    const { spawn } = await import('node:child_process')
    const child = spawn('/bin/bash', [script, 'start', name], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: process.env.PATH || '/usr/bin:/bin' },
    })
    child.unref()
    log('warn', `⛑ 唤起纯净环境（${reason}）：${script} start ${name}`)
    fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'clean-env-wake', msg: `唤起纯净环境: ${reason}` }) + '\n').catch(() => {})
    return { ok: true }
  } catch (e) {
    log('error', `唤起纯净环境失败: ${String(e?.message ?? e)}`)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

async function recover(source = 'auto') {
  if (state.manualBusy) return { ok: false, error: 'busy' }
  state.manualBusy = true
  state.dsh = 'recovering'
  try {
    // ===== v1.12.0 前置：救援前插件自更新（更新完继续救援；测试环境也允许，自更新≠自动救援）=====
    await selfUpdateBeforeRecover()

    // ===== v1.11.0 前置闸门 =====

    // 0.0) 测试环境：不自动救援（插件编写导致的崩溃由开发者自行解决）
    if (IS_TEST_HOME) {
      // 保留现场（stderr + TERM 上下文），供开发者复盘
      try {
        const pid = await findDshPid()
        if (pid || (await readLogTail(STDERR_FILE, 1))) {
          const ctx = await captureExitContext(pid, CFG.dshPort, { stderrFile: STDERR_FILE })
          log('warn', `退出现场（测试环境，不自动救援）:\n${ctx}`)
          fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'exit-context', msg: ctx }) + '\n').catch(() => {})
        }
      } catch { /* 现场捕获失败不影响 */ }
      log('warn', '⛔ 测试环境不自动救援：插件编写导致的崩溃由开发者自行解决（git 回退/拉起已禁用）。现场已保留，请开发者处理。')
      fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'test-env-no-rescue', msg: '测试环境自动救援已禁用（插件开发崩溃由开发者自行解决），现场已保留' }) + '\n').catch(() => {})
      state.failCount = 0
      state.flappingCooldownUntil = Date.now() + CFG.flappingWindowMs
      state.dsh = 'stopped'
      return { ok: false, testEnv: true, blocked: 'test-env-no-rescue', error: '测试环境不自动救援（插件崩溃由开发者自行解决）' }
    }

    // 0.1) 存在进行中活跃对话 → 不重启，提交重启申请（自动/手动都拦；DSH down 无法检测时视为无活跃对话）
    const active = await detectActiveConversations()
    if (active.count > 0) {
      await submitRestartRequest({ active, source })
      log('warn', `⏸ 存在 ${active.count} 个进行中活跃对话——不自动重启，已提交重启申请: ${RESTART_REQUEST_FILE}（等对话结束后处理；列表: ${active.detail.slice(0, 300)}）`)
      state.failCount = 0
      state.flappingCooldownUntil = Date.now() + CFG.flappingWindowMs
      state.dsh = 'stopped'
      return { ok: false, blocked: 'active-conversation', request: RESTART_REQUEST_FILE, error: `存在 ${active.count} 个进行中活跃对话，已提交重启申请` }
    }

    // 0.2) 手动 recover：记录重启前 10 分钟内变动的文件，记录完毕再重启
    if (source === 'manual') {
      await recordPreRestartChanges()
    }

    log('warn', '开始自动救援（git 回退）')

    // 0) TERM 来源追踪（v1.6.0）：抓取进程退出上下文（/proc 残留 + stderr 尾部 + 系统日志），
    //    写入事件流与 stderr 落盘，回答"谁发的 TERM / 为什么崩"
    const pid = await findDshPid()
    if (pid || (await readLogTail(STDERR_FILE, 1))) {
      const ctx = await captureExitContext(pid, CFG.dshPort, { stderrFile: STDERR_FILE })
      log('warn', `退出现场:\n${ctx}`)
      fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'exit-context', msg: ctx }) + '\n').catch(() => {})
    }

    // 0.5) 插件安装事故识别（AGNES-LESSON 教训，v1.7.1）：启动失败可能是刚装的插件导致
    //     （client 导出错误 / 依赖残留 → DSH 起不来）。回退将恢复事故前的插件配置
    //     （cordis.patch.yml / package.json / node_modules 均在 .dsh 仓库跟踪内）。
    const pluginFiles = ['profiles/web/cordis.patch.yml', 'profiles/web/package.json', 'profiles/web/cordis.yml']
    try {
      const changes = await git(CFG.dshHome, ['diff', '--name-only', 'HEAD'])
      const hit = pluginFiles.filter((f) => changes.stdout?.includes(f) || changes.stdout?.includes(f.split('/').pop()))
      if (hit.length) {
        log('warn', `🚨 疑似插件安装事故：以下插件配置文件在本次崩溃前有变更——${hit.join(', ')}。回退将恢复这些文件到上次好提交，请人工确认是否刚装了/改了插件`)
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
    const reset = await hardReset(CFG.dshHome, good)
    if (!reset.ok) { log('error', `git reset 失败: ${reset.error}`); state.dsh = 'error'; return { ok: false, error: reset.error } }
    log('info', `已回退到 ${good}（from ${head || '无提交'}）`)

    // 3.5) 插件树健康体检（2026-08-20 整合）：回退后、重启前，修复「声明 client 但产物缺失」
    //      类问题——即使带病插件在 git 历史里（回退后仍在），也在拉起前修掉，防 Failed to load plugins 崩溃循环
    try {
      const { pluginTreeHealthCheck } = await import('../lib/plugin-health.js')
      const ph = await pluginTreeHealthCheck(CFG.dshHome)
      if (ph.findings.length) {
        log('warn', `🩺 插件树体检发现 ${ph.findings.length} 个问题:`)
        for (const f of ph.findings) log('warn', `    [${f.plugin}] ${f.type}: ${f.detail}`)
      }
      if (ph.fixes.length) {
        for (const x of ph.fixes) log('warn', `🩺 自动修复: ${x.action} — ${x.detail}`)
      } else if (ph.findings.length) {
        log('warn', '🩺 体检发现问题但无需自动修复（非 client 声明类），继续拉起')
      } else {
        log('info', '🩺 插件树体检通过')
      }
    } catch (e) {
      log('error', `🩺 插件树体检执行失败（不阻断拉起）: ${String(e?.message ?? e)}`)
    }

    // 4) 重启 DSH
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
    if (ok) {
      state.dsh = 'running'
      log('info', `✅ 救援成功：回退到 ${good} 后 DSH 恢复正常`)
    } else {
      state.dsh = 'error'
      log('error', `救援完成但 DSH 仍未健康（回退到 ${good}）`)
      // 2026-08-20 用户约定：回退后仍不健康 = 长时间未恢复 → 唤起纯净环境兜底
      await wakeCleanEnv(`recover-ok=false (rolled back to ${good})`)
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

async function tick() {
  if (state.manualBusy) return
  const p = await probeDsh()
  if (p.ok) {
    if (state.dsh !== 'running') log('info', 'DSH 恢复健康')
    state.dsh = 'running'
    state.lastOkAt = Date.now()
    state.failCount = 0
    // v1.13.0：每轮 tick 都实时检查 3080 透明代理（findProxyPid 按端口查，
    // 缺失才拉起；不依赖 state.proxy 缓存，防"掉线后不再检查"）
    const prevProxy = state.proxy
    await ensureProxy()
    if (prevProxy !== 'starting' && state.proxy === 'starting') {
      log('warn', '透明代理缺失，已触发拉起（下一轮 tick 复核）')
    } else if (prevProxy === 'starting' && state.proxy === 'running') {
      log('info', '透明代理已恢复')
    }
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
      // ===== P0/P1 故障分类（v1.7.2）：先分清"能回退"与"不能回退"再决定救援方式 =====
      // 系统盘只读 / 引导软链冲突 回退无意义，且会浪费重启次数（无限重启的根因之一）
      const fault = await classifyFault({
        systemHints: await probeSystemHints(execProbe),
        bootHints: await readLogTail(STDERR_FILE, 40),
        pluginConfigChanged: await pluginConfigChangedFlag(),
      })
      log('warn', `故障分类: [${fault.type}] ${fault.reason}`)
      if (!fault.recoverable) {
        // 不可回退：不触发 git 回退重启（避免对只读卷做无意义救援）
        // v1.8.0：若配置了 sudo-key（可选，绝不明文显示）→ 尝试自动修复系统故障（remount rw）
        if (fault.type === 'system') {
          const fixed = await trySystemFixWithSudo()
          if (fixed.ok) {
            log('warn', `✅ 系统故障已自动修复（${fixed.detail}）——继续正常探活`)
            fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'system-fixed', msg: fixed.detail }) + '\n').catch(() => {})
            state.failCount = 0
            return // 不进入冷却，下一轮 tick 重新探活
          }
          if (fixed.sudoKeyMissing) {
            log('error', `⛔ 系统故障（${fault.type}）且未配置 sudo-key——无法自动修复，请人工处理：${fault.reason}（可选：插件配置里填写 sudoKey 后自动修复）`)
          } else {
            log('error', `⛔ 系统故障自动修复失败：${fixed.error}——请人工处理：${fault.reason}`)
          }
        } else {
          log('error', `⛔ 不可回退故障（${fault.type}）——停止自动救援，请人工处理：${fault.reason}`)
        }
        fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'unrecoverable', type: fault.type, msg: fault.reason }) + '\n').catch(() => {})
        state.failCount = 0
        state.flappingCooldownUntil = Date.now() + CFG.flappingWindowMs // 冷却，防反复无用救援
        return
      }
      // 可回退：走正常 git 回退救援
      state.failCount = 0
      await recover()
      // flapping 检测：每次救援后记录一次"重启事件"；窗口内 ≥maxRestarts 次 → 升级处理
      // （防"反复拉起即崩"的无限重启无人识别）
      const flap = flapping.record(Date.now(), `recover#${state.lastRecoveryResult?.to || '?'}`)
      if (flap.level === 'flapping') {
        log('error', `🚨 flapping 检出：${CFG.flappingWindowMs / 60000} 分钟内 ${flap.count} 次重启——停止自动拉起循环，保留现场，告警人工介入`)
        log('error', `flapping 详情: ${flap.restarts.map((r) => new Date(r.ts).toISOString()).join(' → ')}`)
        // 升级处理：不再自动拉起（避免无限循环）；现场已由 recover() 的 commit 保留
        // 事件落盘（guardian-events.jsonl 已有 log 记录；这里补一条显式 flapping 事件）
        fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'flapping', msg: `flapping-detected: ${flap.count} restarts in ${CFG.flappingWindowMs / 60000}min` }) + '\n').catch(() => {})
        // 2026-08-20 用户约定：长时间无法恢复 → 唤起纯净环境，让人先有可用入口
        await wakeCleanEnv(`flapping-detected: ${flap.count} restarts in ${CFG.flappingWindowMs / 60000}min`)
        // 冷却：重置 failCount 防止立即再次触发 recover 造成死循环；人工介入后 reset()
        flapping.reset()
        state.failCount = 0
        // 暂停自动恢复一段时间（默认 10 分钟），给人介入窗口
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
      if (path === '/api/status') {
        return send(res, 200, {
          ok: true,
          testHome: IS_TEST_HOME,
          selfUpdate: { enabled: CFG.selfUpdate, autoUpdateEnabled: AUTO_UPDATE_ENABLED },
          restartRequest: await readRestartRequest(),
          state: {
            dsh: state.dsh, proxy: state.proxy, lastOkAt: state.lastOkAt, lastErrorAt: state.lastErrorAt,
            failCount: state.failCount, lastRecoveryAt: state.lastRecoveryAt,
            lastRecoveryResult: state.lastRecoveryResult,
            flapping: { restarts: flapping.restarts, cooldownUntil: state.flappingCooldownUntil },
          },
          config: CFG,
          log: state.log.slice(-100),
        })
      }
      if (path === '/api/gitlog') {
        const n = Number(url.searchParams.get('n') || 15)
        const r = await runGit(['log', '--oneline', '-n', String(n)], { cwd: CFG.dshHome })
        return send(res, 200, { ok: true, commits: r.ok ? r.stdout.split('\n').filter(Boolean) : [] })
      }
      if (path === '/api/recover' && req.method === 'POST') {
        const r = await recover('manual')
        return send(res, r.ok ? 200 : 500, r)
      }
      if (path === '/api/recover-auto' && req.method === 'POST') {
        const r = await recover('auto')
        return send(res, r.ok ? 200 : 500, r)
      }
      if (path === '/api/restart-request' && req.method === 'DELETE') {
        // 人工处理完活跃对话后，清除重启申请
        try { await fs.rm(RESTART_REQUEST_FILE, { force: true }); return send(res, 200, { ok: true }) }
        catch (e) { return send(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      }
      if (path === '/api/start' && req.method === 'POST') {
        startDsh()
        return send(res, 200, { ok: true })
      }
      if (path === '/api/proxy/start' && req.method === 'POST') {
        // v1.13.0：手动拉起 3080 透明代理
        if (!CFG.proxyEnabled) return send(res, 400, { ok: false, error: 'proxy 守护已禁用 (GUARDIAN_PROXY_ENABLED=0)' })
        const pid = await findProxyPid()
        if (pid) return send(res, 200, { ok: true, alreadyRunning: true, pid })
        startProxy()
        return send(res, 200, { ok: true, started: true })
      }
      if (path === '/api/proxy/status' && req.method === 'GET') {
        // v1.13.0：查询 3080 代理状态
        const pid = await findProxyPid()
        return send(res, 200, { ok: true, enabled: CFG.proxyEnabled, pid, state: state.proxy })
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

/** 读取当前待处理的重启申请（无则 null）。 */
async function readRestartRequest() {
  try {
    const raw = await fs.readFile(RESTART_REQUEST_FILE, 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

log('info', `dsh-git-rescue guardian 启动: probe=${CFG.dshHost}:${CFG.dshPort}, gitHome=${CFG.dshHome}, interval=${CFG.checkIntervalMs}ms, threshold=${CFG.failThreshold}${IS_TEST_HOME ? ' [测试环境：自动救援已禁用]' : ''}`)
log('info', `透明代理守护: ${CFG.proxyEnabled ? `ON (${CFG.proxyListenHost}:${CFG.proxyListenPort} -> ${CFG.proxyTargetHost}:${CFG.proxyTargetPort})` : 'OFF (GUARDIAN_PROXY_ENABLED=0)'}`)
startWeb()
setInterval(tick, CFG.checkIntervalMs)
tick()
