/**
 * dsh-git-rescue 2.0.0 — GitHub 远端备份层（token / SSH key 双方案）
 *
 * ② 备份到 GitHub 私有库，仓库名 .dsh@<dsh版本>.<设备ID>（由 lib/device.js 生成）。
 * 认证双方案：
 *  1. SSH key 优先（~/.ssh 下有可用的 id_* key）：本地 git remote + push，走 git 原生传输
 *  2. GitHub token 兜底：REST API 快照推送（git-remote-https 缺失环境仍可用）
 * 全部失败返回明确错误，不静默。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
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
  const safeRepo = repo.startsWith('.') ? `dsh-at-${repo.slice(1)}` : repo
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

/** 探测 SSH key 是否可用（存在且非空）。 */
export async function sshKeyAvailable() {
  try {
    const sshDir = join(homedir(), '.ssh')
    const entries = await fs.readdir(sshDir).catch(() => [])
    for (const e of entries) {
      if (e.startsWith('id_') && !e.endsWith('.pub') && !e.includes('known')) {
        const p = join(sshDir, e)
        const st = await fs.stat(p).catch(() => null)
        if (st?.size > 0) return true
      }
    }
  } catch { /* 无 .ssh 目录 */ }
  return false
}

/** SSH 方案：本地 git remote + push（依赖 git 原生 SSH 传输）。 */
export async function pushViaSsh(repoDir, owner, repo, message) {
  const sshUrl = `git@github.com:${owner}/${repo}.git`
  // 1) remote 指向（已存在则更新 URL）
  const remoteSet = await runGit(['remote', 'set-url', 'origin', sshUrl], { cwd: repoDir })
  if (!remoteSet.ok) {
    const add = await runGit(['remote', 'add', 'origin', sshUrl], { cwd: repoDir })
    if (!add.ok) return { ok: false, error: `remote 设置失败: ${add.stderr}` }
  }
  // 2) 确保有提交可推（空仓先建基线）
  const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: repoDir })
  if (!head.ok) {
    const seed = await runGit(['commit', '--allow-empty', '-m', 'chore: init rescue backup'], { cwd: repoDir })
    if (!seed.ok) return { ok: false, error: `基线 commit 失败: ${seed.stderr}` }
  }
  // 3) push（远端可能已存在历史，force 保证快照一致性——本方案远端只做备份镜像）
  const push = await runGit(['push', '-f', 'origin', 'main'], { cwd: repoDir })
  if (!push.ok) return { ok: false, error: `SSH push 失败: ${push.stderr || push.stdout}` }
  return { ok: true, url: `https://github.com/${owner}/${repo}`, method: 'ssh' }
}

/**
 * token 方案：REST API 快照推送（git ls-files → blobs → tree → commit → ref）。
 * @param token GitHub token
 * @param owner 账号
 * @param repo 远端仓名（可带 . 前缀，自动降级）
 * @param repoDir 本地 git 仓库目录
 * @param message commit message
 */
export async function pushViaToken(token, owner, repo, repoDir, message) {
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
  const files = ls.stdout.split('\n').filter(Boolean)
  if (files.length === 0) return { ok: false, error: '本地仓库没有跟踪文件，无可推送' }

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
      entries.push({ path: rel, mode: st.isSymbolicLink() ? '120000' : '100644', type: 'blob', sha })
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
 * 统一入口：SSH key 可用优先走 SSH，否则 token。
 * @returns {{ok:boolean, method:'ssh'|'token'|null, error?:string, ...}}
 */
export async function pushSnapshot({ token = '', ssh = null, owner = '', repo, repoDir, message }) {
  const useSsh = ssh !== false && (await sshKeyAvailable())
  if (useSsh) {
    const r = await pushViaSsh(repoDir, owner || 'EIGHTfs', repo, message)
    if (r.ok) return r
    // SSH 失败且无 token → 报错；有 token → 降级 token 方案
    if (!token) return { ...r, method: 'ssh' }
  }
  if (!token) return { ok: false, error: '无可用认证：SSH key 与 GitHub token 均未配置' }
  return pushViaToken(token, owner, repo, repoDir, message)
}
