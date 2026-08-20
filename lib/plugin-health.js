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
 * 真实 import 冒烟 + apply/inject 导出校验（纯代码，2026-08-21 增强）。
 * cordis 插件加载要求：模块导出 apply（function 或含 apply 的对象）——否则
 * `invalid plugin, expect function or object with an "apply" method, received object`。
 * node --check 只查语法查不出（裸 test / 导出类型错都过语法），必须真实 import。
 * @param {string} mainFile 插件 main 绝对路径
 * @returns {Promise<string>} 'ok' 或错误描述
 */
export function checkApplyExport(mainFile) {
  return new Promise((resolve) => {
    // 用子进程 import（避免污染本进程模块缓存 / 副作用）
    const script = `import(${JSON.stringify(mainFile)}).then((m) => {
      const a = m.apply ?? m.default?.apply
      if (typeof a === 'function') return 'ok'
      if (a !== undefined && typeof a === 'object' && a !== null && typeof a.apply === 'function') return 'ok'
      if (a !== undefined && typeof a === 'object' && a !== null) return 'exports.apply 是对象但缺 apply 方法'
      return 'exports.apply 类型错误 (typeof=' + typeof a + ')，需 function 或含 apply 方法的对象'
    }).catch((e) => 'import 失败: ' + String(e?.message ?? e)).then((r) => process.stdout.write(r))`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', (code) => resolve(code === 0 ? (out.trim() || 'ok') : `import 退出码 ${code}: ${out.trim()}`))
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
    // 跳过备份/卸载残留目录（.uninstalled-* / .bak-* / .old-*）——已移走的插件不算带病
    if (/\.(uninstalled|bak|old|hoisted-bak)[-.0-9]*$/.test(ent.name)) continue
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
        else {
          // ③ 真实 import 冒烟 + apply/inject 导出校验（2026-08-21 纯代码修复增强）：
          //    invalid plugin（expect function or object with an "apply" method, received object）根因
          //    = main 导出没有 apply（或 apply 非函数/非对象）——语法检查查不出，必须真实 import
          const applyCheck = await checkApplyExport(mainFile)
          if (applyCheck !== 'ok') {
            findings.push({
              plugin: ent.name,
              type: 'invalid-apply',
              detail: `apply 导出无效（invalid plugin）: ${applyCheck} —— cordis loader 报 "expect function or object with an apply method"，无法加载`,
            })
          }
        }
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

/**
 * 卸载问题插件（备份式，可回退）——2026-08-21 用户要求：
 * 遇到 invalid plugin / Failed to load plugins 等加载错误，优先卸载问题插件并记录，
 * 不反复修（见 plugin-error-uninstall-first skill）。
 *
 * 卸载三件套（备份式，均不物理删除，可回退）：
 *  ① node_modules/<pkg> → node_modules/<pkg>.uninstalled-<ts>
 *  ② cordis.patch.yml 中对应 insert 块注释掉（保留现场）
 *  ③ package.json dependencies 移除（备份原文件）
 *
 * @param {string} dshHome
 * @param {string} pkgName 插件名（如 dsh-header-layout）
 * @param {object} opts { dryRun }
 * @returns {Promise<{ok:boolean, plugin:string, action:string, detail:string, backups?:string[]}>}
 */
export async function uninstallProblemPlugin(dshHome, pkgName, { dryRun = false } = {}) {
  const nm = join(dshHome, 'profiles', 'web', 'node_modules')
  const profileDir = join(dshHome, 'profiles', 'web')
  const pkgDir = join(nm, pkgName)
  const backups = []
  try {
    const exists = await fs.access(pkgDir).then(() => true).catch(() => false)
    if (!exists) {
      return { ok: false, plugin: pkgName, action: 'skip', detail: `node_modules/${pkgName} 不存在（可能已卸载）` }
    }
    if (dryRun) {
      return { ok: true, plugin: pkgName, action: 'would-uninstall', detail: `dryRun：将备份式卸载 ${pkgName}` }
    }
    // ① node_modules 备份式移除（mv 加后缀，可回退）
    const ts = Date.now()
    const bakDir = `${pkgDir}.uninstalled-${ts}`
    await fs.rename(pkgDir, bakDir)
    backups.push(bakDir)
    // ② package.json dependencies 移除（备份原文件）
    const pkgJsonPath = join(profileDir, 'package.json')
    try {
      const raw = await fs.readFile(pkgJsonPath, 'utf8')
      const pkgJson = JSON.parse(raw)
      if (pkgJson.dependencies && pkgJson.dependencies[pkgName] !== undefined) {
        const bakPkg = `${pkgJsonPath}.bak-uninstall-${ts}`
        await fs.copyFile(pkgJsonPath, bakPkg)
        backups.push(bakPkg)
        delete pkgJson.dependencies[pkgName]
        await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8')
      }
    } catch { /* package.json 处理失败不阻断（patch 注释仍生效） */ }
    // ③ cordis.patch.yml 对应 insert 块注释掉（备份现场，保留可回退）
    const patchPath = join(profileDir, 'cordis.patch.yml')
    try {
      const patch = await fs.readFile(patchPath, 'utf8')
      if (patch.includes(pkgName)) {
        const bakPatch = `${patchPath}.bak-uninstall-${ts}`
        await fs.copyFile(patchPath, bakPatch)
        backups.push(bakPatch)
        // 注释掉含插件名的行（简单可靠：逐行 # 前缀；块内其他行保持）
        const lines = patch.split('\n')
        const out = lines.map((l) => {
          if (l.includes(pkgName) && !l.trim().startsWith('#')) return '# ' + l
          return l
        })
        await fs.writeFile(patchPath, out.join('\n'), 'utf8')
      }
    } catch { /* patch 处理失败不阻断 */ }
    return { ok: true, plugin: pkgName, action: 'uninstalled', detail: `备份式卸载完成（node_modules 已移走，patch/依赖已注释/移除）`, backups }
  } catch (e) {
    return { ok: false, plugin: pkgName, action: 'uninstall-failed', detail: String(e?.message ?? e) }
  }
}
