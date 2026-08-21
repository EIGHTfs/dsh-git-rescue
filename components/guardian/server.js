/**
 * dsh-guardian — DSH 守护服务
 *
 * 独立于 DSH 运行（DSH 崩了它照样活着）。功能：
 * 1. 定时健康检查 DSH（GET http://<host>:<port>）
 * 2. 连续失败 N 次 → 自动回退：从最新快照开始逐个恢复 + 尝试启动 DSH + 健康检查
 * 3. 网页 http://<listen>:<webport> 可查看状态、手动恢复/启停
 *
 * 回退源：~/.dsh/snapshot-archive/<profile>/*.zip（dsh-snapshot-archive 插件的快照格式）
 * 恢复 = 解压 zip 到 ~/.dsh 根目录。
 */

import { promises as fs, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { unzipStore } from './lib/zip.js'

// ============ 配置（可用环境变量覆盖） ============
const CFG = {
  // DSH 健康检查目标
  dshHost: process.env.DSH_HOST || '127.0.0.1',
  dshPort: Number(process.env.DSH_PORT || 3081),
  // DSH 启动命令（进程列表里找，找不到则用下面默认）
  dshStartCmd: process.env.DSH_START_CMD || '',
  // guardian 网页端口
  webPort: Number(process.env.GUARDIAN_PORT || 3082),
  // 健康检查间隔（毫秒）
  checkIntervalMs: Number(process.env.GUARDIAN_INTERVAL_MS || 10_000),
  // 连续失败多少次触发自动回退
  failThreshold: Number(process.env.GUARDIAN_FAIL_THRESHOLD || 3),
  // 启动 DSH 后等待健康检查的时长（毫秒）
  startWaitMs: Number(process.env.GUARDIAN_START_WAIT_MS || 15_000),
  // 回退前自动创建快照（保留现场）
  autoSnapshotBeforeRollback: process.env.GUARDIAN_PRE_SNAPSHOT !== '0',
  // 自动回退开关
  autoRollback: process.env.GUARDIAN_AUTO_ROLLBACK !== '0',
}

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
const DSH_ROOT = join(HOME, '.dsh')

/** 解析当前 profile 名。 */
function detectProfileName() {
  const argv = process.argv ?? []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
    if (a.startsWith('--profile=')) return a.slice('--profile='.length)
  }
  return 'web'
}
const PROFILE = detectProfileName()
const SNAPSHOT_ROOT = join(DSH_ROOT, 'snapshot-archive', PROFILE)

// ============ 状态 ============
const state = {
  dsh: 'unknown',       // 'running' | 'stopped' | 'error' | 'rollback'
  lastOkAt: null,
  lastErrorAt: null,
  failCount: 0,
  rollback: {
    active: false,
    tried: [],          // [{id, time, result}]
    current: null,
    stoppedReason: null,
  },
  lastRollbackAt: null,
  log: [],              // [{time, level, msg}]
  manualBusy: false,
}

function log(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg }
  state.log.push(entry)
  if (state.log.length > 500) state.log = state.log.slice(-500)
  const ts = entry.time.slice(11, 19)
  console.log(`[${ts}][${level}] ${msg}`)
}

// ============ DSH 进程管理 ============

/** 解析 DSH 启动命令（默认从配置，或自动探测 bin.js web 进程）。 */
function resolveDshStartCmd() {
  if (CFG.dshStartCmd) return CFG.dshStartCmd
  // 默认用 DSH 的 bin.js，host/port 用配置。node 解释器 = 当前进程的 execPath。
  const nodeBin = process.execPath
  const dshBin = join(dirname(nodeBin), '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return `${nodeBin} ${dshBin} web --host ${CFG.dshHost} --port ${CFG.dshPort}`
}

/** 查找正在运行的 DSH 进程 PID（通过 bin.js web 关键字）。 */
async function findDshPid() {
  try {
    const { execFile } = await import('node:child_process')
    const out = await new Promise((resolve, reject) => {
      execFile('ps', ['aux'], (err, stdout) => err ? reject(err) : resolve(stdout))
    })
    const lines = String(out).split('\n')
    for (const line of lines) {
      if (line.includes('bin.js') && line.includes('web') && line.includes(`--port ${CFG.dshPort}`)) {
        return Number(line.trim().split(/\s+/)[1])
      }
    }
  } catch { /* ps 不可用 */ }
  return null
}

/** 启动 DSH（守护进程，脱离本进程）。 */
function startDsh() {
  const cmd = resolveDshStartCmd()
  log('info', `启动 DSH: ${cmd}`)
  // 用 sh -c 后台启动，输出到日志文件
  const logFile = join(DSH_ROOT, 'snapshot-archive', 'dsh-guardian-dsh.log')
  const child = spawn('sh', ['-c', `${cmd} >> "${logFile}" 2>&1 &`], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  return true
}

/** 停止 DSH。 */
async function stopDsh() {
  const pid = await findDshPid()
  if (!pid) { log('info', 'DSH 未在运行，无需停止'); return true }
  try {
    process.kill(pid, 'SIGTERM')
    log('info', `已发送 SIGTERM 给 DSH (PID ${pid})`)
    // 等待退出
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const p = await findDshPid()
      if (!p) { log('info', 'DSH 已退出'); return true }
    }
    process.kill(pid, 'SIGKILL')
    log('warn', 'DSH 未在 10 秒内退出，已 SIGKILL')
    return true
  } catch (e) {
    log('error', `停止 DSH 失败: ${e.message}`)
    return false
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 健康检查：GET DSH 首页。 */
async function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get({ host: CFG.dshHost, port: CFG.dshPort, path: '/', timeout: 5000 }, (res) => {
      res.resume()
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500 })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
    req.on('error', () => resolve({ ok: false }))
  })
}

// ============ 快照读取与恢复 ============

/** 列出快照（按时间从新到旧）。 */
async function listSnapshots() {
  const out = []
  try {
    await fs.mkdir(SNAPSHOT_ROOT, { recursive: true })
    const names = await fs.readdir(SNAPSHOT_ROOT)
    for (const n of names.sort().reverse()) {
      if (!n.endsWith('.zip')) continue
      const zipPath = join(SNAPSHOT_ROOT, n)
      try {
        const buf = await fs.readFile(zipPath)
        const files = unzipStore(buf)
        const manifest = files.get('manifest.json')
        const m = manifest ? JSON.parse(manifest.toString('utf8')) : { id: n.slice(0, -4), time: '', reason: '' }
        out.push({ id: m.id || n.slice(0, -4), time: m.time, reason: m.reason, fileCount: m.files?.length ?? 0, size: buf.length, zip: n })
      } catch (e) {
        log('warn', `读取快照失败 ${n}: ${e.message}`)
      }
    }
  } catch (e) {
    log('error', `列快照失败: ${e.message}`)
  }
  return out
}

/** 恢复快照：解压 zip 到 .dsh 根。返回 {ok, restored, skipped}。 */
async function restoreSnapshot(id) {
  const zipPath = join(SNAPSHOT_ROOT, `${id}.zip`)
  if (!existsSync(zipPath)) return { ok: false, error: `快照不存在: ${id}` }
  try {
    const buf = await fs.readFile(zipPath)
    const files = unzipStore(buf)
    const restored = []
    const skipped = []
    for (const [rel, data] of files) {
      if (rel === 'manifest.json' || rel.startsWith('_restore/')) continue
      if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) continue
      const dest = join(DSH_ROOT, rel)
      await fs.mkdir(dirname(dest), { recursive: true })
      // 敏感保护：脱敏占位符不覆盖已有真实值
      const base = String(rel).replace(/\\/g, '/').split('/').pop()
      if ((base === '.credentials.yaml' || base === '.env') && data.toString('utf8').includes('***REDACTED***')) {
        if (existsSync(dest)) { skipped.push(rel); continue }
      }
      await fs.writeFile(dest, data)
      restored.push(rel)
    }
    log('info', `快照 ${id} 恢复: ${restored.length} 文件, 跳过 ${skipped.length}`)
    return { ok: true, restored, skipped }
  } catch (e) {
    log('error', `恢复快照 ${id} 失败: ${e.message}`)
    return { ok: false, error: e.message }
  }
}

// ============ 自动回退 ============

/** 自动回退：从最新快照开始逐个恢复+启动+健康检查。 */
async function autoRollback(reason) {
  if (state.rollback.active) return
  state.rollback.active = true
  state.rollback.stoppedReason = reason
  state.rollback.tried = []
  log('warn', `==== 自动回退开始 (${reason}) ====`)

  try {
    // 回退前先停 DSH，避免半死进程干扰
    await stopDsh()
    await sleep(1000)

    const snaps = await listSnapshots()
    if (snaps.length === 0) {
      log('error', '没有可回退的快照！')
      state.dsh = 'error'
      return
    }
    log('info', `有 ${snaps.length} 个快照可回退，从最新开始逐个测试`)

    for (const snap of snaps) {
      state.rollback.current = snap.id
      log('info', `→ 尝试恢复快照 ${snap.id} (${snap.time}, ${snap.reason || '无备注'})`)
      const r = await restoreSnapshot(snap.id)
      if (!r.ok) {
        state.rollback.tried.push({ id: snap.id, result: 'restore-failed', error: r.error })
        continue
      }
      // 启动 DSH 并等待健康检查
      startDsh()
      await sleep(CFG.startWaitMs)
      const hc = await healthCheck()
      if (hc.ok) {
        log('ok', `✅ 快照 ${snap.id} 恢复后 DSH 正常启动！`)
        state.rollback.tried.push({ id: snap.id, result: 'ok' })
        state.dsh = 'running'
        state.failCount = 0
        return
      } else {
        log('warn', `✗ 快照 ${snap.id} 恢复后 DSH 仍无法启动，继续回退`)
        state.rollback.tried.push({ id: snap.id, result: 'start-failed' })
        await stopDsh()
        await sleep(1000)
      }
    }
    log('error', '所有快照都无法让 DSH 启动！需要人工介入')
    state.dsh = 'error'
    state.rollback.stoppedReason = 'all-snapshots-failed'
  } finally {
    state.rollback.active = false
    state.rollback.current = null
    // 回退结束无论成败都重置计数，避免立刻再次触发
    state.failCount = 0
    state.lastRollbackAt = Date.now()
  }
}

// ============ 主循环 ============

async function tick() {
  // 手动操作期间不自动回退
  if (state.manualBusy) return
  // 回退进行中跳过
  if (state.rollback.active) return

  const hc = await healthCheck()
  if (hc.ok) {
    state.dsh = 'running'
    state.lastOkAt = new Date().toISOString()
    state.failCount = 0
  } else {
    state.failCount++
    state.lastErrorAt = new Date().toISOString()
    if (state.failCount === 1) log('warn', `DSH 健康检查失败 #1`)
    // 回退冷却期：刚回退完不立刻再触发，避免死循环
    const cooldownMs = 60_000
    if (state.lastRollbackAt && Date.now() - state.lastRollbackAt < cooldownMs) {
      state.dsh = 'error'
      log('warn', `回退冷却期内（${Math.ceil((cooldownMs - (Date.now() - state.lastRollbackAt)) / 1000)}s）不再自动回退`)
      state.failCount = 0
      return
    }
    if (state.failCount >= CFG.failThreshold) {
      log('error', `DSH 连续失败 ${state.failCount} 次，判定异常`)
      state.dsh = 'error'
      if (CFG.autoRollback) {
        await autoRollback(`连续 ${state.failCount} 次健康检查失败`)
      }
      state.failCount = 0 // 防止重复触发
    } else {
      state.dsh = 'stopped'
    }
  }
}

// ============ HTTP 服务（网页 + API） ============

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

async function serveStatic(res, pathname) {
  const PUBLIC = join(dirname(new URL(import.meta.url).pathname), 'public')
  let file = join(PUBLIC, pathname === '/' ? 'index.html' : pathname)
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; res.end('forbidden'); return }
  try {
    const data = await fs.readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    res.statusCode = 200
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}

function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    try {
      // ---- API ----
      if (pathname === '/api/status') {
        return sendJson(res, 200, {
          ok: true,
          dsh: state.dsh,
          lastOkAt: state.lastOkAt,
          lastErrorAt: state.lastErrorAt,
          failCount: state.failCount,
          failThreshold: CFG.failThreshold,
          rollbackActive: state.rollback.active,
          rollbackTried: state.rollback.tried,
          rollbackCurrent: state.rollback.current,
          snapshotRoot: SNAPSHOT_ROOT,
          profile: PROFILE,
          autoRollback: CFG.autoRollback,
        })
      }
      if (pathname === '/api/snapshots') {
        return sendJson(res, 200, { ok: true, snapshots: await listSnapshots() })
      }
      if (pathname === '/api/log') {
        return sendJson(res, 200, { ok: true, log: state.log })
      }
      if (pathname === '/api/restore' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        state.manualBusy = true
        try {
          await stopDsh()
          const r = await restoreSnapshot(body.id)
          if (!r.ok) return sendJson(res, 404, r)
          startDsh()
          log('info', `手动恢复快照 ${body.id} 并启动 DSH`)
          await sleep(CFG.startWaitMs)
          const hc = await healthCheck()
          return sendJson(res, 200, { ...r, dshAfterStart: hc.ok ? 'running' : 'checking' })
        } finally { state.manualBusy = false }
      }
      if (pathname === '/api/start' && method === 'POST') {
        state.manualBusy = true
        try {
          const pid = await findDshPid()
          if (pid) return sendJson(res, 200, { ok: true, msg: `DSH 已在运行 (PID ${pid})` })
          startDsh()
          log('info', '手动启动 DSH')
          await sleep(CFG.startWaitMs)
          const hc = await healthCheck()
          return sendJson(res, 200, { ok: true, dshAfterStart: hc.ok ? 'running' : 'starting' })
        } finally { state.manualBusy = false }
      }
      if (pathname === '/api/stop' && method === 'POST') {
        state.manualBusy = true
        try {
          const r = await stopDsh()
          state.dsh = 'stopped'
          return sendJson(res, 200, { ok: r })
        } finally { state.manualBusy = false }
      }
      if (pathname === '/api/rollback' && method === 'POST') {
        const body = await readBody(req)
        const reason = body.reason || 'manual-request'
        // 异步触发，立即返回
        autoRollback(reason)
        return sendJson(res, 200, { ok: true, msg: '自动回退已触发' })
      }
      if (pathname === '/api/check' && method === 'POST') {
        const hc = await healthCheck()
        return sendJson(res, 200, { ok: true, dsh: hc.ok ? 'running' : 'down' })
      }

      // ---- 静态页面 ----
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: `unknown ${pathname}` })
      return serveStatic(res, pathname)
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  })
}

// ============ 启动 ============

async function main() {
  const server = createServer()
  await new Promise((resolve) => server.listen(CFG.webPort, () => resolve()))
  log('info', `dsh-guardian 启动: 网页 http://127.0.0.1:${CFG.webPort}`)
  log('info', `监控 DSH ${CFG.dshHost}:${CFG.dshPort}, 失败阈值 ${CFG.failThreshold}, 间隔 ${CFG.checkIntervalMs}ms`)
  log('info', `快照源: ${SNAPSHOT_ROOT}`)

  // 立即做一次初始检查
  const hc = await healthCheck()
  if (hc.ok) {
    state.dsh = 'running'
    state.lastOkAt = new Date().toISOString()
    log('info', 'DSH 当前正常')
  } else {
    state.failCount = 1
    state.dsh = 'stopped'
    log('warn', 'DSH 当前不可达')
  }

  setInterval(tick, CFG.checkIntervalMs)
}

main().catch((e) => {
  console.error('dsh-guardian 启动失败:', e)
  process.exit(1)
})
