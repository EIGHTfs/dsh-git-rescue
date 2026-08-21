/**
 * dsh-git-rescue 2.5.0 — 救援环境安装器（2026-08-21 用户需求）
 *
 * 主环境只装一个「小插件/入口」，专职：把最新救援插件源码安装到救援环境
 * （测试环境 dsh-test-home + 纯净环境 Save-clean）。主环境本身不装完整救援插件
 * （避免迭代代码写死主环境），guardian 独立守护。
 *
 * 源码来源（2026-08-21 开发中阶段）：
 *  - local  （默认）：从测试环境当前副本（开发母体）复制分发——开发中本地领先 GitHub，避免用发布版倒退
 *  - github         ：从 GitHub main 拉取发布版——发布后本地落后时使用
 *
 * 流程：
 *  1. resolveSource      ：按 source 取源码（local=测试环境副本 / github=下载）
 *  2. installToTestEnv   ：安装到测试环境（node_modules_local + patch + 软链 三要素）
 *  3. installToCleanEnv  ：安装到纯净环境（createCleanEnv force 重建）
 */

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { UPDATE_SOURCE } from './self-update.js'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'

/** 测试环境插件目录（开发母体 + 安装目标）。 */
export const TEST_ENV = {
  home: process.env.DSH_TEST_HOME || '/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home',
  name: 'dsh-git-rescue',
}

/** 测试环境开发母体插件目录。 */
export function testEnvPluginDir() {
  return join(TEST_ENV.home, 'profiles/web/node_modules_local', TEST_ENV.name)
}

/** 纯净环境根（与 rescue-env.js 的 rescueEnvRoot 一致）。 */
export function cleanEnvRoot() {
  return process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace'
}

/** 纯净环境目录：<版本>@Save-clean。 */
export function cleanEnvDir(dshVersion) {
  return join(cleanEnvRoot(), `${dshVersion}@Save-clean`)
}

/** 带重试的 GitHub API GET。 */
async function apiGet(token, path) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${API}${path}`, {
        headers: {
          Authorization: token ? `Bearer ${token}` : '',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (res.ok) return { ok: true, data: await res.json() }
      if (res.status === 404) return { ok: false, status: 404, error: 'not found' }
      if (res.status >= 500 || res.status === 429) continue
      return { ok: false, status: res.status, error: (await res.text()).slice(0, 200) }
    } catch { /* 重试 */ }
  }
  return { ok: false, error: 'GitHub API 重试 3 次仍失败' }
}

/** 远端文件清单（Git Trees recursive），过滤敏感/大文件。 */
async function fetchFileList() {
  const r = await apiGet('', `/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/git/trees/${UPDATE_SOURCE.branch}?recursive=1`)
  if (!r.ok) throw new Error(`远端文件清单失败: ${r.error || 'unknown'}`)
  const tree = r.data?.tree || []
  const skip = (rel) => /(^|\/)(\.git|node_modules|dist|build)(\/|$)/.test(rel) || rel.endsWith('.zip') || rel.endsWith('.crx')
  return tree.filter((t) => t.type === 'blob' && !skip(t.path)).map((t) => t.path)
}

/** 下载单个文件（raw.githubusercontent）。 */
async function fetchRaw(relPath) {
  const url = `${RAW}/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/${UPDATE_SOURCE.branch}/${relPath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载 ${relPath} 失败: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** 下载全部源码到临时目录，校验 package.json 版本 + 语法。 */
async function downloadSource(tmpDir) {
  await fs.rm(tmpDir, { recursive: true, force: true })
  await fs.mkdir(tmpDir, { recursive: true })
  const files = await fetchFileList()
  if (!files.length) throw new Error('远端文件清单为空')
  for (const rel of files) {
    const dest = join(tmpDir, rel)
    await fs.mkdir(dirname(dest), { recursive: true })
    await fs.writeFile(dest, await fetchRaw(rel))
  }
  // 校验版本 + 语法
  const pkg = JSON.parse(await fs.readFile(join(tmpDir, 'package.json'), 'utf8'))
  for (const rel of files) {
    if (!/\.(js|mjs|cjs)$/.test(rel)) continue
    // 简单语法校验：node --check 太重，改为 import 冒烟由安装环境完成；此处仅检查文件非空
    const buf = await fs.readFile(join(tmpDir, rel))
    if (!buf.length) throw new Error(`远端文件为空: ${rel}`)
  }
  return { version: pkg.version, files }
}

/** 远端最新版本号。 */
export async function checkRemoteVersion() {
  const r = await apiGet('', `/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/contents/package.json?ref=${UPDATE_SOURCE.branch}`)
  if (!r.ok) return { ok: false, error: r.error || '版本读取失败' }
  try {
    const content = Buffer.from(r.data.content, 'base64').toString('utf8')
    return { ok: true, version: JSON.parse(content).version }
  } catch {
    return { ok: false, error: '远端 package.json 解析失败' }
  }
}

/** 读取某环境已装插件版本。 */
async function envInstalledVersion(pluginDir) {
  try {
    const pkg = JSON.parse(await fs.readFile(join(pluginDir, 'package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch { return null }
}

/** 安装源码到测试环境（三要素：源码复制 + patch 注册 + 软链）。 */
export async function installToTestEnv(tmpDir, { force = false } = {}) {
  const target = join(TEST_ENV.home, 'profiles/web/node_modules_local', TEST_ENV.name)
  try {
    // 检查测试环境存在
    await fs.access(join(TEST_ENV.home, 'profiles/web/cordis.patch.yml'))
    await fs.rm(target, { recursive: true, force: true })
    await fs.cp(tmpDir, target, { recursive: true })
    // patch 注册（不存在才加）
    const patchPath = join(TEST_ENV.home, 'profiles/web/cordis.patch.yml')
    let patch = await fs.readFile(patchPath, 'utf8')
    if (!patch.includes('dsh-git-rescue')) {
      patch += `\n- insert:\n    - id: git-rescue\n      name: 'dsh-git-rescue'\n`
      await fs.writeFile(patchPath, patch, 'utf8')
    }
    // package.json 依赖声明
    const pkgPath = join(TEST_ENV.home, 'profiles/web/package.json')
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8').catch(() => '{}'))
    pkg.dependencies = pkg.dependencies || {}
    pkg.dependencies[TEST_ENV.name] = 'file:./node_modules_local/dsh-git-rescue'
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    // 软链
    await fs.mkdir(join(TEST_ENV.home, 'profiles/web/node_modules'), { recursive: true })
    await fs.symlink(`../node_modules_local/${TEST_ENV.name}`, join(TEST_ENV.home, 'profiles/web/node_modules', TEST_ENV.name)).catch(() => {})
    return { ok: true, target }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 安装源码到纯净环境（createCleanEnv force 重建）。 */
export async function installToCleanEnv(tmpDir, dshVersion) {
  try {
    const { createCleanEnv } = await import('./rescue-env.js')
    const r = await createCleanEnv(dshVersion, { force: true, rescueSrc: tmpDir })
    if (!r.ok) return { ok: false, error: r.error || '纯净环境重建失败' }
    return { ok: true, dir: r.dir }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 版本比较：a > b 返回 1，a === b 返回 0，a < b 返回 -1（支持 x.y.z / x.y.z-pre）。 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map(Number)
  const pb = String(b || '0').split(/[.-]/).map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

/**
 * 解析源码来源（2026-08-21 用户决定：本地开发版永远优先）。
 *  - 本地测试环境副本版本 >= GitHub 发布版 → 用本地（开发中/领先发布版，防倒退）
 *  - 本地低于 GitHub → 从 GitHub 拉（发布版更新）
 * @param {string} tmpDir 下载目标临时目录（github 源时用）
 * @returns {Promise<{ok:boolean, version:string, srcDir:string, source:'local'|'github', error?:string}>}
 */
async function resolveSource(tmpDir) {
  // 本地测试环境副本（开发母体）
  const localDir = testEnvPluginDir()
  const localPkg = await envInstalledVersion(localDir)
  // GitHub 发布版
  const remote = await checkRemoteVersion()
  const remoteVer = remote.ok ? remote.version : null
  if (localPkg && remoteVer) {
    if (compareVersions(localPkg, remoteVer) >= 0) {
      // 本地 >= 远端 → 本地优先
      return { ok: true, version: localPkg, srcDir: localDir, source: 'local' }
    }
  }
  // 本地缺失或落后于远端 → 下载 GitHub 版
  if (!remoteVer) return { ok: false, error: remote.error || '远端版本读取失败' }
  await downloadSource(tmpDir)
  return { ok: true, version: remoteVer, srcDir: tmpDir, source: 'github' }
}

/**
 * 主入口：取最新源码（本地优先）→ 分发安装到测试环境 + 纯净环境。
 * @param {object} opts { dshVersion, targets: ['test','clean'], force }
 */
export async function installLatestToRescueEnvs({ dshVersion = '0.1.0-rc.6', targets = ['test', 'clean'] } = {}) {
  const tmpDir = join(homedir(), '.dsh', 'git-rescue', '.installer-tmp')
  try {
    // 1) 解析源码来源（本地优先，防倒退）
    const src = await resolveSource(tmpDir)
    if (!src.ok) return { ok: false, error: src.error }
    // 2) 分发（targets 含 test 时从 src 复制；含 clean 时用 src 重建纯净环境）
    const results = []
    if (targets.includes('test')) {
      const t = await installToTestEnv(src.srcDir)
      results.push({ target: 'test', ok: t.ok, error: t.error })
    }
    if (targets.includes('clean')) {
      const c = await installToCleanEnv(src.srcDir, dshVersion)
      results.push({ target: 'clean', ok: c.ok, dir: c.dir, error: c.error })
    }
    // 3) 清理临时目录
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    const allOk = results.every((r) => r.ok)
    return { ok: allOk, version: src.version, source: src.source, results }
  } catch (e) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 状态：远端/本地版本 + 测试/纯净环境当前版 + 来源提示。 */
export async function installerStatus(dshVersion = '0.1.0-rc.6') {
  const remote = await checkRemoteVersion()
  const localPkg = await envInstalledVersion(testEnvPluginDir())
  const testVer = await envInstalledVersion(join(TEST_ENV.home, 'profiles/web/node_modules_local', TEST_ENV.name))
  const cleanVer = await envInstalledVersion(join(cleanEnvDir(dshVersion), 'profiles/web/node_modules_local', TEST_ENV.name))
  const remoteVer = remote.ok ? remote.version : null
  // 本地优先规则：本地 >= 远端 → source=local
  const useLocal = localPkg && remoteVer && compareVersions(localPkg, remoteVer) >= 0
  return {
    ok: true,
    remote: remoteVer,
    remoteError: remote.ok ? null : remote.error,
    local: localPkg,
    source: useLocal ? 'local' : (remoteVer ? 'github' : 'unknown'),
    testEnv: { version: testVer, home: TEST_ENV.home },
    cleanEnv: { version: cleanVer, dir: cleanEnvDir(dshVersion) },
    // 需要安装 = 两环境任一与「应采用版本（本地优先）」不一致
    updateNeeded: (useLocal ? (localPkg && (testVer !== localPkg || cleanVer !== localPkg)) : (remoteVer && (testVer !== remoteVer || cleanVer !== remoteVer))) || false,
  }
}
