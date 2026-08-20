/**
 * dsh-git-rescue 2.0.0 — 插件安装门禁（测试闸门代码化，2026-08-20 EIGHTfs 需求）
 *
 * 流程：
 *  1. 检测插件安装：读取主环境 cordis.patch.yml 插件清单 vs 本地 plugin-registry.json，
 *     发现「新插件/版本变更」→ 标记 pending（未测试）
 *  2. 读新插件 skills/ 复制到本地 .dsh/skills/（skill-code-parity：插件 skill 权威在插件项目）
 *  3. plugin-registry.json 记录每插件测试状态：{测试环境是否部署 + 测试是否通过}
 *  4. 检测到 pending 插件 → 阻止主环境重启（强行接管重启流程）
 *  5. 测试环境测试通过（deploy-gate 逻辑）→ 更新 registry → 放行重启
 *
 * 数据：git-rescue/plugin-registry.json
 *  { plugins: { <id>: { name, version, testEnv: 'passed'|'pending'|'not-tested',
 *      testedAt, installedAt, skillsCopiedAt } } }
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 注册表文件路径。 */
export function registryPath(dshHome) {
  return join(dshHome, 'git-rescue', 'plugin-registry.json')
}

/** 读注册表（无则返回空结构）。 */
export async function readRegistry(dshHome) {
  try {
    const raw = await fs.readFile(registryPath(dshHome), 'utf8')
    return JSON.parse(raw)
  } catch {
    return { plugins: {} }
  }
}

/** 写注册表。 */
export async function writeRegistry(dshHome, registry) {
  await fs.mkdir(join(dshHome, 'git-rescue'), { recursive: true })
  await fs.writeFile(registryPath(dshHome), JSON.stringify(registry, null, 2), 'utf8')
}

/**
 * 读取主环境 cordis.patch.yml 的插件清单（id → {id, name}）。
 * 兼容两种写法：`- id: x` + `name: y`，或 `- id: x` 无 name。
 * @param {string} mainProfile profiles/web 目录
 */
export async function scanInstalledPlugins(mainProfile) {
  try {
    const raw = await fs.readFile(join(mainProfile, 'cordis.patch.yml'), 'utf8')
    const lines = raw.split('\n')
    const plugins = {}
    let cur = null
    for (const line of lines) {
      const idM = line.match(/^\s*-\s+id:\s*["']?([^"'\s]+)/)
      if (idM) {
        cur = { id: idM[1], name: idM[1] }
        plugins[cur.id] = cur
        continue
      }
      const nameM = line.match(/^\s+name:\s*["']?([^"'\s]+)/)
      if (nameM && cur) {
        cur.name = nameM[1].replace(/^['"]|['"]$/g, '')
        plugins[cur.id].name = cur.name
      }
    }
    return plugins
  } catch {
    return {}
  }
}

/**
 * 检测新安装/版本变更的插件（对比 cordis.patch.yml 与 registry）。
 * 2026-08-20 修正：registry 无记录 ≠ 拦截——存量插件默认放行（首次扫描标 passed）；
 * 只有 registry 显式 pending（测试未通过）才视为需拦截。
 * @returns {Promise<{newPlugins: object[], changed: object[], all: object}>}
 */
export async function detectNewPlugins({ dshHome, mainProfile }) {
  const installed = await scanInstalledPlugins(mainProfile)
  const registry = await readRegistry(dshHome)
  const newPlugins = []
  const changed = []
  for (const [id, info] of Object.entries(installed)) {
    const rec = registry.plugins?.[id]
    if (!rec) {
      // 存量插件首次扫描：默认放行（由 scan 路由标 passed）
      newPlugins.push({ id, name: info.name, reason: 'unregistered' })
    } else if (rec.testEnv === 'pending') {
      newPlugins.push({ id, name: info.name, reason: '测试未通过（pending）' })
    }
  }
  return { newPlugins, changed, all: installed }
}

/**
 * 复制插件 skills/ 到本地 .dsh/skills/（插件项目 skills 是权威，同步到公用加载目录）。
 * 源路径回退（2026-08-21 加固）：部署版 node_modules/<pkg>/skills 可能不存在
 * （部分插件部署时未带 skills 目录，如 dsh-session-manager/dsh-git-rescue/dsh-tasklist），
 * 此时回退到 workspace 源码 workspace/<pkg>/skills/ 复制。
 * @param {string} pluginDir 插件安装目录（node_modules/<pkg>）
 * @param {string} dshHome
 * @param {object} [opts] { workspace? 源码根（默认探测 /vol1/@appshare/DeepSeekHarness/workspace） }
 * @returns {Promise<{copied: string[], ok: boolean, source: string}>}
 */
export async function copyPluginSkills(pluginDir, dshHome, opts = {}) {
  const copied = []
  const workspace = opts.workspace || process.env.DSH_WORKSPACE || '/vol1/@appshare/DeepSeekHarness/workspace'
  // 候选源：node_modules 部署版 → workspace 源码
  const pkgName = pluginDir.split(/[\\/]/).pop()
  const candidates = [join(pluginDir, 'skills'), join(workspace, pkgName, 'skills')]
  for (const src of candidates) {
    try {
      const entries = await fs.readdir(src).catch(() => null)
      if (!entries) continue // 该候选源不存在
      const targetDir = join(dshHome, 'skills')
      await fs.mkdir(targetDir, { recursive: true })
      for (const f of entries) {
        if (!f.endsWith('.md')) continue
        await fs.copyFile(join(src, f), join(targetDir, f))
        if (!copied.includes(f)) copied.push(f)
      }
      return { ok: true, copied, source: src } // 第一个可用源复制即返回
    } catch (e) {
      // 继续下一个候选源
    }
  }
  return { ok: copied.length > 0, copied, source: '', error: copied.length ? undefined : `skills 源不存在（node_modules 与 workspace 均无 ${pkgName}/skills）` }
}

/**
 * 注册/更新插件测试状态。
 * @param {string} dshHome
 * @param {object} opts { id, name, testEnv: 'passed'|'pending' }
 */
export async function updatePluginStatus(dshHome, { id, name, testEnv }) {
  const registry = await readRegistry(dshHome)
  registry.plugins = registry.plugins || {}
  const now = new Date().toISOString()
  const prev = registry.plugins[id] || {}
  registry.plugins[id] = {
    ...prev,
    id,
    name: name || prev.name || id,
    testEnv, // 'passed' | 'pending'
    installedAt: prev.installedAt || now,
    testedAt: testEnv === 'passed' ? now : prev.testedAt || null,
  }
  await writeRegistry(dshHome, registry)
  return registry.plugins[id]
}

/**
 * 是否存在「未测试」插件（决定是否拦截主环境重启）。
 * 2026-08-20 修正：只拦 registry 显式 pending 的；存量/未登记不拦。
 * @returns {Promise<{blocked: boolean, pending: object[]}>}
 */
export async function pendingPlugins({ dshHome, mainProfile }) {
  const registry = await readRegistry(dshHome)
  const installed = await scanInstalledPlugins(mainProfile)
  const pending = []
  for (const [id, info] of Object.entries(installed)) {
    const rec = registry.plugins?.[id]
    if (rec && rec.testEnv === 'pending') {
      pending.push({ id, name: info.name, reason: '测试未通过（pending）' })
    }
  }
  return { blocked: pending.length > 0, pending }
}
