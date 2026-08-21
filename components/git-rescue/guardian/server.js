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
import { spawn } from 'node:child_process'
import http from 'node:http'
import { runGit, commit, headRef, markBad, lastGoodCommit, hardReset } from '../lib/git.js'

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
}

const LOG_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-dsh.log')
const EVENTS_FILE = join(CFG.dshHome, 'git-rescue', 'guardian-events.jsonl')

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
}

function log(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg }
  state.log.push(entry)
  if (state.log.length > 500) state.log = state.log.slice(-500)
  console.log(`[${entry.time.slice(11, 19)}][${level}] ${msg}`)
  fs.appendFile(EVENTS_FILE, JSON.stringify(entry) + '\n').catch(() => {})
}

// ============ DSH 健康检查 ============

async function probeDsh() {
  try {
    const res = await fetch(`http://${CFG.dshHost}:${CFG.dshPort}/`, {
      signal: AbortSignal.timeout(5000),
    })
    return res.status >= 200 && res.status < 500
  } catch { return false }
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
  const child = spawn('sh', ['-c', `${cmd} >> "${LOG_FILE}" 2>&1 &`], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
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
      if (await probeDsh()) { ok = true; break }
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
  const ok = await probeDsh()
  if (ok) {
    if (state.dsh !== 'running') log('info', 'DSH 恢复健康')
    state.dsh = 'running'
    state.lastOkAt = Date.now()
    state.failCount = 0
    return
  }
  state.lastErrorAt = Date.now()
  state.failCount += 1
  log('warn', `健康检查失败（连续 ${state.failCount}/${CFG.failThreshold}）`)
  if (state.failCount >= CFG.failThreshold) {
    if (CFG.autoRecover) {
      state.failCount = 0
      await recover()
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
