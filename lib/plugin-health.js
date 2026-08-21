/**
 * dsh-git-rescue — 插件树健康体检（plugin-health）
 *
 * 背景（2026-08-20 实测）：dsh-git-rescue 1.13.0 带 `dsh.runtime:host` 且无 client.js，
 * DSH 的 client-modules 加载器请求 `/plugins/<id>/client.js` 失败 →
 * `Failed to load plugins` → 主环境插件树起不来。
 *
 * 拦截原则：**不猜"哪个字段会导致崩溃"（runtime:host 不是可靠判据，host-perf/skill-hub/
 * tasklist 同为 runtime:host+无 client.js 却正常运行），只验证两件确定的事：**
 *  ① 声明 vs 产物一致性：声明了 client（dsh.client / exports["./client"]）就必须有构建产物
 *     client.js——缺失 = client-modules 必然请求 404（00:22 崩溃类型）
 *  ② lib 入口可加载：main 指向的文件存在 + node --check 语法通过
 *
 * 跨平台：纯 Node（node:fs / node:path / node:child_process），Windows/Linux/macOS 通用。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/** 插件是否声明了需要 client 构建产物（dsh.client 或 exports["./client"]）。
 * 返回解析出的 client 产物相对路径（exports["./client"] 优先，否则 null=未知约定）。
 */
export function declaresClient(pkg) {
  const dsh = (pkg && typeof pkg === 'object' && pkg.dsh) || {}
  const hasDshClient = dsh.client !== undefined
  const ex = pkg?.exports
  let clientPath = null
  let hasClientExport = false
  if (typeof ex === 'object' && ex !== null && ex['./client'] !== undefined) {
    hasClientExport = true
    const c = ex['./client']
    if (typeof c === 'string') clientPath = c
    else if (typeof c === 'object' && c !== null && typeof c.default === 'string') clientPath = c.default
  }
  return { hasDshClient, hasClientExport, clientPath, declares: hasDshClient || hasClientExport }
}

/** node --check 语法校验（返回 null=通过，否则错误信息）。 */
export function syntaxCheck(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve(code === 0 ? null : err.trim() || '语法错误'))
    child.on('error', (e) => resolve(String(e?.message ?? e)))
  })
}

/**
 * 扫描插件树（profiles/web/node_modules/*），返回体检 findings。
 * @param {string} dshHome DSH_HOME（主环境 / 测试环境均可）
 * @returns {Promise<Array<{plugin:string, type:string, detail:string}>>}
 */
export async function scanPluginTree(dshHome) {
  const nm = join(dshHome, 'profiles', 'web', 'node_modules')
  const findings = []
  let entries = []
  try { entries = await fs.readdir(nm, { withFileTypes: true }) } catch { return findings }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('@')) continue // scope 目录（@scope/pkg），package.json 在子目录
    const pkgPath = join(nm, ent.name, 'package.json')
    let pkg = null
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
    } catch {
      findings.push({ plugin: ent.name, type: 'pkg-invalid-json', detail: `package.json 非法 JSON 或缺失: ${pkgPath}` })
      continue
    }
    // ① 声明 vs 产物一致性（解析 exports["./client"] 实际路径）
    const { declares, clientPath, hasDshClient, hasClientExport } = declaresClient(pkg)
    if (declares) {
      // 产物路径：exports["./client"] 优先；仅 dsh.client 声明（无路径）时按约定查插件根 client.js
      const rel = clientPath || (hasClientExport ? null : 'client.js')
      const clientFile = rel ? join(nm, ent.name, rel) : null
      const hasClient = clientFile ? await fs.access(clientFile).then(() => true).catch(() => false) : false
      if (!hasClient) {
        findings.push({
          plugin: ent.name,
          type: 'client-declared-no-bundle',
          detail: `声明了 client（${hasDshClient ? 'dsh.client' : ''}${hasDshClient && hasClientExport ? ' + ' : ''}${hasClientExport ? 'exports["./client"]' : ''}）但产物不存在: ${clientFile || '（未声明路径，约定 client.js）'} —— client-modules 请求 /plugins/${ent.name}/client.js 会 404 → Failed to load plugins`,
        })
      }
    }
    // ② lib 入口存在 + 语法
    const main = typeof pkg.main === 'string' ? pkg.main : (typeof pkg.exports === 'object' && pkg.exports !== null && typeof pkg.exports['.'] === 'string' ? pkg.exports['.'] : null)
    if (main) {
      const mainFile = join(nm, ent.name, main)
      const exists = await fs.access(mainFile).then(() => true).catch(() => false)
      if (!exists) {
        findings.push({ plugin: ent.name, type: 'main-missing', detail: `main 入口不存在: ${mainFile}` })
      } else if (mainFile.endsWith('.js') || mainFile.endsWith('.mjs')) {
        const err = await syntaxCheck(mainFile)
        if (err) findings.push({ plugin: ent.name, type: 'main-syntax-error', detail: `main 入口语法错误: ${err}` })
      }
    }
  }
  return findings
}

/**
 * 自动修复体检发现的问题（可回退：修改前备份原文件）。
 * 修复策略：声明 client 但无产物 → 移除声明（dsh.client / exports["./client"]），
 * 与 2026-08-20 修复（移除 runtime:host 后 client.js 不再被请求）同思路，更精确。
 * @param {string} dshHome
 * @param {object} opts { dryRun }
 * @returns {Promise<Array<{plugin:string, action:string, detail:string}>>}
 */
export async function fixPluginTree(dshHome, { dryRun = false } = {}) {
  const nm = join(dshHome, 'profiles', 'web', 'node_modules')
  const fixes = []
  let entries = []
  try { entries = await fs.readdir(nm, { withFileTypes: true }) } catch { return fixes }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('@')) continue // scope 目录跳过
    const pkgPath = join(nm, ent.name, 'package.json')
    let pkg = null
    try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) } catch { continue }
    const { declares, clientPath } = declaresClient(pkg)
    if (!declares) continue
    // 产物路径存在 → 无需修复（声明正确）
    const rel = clientPath || 'client.js'
    const clientFile = join(nm, ent.name, rel)
    const hasClient = await fs.access(clientFile).then(() => true).catch(() => false)
    if (hasClient) continue
    // 无产物却声明 client → 移除声明（可回退：改前备份）
    const changed = JSON.parse(JSON.stringify(pkg))
    if (changed.dsh?.client !== undefined) delete changed.dsh.client
    if (changed.exports && typeof changed.exports === 'object' && changed.exports['./client'] !== undefined) delete changed.exports['./client']
    if (JSON.stringify(changed) === JSON.stringify(pkg)) continue
    if (dryRun) {
      fixes.push({ plugin: ent.name, action: 'would-remove-client-decl', detail: `dryRun：将移除 ${ent.name} 的 client 声明（产物 ${rel} 不存在）` })
      continue
    }
    try {
      // 备份原文件（可回退）
      const bak = `${pkgPath}.bak-${Date.now()}`
      await fs.copyFile(pkgPath, bak)
      await fs.writeFile(pkgPath, JSON.stringify(changed, null, 2) + '\n', 'utf8')
      fixes.push({ plugin: ent.name, action: 'removed-client-decl', detail: `已移除 client 声明（产物 ${rel} 不存在），原文件备份: ${bak}` })
    } catch (e) {
      fixes.push({ plugin: ent.name, action: 'fix-failed', detail: `修复失败: ${String(e?.message ?? e)}` })
    }
  }
  return fixes
}

/**
 * 一键体检 + 修复（guardian recover 前 / 插件启动自检调用）。
 * @param {string} dshHome
 * @param {object} opts { autoFix }
 * @returns {Promise<{findings:Array, fixes:Array, ok:boolean}>}
 */
export async function pluginTreeHealthCheck(dshHome, { autoFix = true } = {}) {
  const findings = await scanPluginTree(dshHome)
  const fixes = autoFix ? await fixPluginTree(dshHome) : []
  return { findings, fixes, ok: findings.length === 0 }
}
