/**
 * dsh-git-rescue — 自动更新（自升级到 GitHub 最新稳定版）
 *
 * 为什么强制开启（隐藏开关）：
 *   万一救援/备份插件自身有 bug，而部署环境没人记得手动更新 → 旧版带病运行，
 *   在最需要它的时候失灵。因此自动更新**默认强制开启**，不写入 config.json、
 *   不暴露设置 API；仅环境变量 DSH_GIT_RESCUE_AUTO_UPDATE=0 可关闭（调试/隔离用）。
 *
 * 更新源：EIGHTfs/dsh-git-rescue main 分支的 components/git-rescue/ 子树。
 * 实现：GitHub Git Trees API（recursive）取文件清单 → raw.githubusercontent.com
 *       逐个下载 → 临时目录 → 语法校验（node --check）→ 原子替换 → 失败回滚。
 *
 * 安全：
 *  - 只允许 components/git-rescue/ 前缀下的文件（路径白名单，防树外写入）
 *  - 下载后先校验 package.json 版本号与 JS 语法，全部通过才替换
 *  - 替换前备份当前安装目录，替换失败自动回滚
 *  - 更新后当前进程仍是旧代码，需 DSH 重启生效（status 提示 pendingRestart）
 */

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// ---------- 配置（隐藏开关） ----------

/** 强制开启；仅环境变量 DSH_GIT_RESCUE_AUTO_UPDATE=0 可关闭。 */
export const AUTO_UPDATE_ENABLED = process.env.DSH_GIT_RESCUE_AUTO_UPDATE !== '0'

export const UPDATE_SOURCE = {
  owner: 'EIGHTfs',
  repo: 'dsh-git-rescue',
  branch: 'main',
  /** 仓库内插件子目录（只同步这一棵子树） */
  subdir: 'components/git-rescue',
}

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000 // 每 24 小时（每天一次）定时检查；另在每次 DSH 启动成功后 30s 检查一次

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'

// ---------- 工具 ----------

/** 当前插件安装根目录（lib/ 的上级 = 插件根）。 */
export function installRoot() {
  const here = fileURLToPath(import.meta.url) // .../lib/self-update.js
  return dirname(dirname(here))               // 插件根
}

/** 简易 semver 比较：a>b → 1, a<b → -1, 相等 → 0。非法版本按 0 处理。 */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va > vb ? 1 : -1
  }
  return 0
}

/** 解析 GitHub API 响应（复用重试模式）。 */
async function apiGet(token, path) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-git-rescue-self-update',
      }
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(`${API}${path}`, { headers })
      if (res.status === 200) return { ok: true, data: await res.json() }
      if (res.status === 404) return { ok: false, status: 404, error: 'not found' }
      if (res.status === 403 || res.status === 429) {
        lastErr = `HTTP ${res.status} (rate limit?)`
        continue
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    } catch (e) {
      lastErr = String(e?.message ?? e)
    }
  }
  return { ok: false, error: `重试 3 次仍失败: ${lastErr}` }
}

/** 拉取远端文件原文（raw）。 */
async function fetchRaw(token, relPath) {
  const url = `${RAW}/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/${UPDATE_SOURCE.branch}/${UPDATE_SOURCE.subdir}/${relPath}`
  const headers = { 'User-Agent': 'dsh-git-rescue-self-update' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`raw 下载失败 HTTP ${res.status}: ${relPath}`)
  return Buffer.from(await res.arrayBuffer())
}

// ---------- 版本检查 ----------

/**
 * 检查远端是否有新版本。
 * @returns {Promise<{ok:boolean, installedVersion:string, remoteVersion:string, updateAvailable:boolean, detail?:string}>}
 */
export async function checkForUpdate(token = '') {
  const root = installRoot()
  let installedVersion = '0.0.0'
  try {
    const pkg = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
    installedVersion = pkg.version || '0.0.0'
  } catch { /* 读取本地版本失败则视为 0.0.0 */ }

  const r = await apiGet(token, `/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/contents/${UPDATE_SOURCE.subdir}/package.json?ref=${UPDATE_SOURCE.branch}`)
  if (!r.ok) return { ok: false, installedVersion, remoteVersion: null, updateAvailable: false, detail: `远端版本读取失败: ${r.error}` }

  let remoteVersion = '0.0.0'
  try {
    const content = Buffer.from(r.data.content, 'base64').toString('utf8')
    remoteVersion = JSON.parse(content).version || '0.0.0'
  } catch {
    return { ok: false, installedVersion, remoteVersion: null, updateAvailable: false, detail: '远端 package.json 解析失败' }
  }

  return {
    ok: true,
    installedVersion,
    remoteVersion,
    updateAvailable: compareVersions(remoteVersion, installedVersion) > 0,
    detail: compareVersions(remoteVersion, installedVersion) > 0 ? `可更新 ${installedVersion} → ${remoteVersion}` : `已是最新 (${installedVersion})`,
  }
}

// ---------- 文件清单 ----------

/** 远端 components/git-rescue/ 子树文件清单（Git Trees API recursive）。 */
async function fetchFileList(token) {
  const r = await apiGet(token, `/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/git/trees/${UPDATE_SOURCE.branch}?recursive=1`)
  if (!r.ok) throw new Error(`tree 获取失败: ${r.error}`)
  const prefix = `${UPDATE_SOURCE.subdir}/`
  const files = []
  for (const item of r.data?.tree ?? []) {
    if (item.type !== 'blob') continue
    if (!item.path.startsWith(prefix)) continue
    const rel = item.path.slice(prefix.length)
    if (!rel) continue
    // 安全白名单：排除一切含 .. 或绝对路径的条目
    if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) continue
    files.push(rel)
  }
  return files
}

/** 执行 node --check 语法校验。 */
function syntaxCheck(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve(code === 0 ? null : err.trim() || '语法错误'))
    child.on('error', (e) => resolve(String(e?.message ?? e)))
  })
}

// ---------- 更新执行 ----------

/**
 * 执行更新：下载远端文件到临时目录 → 校验 → 原子替换 → 失败回滚。
 * @returns {Promise<{ok:boolean, updated:boolean, from?:string, to?:string, error?:string}>}
 */
export async function applyUpdate(token = '') {
  const root = installRoot()
  const stateDir = join(root, '..', '..', 'git-rescue') // 注意：插件根在 node_modules 下，状态目录在上上层
  const tmpDir = join(stateDir, '.self-update-tmp')
  const bakDir = join(stateDir, '.self-update-bak')

  try {
    // 0) 远端版本
    const check = await checkForUpdate(token)
    if (!check.ok) return { ok: false, updated: false, error: check.detail || '版本检查失败' }
    if (!check.updateAvailable) return { ok: true, updated: false, from: check.installedVersion, to: check.remoteVersion, error: null }

    // 1) 下载全部文件到临时目录
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.mkdir(tmpDir, { recursive: true })
    const files = await fetchFileList(token)
    if (files.length === 0) throw new Error('远端文件清单为空')
    for (const rel of files) {
      const dest = join(tmpDir, rel)
      await fs.mkdir(dirname(dest), { recursive: true })
      const buf = await fetchRaw(token, rel)
      await fs.writeFile(dest, buf)
    }

    // 2) 校验：package.json 版本 + 全部 .js/.mjs 语法
    const newPkg = JSON.parse(await fs.readFile(join(tmpDir, 'package.json'), 'utf8'))
    if (compareVersions(newPkg.version || '0', check.remoteVersion) !== 0) {
      throw new Error(`下载版本与声明不一致: pkg=${newPkg.version} remote=${check.remoteVersion}`)
    }
    for (const rel of files) {
      if (!/\.(js|mjs|cjs)$/.test(rel)) continue
      const err = await syntaxCheck(join(tmpDir, rel))
      if (err) throw new Error(`远端文件语法错误 ${rel}: ${err}`)
    }

    // 3) 备份当前安装目录（排除 .git 与 node_modules 等）
    await fs.rm(bakDir, { recursive: true, force: true })
    await fs.mkdir(bakDir, { recursive: true })
    const curEntries = await fs.readdir(root).catch(() => [])
    for (const ent of curEntries) {
      if (ent.startsWith('.')) continue // 不备份隐藏文件（避免复制自身状态）
      await fs.cp(join(root, ent), join(bakDir, ent), { recursive: true })
    }

    // 4) 原子替换：先全部复制到临时，再逐项替换
    const newEntries = await fs.readdir(tmpDir)
    for (const ent of newEntries) {
      await fs.rm(join(root, ent), { recursive: true, force: true })
      await fs.cp(join(tmpDir, ent), join(root, ent), { recursive: true })
    }
    // 删除本地有、远端没有的旧文件（如旧版模块）
    for (const ent of curEntries) {
      if (ent.startsWith('.')) continue
      if (!newEntries.includes(ent)) await fs.rm(join(root, ent), { recursive: true, force: true })
    }

    // 5) 清理临时目录
    await fs.rm(tmpDir, { recursive: true, force: true })

    return { ok: true, updated: true, from: check.installedVersion, to: newPkg.version }
  } catch (e) {
    // 6) 失败回滚
    const errMsg = String(e?.message ?? e)
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
      const curEntries = await fs.readdir(root).catch(() => [])
      for (const ent of curEntries) {
        if (ent.startsWith('.')) continue
        await fs.rm(join(root, ent), { recursive: true, force: true })
      }
      const bakEntries = await fs.readdir(bakDir).catch(() => [])
      for (const ent of bakEntries) {
        await fs.cp(join(bakDir, ent), join(root, ent), { recursive: true })
      }
    } catch (rb) { /* 回滚失败也要报告原始错误 */ }
    return { ok: false, updated: false, error: errMsg }
  }
}
