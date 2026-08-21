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
import { startDshWithLog, captureExitContext } from '../lib/process-capture.js'

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
  probeApiPath: process.env.GUARDIAN_PROBE_API_PATH || '/api/status',
  probeToolsPath: process.env.GUARDIAN_PROBE_TOOLS_PATH || '/api/tools',
}

const LOG_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-dsh.log')
const EVENTS_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-events.jsonl')
const STDERR_FILE = join(CFG.dshHome, 'git-rescue', 'dsh-stderr.log')

// ============ 状态 ============
const state = {
  dsh: 'unknown',            // 'running' | 'stopped' | 'recovering'
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

// ============ git 救援核心 ============

async function git(dir, args) {
  return runGit(args, { cwd: dir })
}

/** 救援流程：保留现场 → 标记坏点 → 回退 → 重启 → 健康检查。 */
async function recover() {
  if (state.manualBusy) return { ok: false, error: 'busy' }
  state.manualBusy = true
  state.dsh = 'recovering'
  try {
    log('warn', '开始自动救援（git 回退）')

    // 0) TERM 来源追踪（v1.6.0）：抓取进程退出上下文（/proc 残留 + stderr 尾部 + 系统日志），
    //    写入事件流与 stderr 落盘，回答"谁发的 TERM / 为什么崩"
    const pid = await findDshPid()
    if (pid || (await readLogTail(STDERR_FILE, 1))) {
      const ctx = await captureExitContext(pid, CFG.dshPort, { stderrFile: STDERR_FILE })
      log('warn', `退出现场:\n${ctx}`)
      fs.appendFile(EVENTS_FILE, JSON.stringify({ time: new Date().toISOString(), level: 'exit-context', msg: ctx }) + '\n').catch(() => {})
    }

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
          state: {
            dsh: state.dsh, lastOkAt: state.lastOkAt, lastErrorAt: state.lastErrorAt,
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
        const r = await recover()
        return send(res, r.ok ? 200 : 500, r)
      }
      if (path === '/api/start' && req.method === 'POST') {
        startDsh()
        return send(res, 200, { ok: true })
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

log('info', `dsh-git-rescue guardian 启动: probe=${CFG.dshHost}:${CFG.dshPort}, gitHome=${CFG.dshHome}, interval=${CFG.checkIntervalMs}ms, threshold=${CFG.failThreshold}`)
startWeb()
setInterval(tick, CFG.checkIntervalMs)
tick()
