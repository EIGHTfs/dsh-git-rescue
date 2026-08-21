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
import { AUTO_UPDATE_ENABLED, UPDATE_INTERVAL_MS, checkForUpdate, applyUpdate } from './self-update.js'

export const name = 'dsh-git-rescue'
export const inject = ['webServer']

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
// DSH_HOME 存在时优先（测试实例隔离、多 profile 场景均依赖它）
const DSH_ROOT = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_ROOT = join(DSH_ROOT, 'git-rescue')
const CONFIG_PATH = join(STATE_ROOT, 'config.json')
const TOKEN_PATH = join(STATE_ROOT, 'token')
const HEARTBEAT_PATH = join(STATE_ROOT, 'heartbeat')
const EVENTS_PATH = join(STATE_ROOT, 'events.jsonl')

/** .dsh 仓库的 .gitignore（配置+会话+skills 入库，敏感/大文件/缓存排除）。 */
const DSH_GITIGNORE = [
  'node_modules/',
  'profiles/*/node_modules/',
  '.credentials.yaml',
  '.env',
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
  workspaceEnabled: false,
  workspaceDir: '',
  workspaceWhitelist: [],
}

// ---------- 状态 ----------
let cfg = { ...DEFAULT_CONFIG }
let heartbeatTimer = null
let autoCommitTimer = null
let autoUpdateTimer = null
let lastCrashDetectedAt = null
let autoUpdateState = { enabled: AUTO_UPDATE_ENABLED, lastCheckAt: null, lastResult: null, pendingRestart: false }

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
  try { return (await fs.readFile(TOKEN_PATH, 'utf8')).trim() } catch { return '' }
}

async function writeToken(token) {
  await fs.mkdir(STATE_ROOT, { recursive: true })
  await fs.writeFile(TOKEN_PATH, String(token).trim(), { mode: 0o600 })
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
    repos: {
      dsh: { root: DSH_ROOT, repo: await isRepo(DSH_ROOT), head: dshHead, changed: dshStatus.changed },
      workspace: ws ? { root: ws, repo: await isRepo(ws), head: await headRef(ws), changed: (await status(ws)).changed } : null,
    },
    heartbeat: heartbeat ? { ageMs: Date.now() - heartbeat.ts, ok: Date.now() - heartbeat.ts < (cfg.heartbeatMs * 3 || 90000) } : null,
    config: { ...cfg },
    lastCrashDetectedAt,
    autoUpdate: { ...autoUpdateState },
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
    return true
  }
  return false
}

// ---------- 回退 ----------

/** 回退某个仓库到指定 ref：先 commit 现场 + 打 bad 标记，再 reset --hard。 */
async function rollbackRepo(dir, ref, which) {
  // 1) 先 commit 坏现场（生成的提交 = 坏提交，事后可分析）
  await commit(dir, `chore(guard): pre-rollback backup | ${which} @ ${await headRef(dir) ?? 'no-head'}`)
  // 2) 给【坏提交】（刚生成的 HEAD）打 bad 标记，而不是给目标 ref 打
  const brokenHead = await headRef(dir)
  if (brokenHead) await markBad(dir, brokenHead)
  // 3) 回退
  const r = await hardReset(dir, ref)
  if (!r.ok) return r
  await appendEvent('rollback', { repo: which, from: brokenHead, to: ref })
  return { ok: true, from: brokenHead, to: ref }
}

/** 自动回退到最后一个好提交（guardian 调用，或手动 API 触发）。 */
async function autoRollback(which = 'dsh') {
  const dir = which === 'workspace' ? wsRepoDir() : DSH_ROOT
  if (!dir) return { ok: false, error: 'workspace 未启用' }
  const good = await lastGoodCommit(dir)
  if (!good) return { ok: false, error: '没有可回退的好提交（仓库无提交或全部被标记 bad）' }
  const res = await rollbackRepo(dir, good, which)
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
}

function stopTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (autoCommitTimer) clearInterval(autoCommitTimer)
  if (autoUpdateTimer) clearInterval(autoUpdateTimer)
  heartbeatTimer = autoCommitTimer = autoUpdateTimer = null
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
    return send(res, 200, { ok: true, config: { ...cfg, githubTokenSet: !!t, githubToken: maskToken(t) } })
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
    const r = await autoRollback(body?.repo || 'dsh')
    return r.ok ? send(res, 200, r) : send(res, 400, r)
  }

  if (method === 'POST' && path === '/api/git-rescue/heartbeat') {
    return send(res, 200, { ok: true, heartbeat: await writeHeartbeat() })
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
      return `git: ${g.version || '不可用'}${g.httpsHelperMissing ? ' (https 助手缺失→推送走 REST API)' : ''}\n` +
        `.dsh 仓库: ${s.repos.dsh.repo ? '已初始化' : '未初始化'}${s.repos.dsh.head ? ` @ ${s.repos.dsh.head}` : ''}${s.repos.dsh.changed ? `, ${s.repos.dsh.changed} 项未提交` : ''}\n` +
        (s.repos.workspace ? `workspace 仓库: ${s.repos.workspace.repo ? '已初始化' : '未初始化'}${s.repos.workspace.head ? ` @ ${s.repos.workspace.head}` : ''}\n` : '') +
        `心跳: ${s.heartbeat ? (s.heartbeat.ok ? '正常' : '过期') : '无'}\n` +
        auLine
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
      const r = await autoRollback('dsh')
      return r.ok ? `已回退 ${r.from || '?'} → ${r.to}` : `回退失败: ${r.error}`
    }))
    tools.register(defineToolSimple('git_rescue_push', '推送当前快照到 GitHub 备份仓库（token 方案）', async () => {
      const token = await readToken()
      if (!token) return '未配置 GitHub token'
      const repo = cfg.githubRepo || (await defaultBackupRepo(STATE_ROOT))
      const r = await pushSnapshot(token, cfg.githubOwner || '', repo, DSH_ROOT, `dsh-git-rescue backup @ ${ts()}`)
      return r.ok ? `已推送 ${r.files} 个文件 → ${r.url} (${r.commit.slice(0, 8)})` : `推送失败: ${r.error}`
    }))
  }

  // 启动流程：崩溃检测 → 心跳 → 定时器
  await fs.mkdir(STATE_ROOT, { recursive: true }).catch(() => {})
  await detectCrashOnStartup()
  await writeHeartbeat()
  startTimers()
  await appendEvent('startup', { pid: process.pid })

  // 自动更新：启动后 30s 首次检查（不阻塞启动；失败不影响主流程）
  if (AUTO_UPDATE_ENABLED) {
    setTimeout(() => { runAutoUpdateCheck().catch(() => {}) }, 30_000).unref?.()
  }

  const gv = await gitVersion()
  console.log(`[git-rescue] 已启动: git=${gv || '不可用'}, dshRoot=${DSH_ROOT}, workspace=${wsRepoDir() || '未启用'}, autoUpdate=${AUTO_UPDATE_ENABLED ? 'ON(强制)' : 'OFF(env)'}`)
}
