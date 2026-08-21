/**
 * dsh-git-rescue — GitHub REST API 推送层（token 方案）
 *
 * 为什么需要：部分环境（本机实测）git 缺少 git-remote-https 助手，任何 HTTPS git 操作
 * 直接失败。因此远端备份不依赖系统 git，改用 GitHub REST API：
 *
 *   git ls-files（本机索引）→ blobs → tree → commit → ref（main 分支 force 更新）
 *
 * 备份仓库存的是「当前状态快照 commit」，而非完整历史同步（v1 设计，历史由本机 git 保留）。
 * 仓库不存在时自动创建：<owner>/dsh-git-rescue-backup-<hostname>。
 */

import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import { hostname } from 'node:os'
import { runGit } from './git.js'
import { getDeviceId } from './device.js'

const API = 'https://api.github.com'
const MAX_RETRY = 3

/** 带重试的 GitHub API 调用（api.github.com 间歇性 503，需重试）。 */
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

/** 备份仓库默认名由 lib/device.js 提供（设备唯一 ID，与主机名无关）。 */

/** 确保备份仓库存在（不存在则创建，private）。 */
export async function ensureBackupRepo(token, owner, repo) {
  const check = await api(token, `/repos/${owner}/${repo}`)
  if (check.ok) return { ok: true, exists: true }
  const created = await api(token, '/user/repos', {
    method: 'POST',
    body: { name: repo, private: true, description: `DSH git-rescue 自动备份（${owner} 的机器 ${hostname()}）` },
  })
  if (created.ok || created.status === 422) return { ok: true, exists: false }
  return { ok: false, error: created.error }
}

/** 当前 main 分支头提交 sha；仓库无提交返回 null。 */
async function branchHeadSha(token, owner, repo) {
  const r = await api(token, `/repos/${owner}/${repo}/commits/main?per_page=1`)
  if (r.ok && r.data?.length) return r.data[0].sha
  return null
}

/** GitHub 的空仓库不允许直接建 blob/tree/commit（报 "Git Repository is empty"）。
 *  检查仓库是否有内容；为空则用 Contents API 种一个初始 README 提交。 */
async function ensureRepoSeeded(token, owner, repo) {
  const check = await api(token, `/repos/${owner}/${repo}/contents/`)
  if (check.ok) return { ok: true }
  if (check.status !== 404) return { ok: false, error: check.error }
  const seed = await api(token, `/repos/${owner}/${repo}/contents/README.md`, {
    method: 'PUT',
    body: {
      message: 'chore: init backup repo',
      content: Buffer.from(`# ${repo}\n\nDSH git-rescue 自动备份仓库（token 方案，快照推送）。\n`).toString('base64'),
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
 * 推送当前快照到备份仓库 main 分支。
 * @param token GitHub token
 * @param owner 账号（默认从 token 探测）
 * @param repoDir 本地 git 仓库目录（用 git ls-files 取文件集）
 * @param message commit message
 */
export async function pushSnapshot(token, owner, repo, repoDir, message) {
  // 1. 验证 token 并解析 owner
  const who = await verifyToken(token)
  if (!who.ok) return { ok: false, error: `token 无效: ${who.error}` }
  const effectiveOwner = owner || who.login

  // 2. 确保备份仓库存在
  const ensure = await ensureBackupRepo(token, effectiveOwner, repo)
  if (!ensure.ok) return { ok: false, error: `备份仓库创建失败: ${ensure.error}` }

  // 2.5 空仓库先 seed（GitHub 不允许在无提交仓库上建 blob）
  const seeded = await ensureRepoSeeded(token, effectiveOwner, repo)
  if (!seeded.ok) return { ok: false, error: `备份仓库初始化失败: ${seeded.error}` }

  // 2.6 提前取父提交（放在建 blob 前，失败重试不阻塞后续；若为 null 则生成孤儿提交，靠 force 覆盖）
  const parentSha = await branchHeadSha(token, effectiveOwner, repo)

  // 3. git ls-files 取文件集（只推索引中的文件，天然排除 .gitignore 内容）
  const ls = await runGit(['ls-files'], { cwd: repoDir })
  if (!ls.ok) return { ok: false, error: `git ls-files 失败: ${ls.stderr}` }
  const files = ls.stdout.split('\n').filter(Boolean)
  if (files.length === 0) return { ok: false, error: '本地仓库没有跟踪文件，无可推送' }

  // 4. 逐个上传 blob
  const entries = []
  for (const rel of files) {
    try {
      const abs = join(repoDir, rel)
      const st = await fs.lstat(abs)
      let buf
      if (st.isSymbolicLink()) buf = Buffer.from(await fs.readlink(abs), 'utf8')   // 软链推链接文本（git 同语义）
      else if (st.isFile()) buf = await fs.readFile(abs)
      else continue                                                                // 目录等非常规条目跳过（避免 EISDIR）
      const sha = await createBlob(token, effectiveOwner, repo, buf)
      entries.push({ path: rel, mode: st.isSymbolicLink() ? '120000' : '100644', type: 'blob', sha })
    } catch (e) {
      return { ok: false, error: `上传 ${rel} 失败: ${String(e?.message ?? e)}` }
    }
  }

  // 5. 构建 tree
  const treeRes = await api(token, `/repos/${effectiveOwner}/${repo}/git/trees`, {
    method: 'POST',
    body: { tree: entries },
  })
  if (!treeRes.ok) return { ok: false, error: `tree 构建失败: ${treeRes.error}` }

  // 6. 创建 commit（继承父提交保持线性历史）
  const commitBody = { message, tree: treeRes.data.sha }
  if (parentSha) commitBody.parents = [parentSha]
  const commitRes = await api(token, `/repos/${effectiveOwner}/${repo}/git/commits`, {
    method: 'POST',
    body: commitBody,
  })
  if (!commitRes.ok) return { ok: false, error: `commit 创建失败: ${commitRes.error}` }

  // 7. 更新 main 分支引用：PATCH force 优先（ref 存在），404 则 POST 创建
  const refPath = `/repos/${effectiveOwner}/${repo}/git/refs/heads/main`
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
    repo,
    commit: commitRes.data.sha,
    files: files.length,
    url: `https://github.com/${effectiveOwner}/${repo}`,
  }
}
