/**
 * dsh-git-rescue 2.0.0 — GitHub 远端备份层（仅 token 方案）
 *
 * ② 备份到 GitHub 私有库，仓库名 dsh-git-rescue-backup-<设备ID前12位>（由 lib/device.js 生成）。
 * 认证：仅 GitHub token（2026-08-21 用户决定：删除 SSH key 方案，只走 token）。
 * 全部失败返回明确错误，不静默。
 */

import { promises as fs } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { runGit } from './git.js'

const API = 'https://api.github.com'
const MAX_RETRY = 3

/** 带重试的 GitHub API 调用（api.github.com 间歇性 503/429，需重试）。 */
async function api(token, path, { method = 'GET', body } = {}) {
  let lastErr
  for (let i = 0; i < MAX_RETRY; i++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
      if (res.status === 204) return { ok: true, data: null }
      if (res.status >= 200 && res.status < 300) return { ok: true, data: json }
      if (res.status === 404) return { ok: false, status: 404, error: json?.message ?? 'not found' }
      if (res.status >= 500 || res.status === 429) { lastErr = `HTTP ${res.status}: ${json?.message ?? text.slice(0, 120)}`; continue }
      return { ok: false, status: res.status, error: json?.message ?? text.slice(0, 200) }
    } catch (e) {
      lastErr = String(e?.message ?? e)
    }
  }
  return { ok: false, error: `重试 ${MAX_RETRY} 次仍失败: ${lastErr}` }
}

/** 验证 token 归属（GET /user）。 */
export async function verifyToken(token) {
  const r = await api(token, '/user')
  return r.ok ? { ok: true, login: r.data?.login } : { ok: false, error: r.error, status: r.status }
}

/** 确保远端仓库存在（不存在则创建，private）。GitHub 不允许仓名以点开头时自动降级。 */
export async function ensureBackupRepo(token, owner, repo) {
  // GitHub 仓库名不允许以 "." 开头（API 会报 invalid name）
  // 去掉开头的 "." → dsh@0.1.0-rc.6.87566bf2a1c8（合法）
  const safeRepo = repo.startsWith('.') ? repo.slice(1) : repo
  const check = await api(token, `/repos/${owner}/${safeRepo}`)
  if (check.ok) return { ok: true, exists: true, repo: safeRepo, renamed: safeRepo !== repo }
  if (check.status === 404) {
    const created = await api(token, '/user/repos', {
      method: 'POST',
      body: { name: safeRepo, private: true, description: `DSH 救援自动备份（${owner} 的设备，仓名规范 .dsh@<dsh版本>.<设备ID>）` },
    })
    if (created.ok || created.status === 422) return { ok: true, exists: false, repo: safeRepo, renamed: safeRepo !== repo }
    return { ok: false, error: created.error }
  }
  return { ok: false, error: check.error }
}

/** 当前 main 分支头提交 sha；仓库无提交返回 null。 */
async function branchHeadSha(token, owner, repo) {
  const r = await api(token, `/repos/${owner}/${repo}/commits/main?per_page=1`)
  if (r.ok && r.data?.length) return r.data[0].sha
  return null
}

/** 空仓库用 Contents API 种一个初始 README 提交（GitHub 不允许在无提交仓库上建 blob）。 */
async function ensureRepoSeeded(token, owner, repo) {
  const check = await api(token, `/repos/${owner}/${repo}/contents/`)
  if (check.ok) return { ok: true }
  if (check.status !== 404) return { ok: false, error: check.error }
  const seed = await api(token, `/repos/${owner}/${repo}/contents/README.md`, {
    method: 'PUT',
    body: {
      message: 'chore: init backup repo',
      content: Buffer.from(`# ${repo}\n\nDSH 救援自动备份仓库（token 方案，快照推送）。\n`).toString('base64'),
    },
  })
  return seed.ok ? { ok: true } : { ok: false, error: seed.error }
}

/** 创建 blob 并返回 sha。 */
async function createBlob(token, owner, repo, content) {
  const r = await api(token, `/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: { content: content.toString('base64'), encoding: 'base64' },
  })
  if (!r.ok) throw new Error(`blob 失败: ${r.error}`)
  return r.data.sha
}

/**
 * token 方案：REST API 快照推送（git ls-files → blobs → tree → commit → ref）。
 * @param token GitHub token
 * @param owner 账号
 * @param repo 远端仓名
 * @param repoDir 本地 git 仓库目录
 * @param message commit message
 * @param pathPrefix 远端路径前缀（如设备ID文件夹 <deviceId>/，2026-08-21 用户决定）
 */
export async function pushViaToken(token, owner, repo, repoDir, message, pathPrefix = '', onlyPaths = null) {
  const who = await verifyToken(token)
  if (!who.ok) return { ok: false, error: `token 无效: ${who.error}` }
  const effectiveOwner = owner || who.login

  const ensure = await ensureBackupRepo(token, effectiveOwner, repo)
  if (!ensure.ok) return { ok: false, error: `备份仓库创建失败: ${ensure.error}` }
  const safeRepo = ensure.repo

  const seeded = await ensureRepoSeeded(token, effectiveOwner, safeRepo)
  if (!seeded.ok) return { ok: false, error: `备份仓库初始化失败: ${seeded.error}` }

  const parentSha = await branchHeadSha(token, effectiveOwner, safeRepo)

  const ls = await runGit(['ls-files'], { cwd: repoDir })
  if (!ls.ok) return { ok: false, error: `git ls-files 失败: ${ls.stderr}` }
  let files = ls.stdout.split('\n').filter(Boolean)
  // 只推选中路径（onlyPaths 前缀匹配；如 ['profiles','skills']），排除未选中项
  if (onlyPaths && onlyPaths.length) {
    const keep = (rel) => onlyPaths.some((p) => rel === p || rel.startsWith(p + '/'))
    files = files.filter(keep)
    // 排除 node_modules / hoisted-bak 等大目录（保留 node_modules_local 插件源码）
    files = files.filter((rel) => !/(^|\/)node_modules(\/|$)/.test(rel) && !rel.includes('hoisted-bak'))
  }
  if (files.length === 0) return { ok: false, error: '本地仓库没有跟踪文件，无可推送' }

  // 远端路径前缀（<deviceId>/），去首尾斜杠
  const prefix = pathPrefix ? String(pathPrefix).replace(/^\/+|\/+$/g, '') + '/' : ''

  const entries = []
  for (const rel of files) {
    try {
      const abs = join(repoDir, rel)
      const st = await fs.lstat(abs)
      let buf
      if (st.isSymbolicLink()) buf = Buffer.from(await fs.readlink(abs), 'utf8')
      else if (st.isFile()) buf = await fs.readFile(abs)
      else continue
      const sha = await createBlob(token, effectiveOwner, safeRepo, buf)
      entries.push({ path: prefix + rel, mode: st.isSymbolicLink() ? '120000' : '100644', type: 'blob', sha })
    } catch (e) {
      return { ok: false, error: `上传 ${rel} 失败: ${String(e?.message ?? e)}` }
    }
  }

  const treeRes = await api(token, `/repos/${effectiveOwner}/${safeRepo}/git/trees`, {
    method: 'POST',
    body: { tree: entries },
  })
  if (!treeRes.ok) return { ok: false, error: `tree 构建失败: ${treeRes.error}` }

  const commitBody = { message, tree: treeRes.data.sha }
  if (parentSha) commitBody.parents = [parentSha]
  const commitRes = await api(token, `/repos/${effectiveOwner}/${safeRepo}/git/commits`, {
    method: 'POST',
    body: commitBody,
  })
  if (!commitRes.ok) return { ok: false, error: `commit 创建失败: ${commitRes.error}` }

  const refPath = `/repos/${effectiveOwner}/${safeRepo}/git/refs/heads/main`
  let upd = await api(token, refPath, { method: 'PATCH', body: { sha: commitRes.data.sha, force: true } })
  if (!upd.ok) {
    if (upd.status === 404) {
      upd = await api(token, refPath, { method: 'POST', body: { ref: 'refs/heads/main', sha: commitRes.data.sha } })
      if (!upd.ok) return { ok: false, error: `分支创建失败: ${upd.error}` }
    } else {
      return { ok: false, error: `分支更新失败: ${upd.error}` }
    }
  }

  return {
    ok: true,
    owner: effectiveOwner,
    repo: safeRepo,
    commit: commitRes.data.sha,
    files: files.length,
    url: `https://github.com/${effectiveOwner}/${safeRepo}`,
    method: 'token',
  }
}

/**
 * 统一入口：仅 token 方案（2026-08-21 用户决定删除 SSH key，只走 token）。
 * @returns {{ok:boolean, method:'token'|null, error?:string, ...}}
 */
export async function pushSnapshot({ token = '', owner = '', repo, repoDir, message, pathPrefix = '', onlyPaths = null }) {
  if (!token) return { ok: false, error: '无可用认证：GitHub token 未配置' }
  return pushViaToken(token, owner, repo, repoDir, message, pathPrefix, onlyPaths)
}

/**
 * 拉取方案（2026-08-21 用户决定：从远端备份库下载恢复）。
 * 走 GitHub Contents API（github.com:443 不通，只能 api.github.com REST）。
 */

/** 递归列出远端仓库某路径下所有文件（含子目录），返回 [{path, size}]。 */
async function listRemoteFiles(token, owner, repo, prefix = '', depth = 0) {
  const out = []
  const dirPath = prefix ? encodeURIComponent(prefix) : ''
  const r = await api(token, `/repos/${owner}/${repo}/contents/${dirPath}?ref=main`)
  if (!r.ok) return { ok: false, error: r.error }
  if (!Array.isArray(r.data)) {
    // 单文件（路径直接是文件）
    if (r.data?.type === 'file') return { ok: true, files: [{ path: r.data.path, size: r.data.size || 0 }] }
    return { ok: true, files: [] }
  }
  for (const item of r.data) {
    if (item.type === 'file') {
      out.push({ path: item.path, size: item.size || 0 })
    } else if (item.type === 'dir' && depth < 10) {
      const sub = await listRemoteFiles(token, owner, repo, item.path, depth + 1)
      if (sub.ok) out.push(...sub.files)
      else return sub
    }
  }
  return { ok: true, files: out }
}

/** 下载单个远端文件内容（Contents API raw；>1MB 走 blob API 兜底）。 */
async function downloadRemoteFile(token, owner, repo, path) {
  const enc = encodeURIComponent(path)
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${enc}?ref=main`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (res.ok) return { ok: true, buf: Buffer.from(await res.arrayBuffer()) }
  // >1MB 文件 Contents raw 返回 413，走 git blob
  const blob = await api(token, `/repos/${owner}/${repo}/git/blobs/${enc}`)
  if (blob.ok && blob.data?.content) {
    return { ok: true, buf: Buffer.from(blob.data.content, blob.data.encoding === 'base64' ? 'base64' : 'utf8') }
  }
  return { ok: false, error: `下载 ${path} 失败: HTTP ${res.status}` }
}

/**
 * 从远端备份库拉取某设备目录，写入本地 destDir（.dsh）。
 * 远端结构：<deviceId>/<相对路径>（与 push 的 pathPrefix 对应）。
 * @param {object} opts { token, owner, repo, deviceId, destDir, dryRun }
 * @returns {Promise<{ok:boolean, files?:number, list?:Array, restored?:Array, error?:string}>}
 */
export async function fetchBackupSnapshot({ token = '', owner = '', repo, deviceId, destDir, dryRun = false }) {
  if (!token) return { ok: false, error: '无可用认证：GitHub token 未配置' }
  const effectiveOwner = owner || 'EIGHTfs'
  // 1) 递归列远端 <deviceId>/ 下所有文件
  const listing = await listRemoteFiles(token, effectiveOwner, repo, deviceId || '')
  if (!listing.ok) return { ok: false, error: `列远端目录失败: ${listing.error}` }
  const files = listing.files.filter((f) => f.path !== 'README.md')
  if (files.length === 0) return { ok: false, error: `远端 ${deviceId}/ 下无备份文件` }
  // 2) 逐个下载（dryRun 只列不写）
  const restored = []
  const destAbs = resolve(destDir)
  for (const f of files) {
    // 去掉 <deviceId>/ 前缀得到相对 .dsh 路径
    const rel = f.path.startsWith(deviceId + '/') ? f.path.slice(deviceId.length + 1) : f.path
    const target = resolve(destAbs, rel)
    // 路径安全：必须仍在 destDir 内
    if (target !== destAbs && !target.startsWith(destAbs + sep)) {
      return { ok: false, error: `路径越界拒绝: ${rel}` }
    }
    if (dryRun) { restored.push({ rel, size: f.size, dry: true }); continue }
    const dl = await downloadRemoteFile(token, effectiveOwner, repo, f.path)
    if (!dl.ok) return { ok: false, error: dl.error }
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, dl.buf, { mode: 0o600 })
    restored.push({ rel, size: dl.buf.length })
  }
  return { ok: true, files: files.length, restored, dryRun }
}
