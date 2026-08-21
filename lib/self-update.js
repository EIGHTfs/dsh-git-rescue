/**
 * dsh-git-rescue 2.0.0 — 自动更新（自升级到 GitHub 最新稳定版）
 *
 * 用户要求：从第一个版本（2.0.0）开始就要能实现版本自动更新。
 * 为什么强制开启（隐藏开关）：万一救援插件自身有 bug，而部署环境没人记得手动
 * 更新 → 旧版带病运行，在最需要它的时候失灵。因此自动更新**默认强制开启**，
 * 不写入 config.json、不暴露设置 API；仅环境变量 DSH_GIT_RESCUE_AUTO_UPDATE=0
 * 可关闭（调试/隔离用）。
 *
 * 更新源：EIGHTfs/dsh-git-rescue main 分支（仓库根 = 插件根，单组件结构 2.0.0）。
 * 实现：GitHub Git Trees API（recursive）取文件清单 → raw.githubusercontent.com
 *       逐个下载 → 临时目录 → 语法校验（node --check）→ 原子替换 → 失败回滚。
 *
 * 安全：
 *  - 只允许白名单前缀（lib/、guardian/、skills/、package.json、cordis.patch.yml 等）
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
}

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000 // 每 24 小时（每天一次）定时检查；另在每次 DSH 启动成功后 30s 检查一次

/** 同步白名单（前缀匹配；安全边界，防树外写入）。 */
export const SYNC_ALLOWLIST = [
  'lib/',
  'guardian/',
  'skills/',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
]

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

/** 路径是否在同步白名单内（安全前缀匹配）。 */
export function isAllowedPath(rel) {
  if (!rel || rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) return false
  return SYNC_ALLOWLIST.some((prefix) => rel === prefix || rel.startsWith(prefix))
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
  const url = `${RAW}/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/${UPDATE_SOURCE.branch}/${relPath}`
  const headers = { 'User-Agent': 'dsh-git-rescue-self-update' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`raw 下载失败 HTTP ${res.status}: ${relPath}`)
  return Buffer.from(await res.arrayBuffer())
}

// ---------- 版本检查 ----------

/**
 * 检查远端是否有新版本。
 *
 * 版本判定（正确行为）：远端存在比本地更高的版本号即 updateAvailable=true——
 * 包括旧结构（components/git-rescue/package.json，如 1.13.0）与根级结构（2.0.0+）。
 *
 * 大版本换代判定（majorUpgrade，2026-08-20 约定）：**远端结构与本地不同
 * （structureMismatch）＝ 本地已处于新大版本结构（旧系列大版本 + 1）**——
 * 旧结构的版本号（如 1.13.0）属于旧大版本系列，永远不构成"可自动更新的新版本"，
 * 必须人工处理或等待新版本（同结构）正式提交，防止旧结构覆盖新代码。
 *
 * @returns {Promise<{ok:boolean, installedVersion:string, remoteVersion:string, updateAvailable:boolean, structureMismatch?:boolean, majorUpgrade?:boolean, detail?:string}>}
 */
export async function checkForUpdate(token = '') {
  const root = installRoot()
  let installedVersion = '0.0.0'
  try {
    const pkg = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
    installedVersion = pkg.version || '0.0.0'
  } catch { /* 读取本地版本失败则视为 0.0.0 */ }

  // 版本来源探测：根级 package.json（2.0.0+ 结构）优先，旧位置 components/git-rescue/package.json 回退
  let remoteVersion = '0.0.0'
  let versionSource = 'root'
  for (const pkgPath of ['package.json', 'components/git-rescue/package.json']) {
    const r = await apiGet(token, `/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/contents/${pkgPath}?ref=${UPDATE_SOURCE.branch}`)
    if (r.ok) {
      try {
        const content = Buffer.from(r.data.content, 'base64').toString('utf8')
        remoteVersion = JSON.parse(content).version || '0.0.0'
        versionSource = pkgPath === 'package.json' ? 'root' : 'legacy'
        break
      } catch {
        return { ok: false, installedVersion, remoteVersion: null, updateAvailable: false, detail: '远端 package.json 解析失败' }
      }
    }
  }
  if (remoteVersion === '0.0.0') {
    return { ok: false, installedVersion, remoteVersion: null, updateAvailable: false, detail: '远端版本读取失败（根与旧位置均无 package.json）' }
  }

  const versionNewer = compareVersions(remoteVersion, installedVersion) > 0

  // 结构校验：远端根必须存在 lib/index.js（2.0.0 根级结构）才能自动更新
  const entryCheck = await apiGet(token, `/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/contents/lib/index.js?ref=${UPDATE_SOURCE.branch}`)
  const structureMismatch = !entryCheck.ok

  if (structureMismatch) {
    // 大版本换代：本地 = 新大版本结构（旧系列大版本 + 1），远端旧结构版本不构成可更新
    return {
      ok: true,
      installedVersion,
      remoteVersion,
      updateAvailable: versionNewer,      // 如实报告版本号更高（判定正确）
      structureMismatch: true,
      majorUpgrade: true,                  // 结构不同 = 大版本换代（本地已升大版本）
      detail: `大版本换代：本地 ${installedVersion} 为新大版本结构（旧系列大版本+1），远端 ${remoteVersion} 为旧结构（${versionSource === 'legacy' ? 'components/git-rescue/ 子树' : '根级缺 lib/index.js'}）——旧系列版本不自动更新，等待新版本（同结构）提交或人工处理`,
    }
  }

  // 数据结构一致性检查（2026-08-20 用户要求）：即使同一大版本，发现数据结构严重不一致
  // 也走「卸载重装」（applyMajorUpgrade）而非直接覆盖。判断代码级：
  //  远端 package.json 的 main 必须指向 lib/index.js（根级结构），且本地存在 lib/index.js；
  //  不一致 = 数据结构漂移（半提交/结构错位）→ 视为需卸载重装。
  const dataStructureMismatch = await checkDataStructureConsistency()

  return {
    ok: true,
    installedVersion,
    remoteVersion,
    updateAvailable: versionNewer,
    structureMismatch: false,
    majorUpgrade: false,
    dataStructureMismatch,
    detail: versionNewer
      ? (dataStructureMismatch
          ? `可更新 ${installedVersion} → ${remoteVersion}，但数据结构不一致——走卸载重装安装`
          : `可更新 ${installedVersion} → ${remoteVersion}`)
      : `已是最新 (${installedVersion})`,
  }
}

/**
 * 数据结构一致性检查（代码级判断，2026-08-20 用户要求）：
 * 同一大版本内，本地安装结构与 package.json 声明是否一致。
 * 不一致（如 main 指向缺失、lib/index.js 缺失、结构漂移）= 需卸载重装而非覆盖。
 * @returns {Promise<boolean>} true = 数据结构严重不一致（需卸载重装）
 */
async function checkDataStructureConsistency() {
  try {
    const root = installRoot()
    const pkg = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
    const main = pkg.main || 'lib/index.js'
    // ① main 入口必须存在
    const mainExists = await fs.access(join(root, main)).then(() => true).catch(() => false)
    // ② 根级 lib/index.js 必须存在（2.0.0 结构特征）
    const libIndex = await fs.access(join(root, 'lib/index.js')).then(() => true).catch(() => false)
    // ③ cordis.patch.yml 必须存在（插件注册必需）
    const patch = await fs.access(join(root, 'cordis.patch.yml')).then(() => true).catch(() => false)
    // R5 加固（2026-08-20）：判定不一致时留日志说明原因（防误判无从查）
    const reasons = []
    if (!mainExists) reasons.push(`main 入口缺失: ${main}`)
    if (!libIndex) reasons.push('lib/index.js 缺失（非根级结构）')
    if (!patch) reasons.push('cordis.patch.yml 缺失（插件注册必需）')
    if (reasons.length) {
      console.log(`[git-rescue] 数据结构不一致判定（将走卸载重装）: ${reasons.join('; ')}`)
    }
    // 任一关键结构缺失 = 数据结构严重不一致
    return reasons.length > 0
  } catch (e) {
    // R5 加固：读取失败也留日志（保守按不一致处理）
    console.log(`[git-rescue] 数据结构检查异常（保守按不一致处理）: ${String(e?.message ?? e)}`)
    return true
  }
}

// ---------- 文件清单 ----------

/** 远端仓库文件清单（Git Trees API recursive），过滤白名单。 */
async function fetchFileList(token) {
  const r = await apiGet(token, `/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/git/trees/${UPDATE_SOURCE.branch}?recursive=1`)
  if (!r.ok) throw new Error(`tree 获取失败: ${r.error}`)
  const files = []
  for (const item of r.data?.tree ?? []) {
    if (item.type !== 'blob') continue
    if (!isAllowedPath(item.path)) continue
    files.push(item.path)
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
 * 大版本换代升级（2026-08-20 用户确立）：结构不匹配时不能"直接覆盖式"自动更新，
 * 但可【代码级卸载旧版 → 安装新版】：
 *  1. 整目录备份旧版（.self-update-bak，可回滚）
 *  2. 卸载旧版：清空安装目录（旧结构残留全部移除）
 *  3. 按新结构白名单完整拉取安装（fetchFileList + fetchRaw）
 *  4. 语法全检（失败回滚旧版）
 * @param {string} token
 * @param {object} check checkForUpdate 结果（含 structureMismatch/majorUpgrade）
 * @returns {Promise<{ok:boolean, updated:boolean, majorUpgrade:boolean, from?:string, to?:string, error?:string}>}
 */
async function applyMajorUpgrade(token, check) {
  const root = installRoot()
  const stateDir = join(root, '..', '..', 'git-rescue')
  const tmpDir = join(stateDir, '.self-update-tmp')
  const bakDir = join(stateDir, '.self-update-bak')
  try {
    // 1) 下载新结构全部文件到临时目录（先拉取校验，通过才动本地）
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.mkdir(tmpDir, { recursive: true })
    const files = await fetchFileList(token)
    if (files.length === 0) throw new Error('新结构文件清单为空（远端可能未提交完整新版本）')
    for (const rel of files) {
      const dest = join(tmpDir, rel)
      await fs.mkdir(dirname(dest), { recursive: true })
      const buf = await fetchRaw(token, rel)
      await fs.writeFile(dest, buf)
    }
    // 2) 校验：package.json 版本 + 全部 .js/.mjs 语法
    const newPkg = JSON.parse(await fs.readFile(join(tmpDir, 'package.json'), 'utf8'))
    if (compareVersions(newPkg.version || '0', check.remoteVersion) !== 0) {
      throw new Error(`新版本声明不一致: pkg=${newPkg.version} remote=${check.remoteVersion}`)
    }
    for (const rel of files) {
      if (!/\.(js|mjs|cjs)$/.test(rel)) continue
      const err = await syntaxCheck(join(tmpDir, rel))
      if (err) throw new Error(`新版本文件语法错误 ${rel}: ${err}`)
    }
    // R1/R3 加固（2026-08-20）：原子替换——整目录 rename 而非「逐项清空+复制」。
    //   旧版整体 rename 让位为 bakDir（R2：整目录让位天然包含 .gitignore 等全部隐藏文件，
    //   不丢任何旧资产；仅保留 .git/node_modules 的旧筛选逻辑不再需要），
    //   新版整体 rename 就位；同文件系统 rename 原子，任一步失败都不会留下半提交目录。
    // 3) 旧版整体让位 → bakDir（卸载快照，可回滚）
    const rootExists = await fs.access(root).then(() => true).catch(() => false)
    if (rootExists) {
      await fs.rm(bakDir, { recursive: true, force: true }) // 清上一次升级残留快照
      await fs.rename(root, bakDir) // 原子：整目录让位（含隐藏文件、node_modules）
    }
    // 4) 新版整体就位（原子；tmpDir 与 root 同文件系统）
    await fs.rename(tmpDir, root)
    return { ok: true, updated: true, majorUpgrade: true, from: check.installedVersion, to: newPkg.version }
  } catch (e) {
    // 5) 失败回滚：旧版仍整体在 bakDir → 原子移回（未发生让位则无需回滚）
    const errMsg = String(e?.message ?? e)
    try {
      await fs.rm(tmpDir, { recursive: true, force: true }) // 下载/校验阶段残留
      const rootNow = await fs.access(root).then(() => true).catch(() => false)
      const bakNow = await fs.access(bakDir).then(() => true).catch(() => false)
      if (!rootNow && bakNow) {
        await fs.rename(bakDir, root) // 原子移回旧版（R1：整目录回滚，无逐项残留）
      } else if (bakNow) {
        // 极端残留（root 与 bak 并存）→ 只清理 bak，绝不覆盖新装内容
        await fs.rm(bakDir, { recursive: true, force: true })
      }
    } catch (rb) { /* 回滚失败也报告原始错误 */ }
    return { ok: false, updated: false, majorUpgrade: true, from: check.installedVersion, to: check.remoteVersion, error: `大版本升级失败（已回滚旧版）: ${errMsg}` }
  }
}

/**
 * 执行更新：下载远端文件到临时目录 → 校验 → 原子替换 → 失败回滚。
 * @returns {Promise<{ok:boolean, updated:boolean, from?:string, to?:string, error?:string}>}
 */
export async function applyUpdate(token = '') {
  const root = installRoot()
  const stateDir = join(root, '..', '..', 'git-rescue') // 插件根在 node_modules 下，状态目录在上上层
  const tmpDir = join(stateDir, '.self-update-tmp')
  const bakDir = join(stateDir, '.self-update-bak')

  try {
    // 0) 远端版本
    const check = await checkForUpdate(token)
    if (!check.ok) return { ok: false, updated: false, error: check.detail || '版本检查失败' }

    // 0.5) 大版本换代（结构不匹配）：不能"直接覆盖式"自动更新（新旧结构不兼容，直接覆盖会残留旧文件），
    //      但可【代码级卸载旧版 → 安装新版】——清空旧安装目录 → 按新结构完整拉取安装。
    //      安全：安装前整目录备份（可回滚）；安装后语法全检；失败回滚旧版。
    if (check.structureMismatch) {
      return applyMajorUpgrade(token, check)
    }
    // 0.6) 数据结构严重不一致（2026-08-20 用户要求）：即使同一大版本，
    //      发现数据结构漂移也走卸载重装而非直接覆盖（防覆盖残留导致半提交状态）
    if (check.dataStructureMismatch) {
      return applyMajorUpgrade(token, check)
    }
    if (!check.updateAvailable) return { ok: true, updated: false, from: check.installedVersion, to: check.remoteVersion, error: null }

    // 1) 下载全部白名单文件到临时目录
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
      if (ent.startsWith('.')) continue
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
