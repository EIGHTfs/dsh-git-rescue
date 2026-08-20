/**
 * dsh-git-rescue 2.0.0 — 专项恢复工具集（⑤）
 *
 * 把「过往经验 + dsh-boot-troubleshooting skill + 本机启动失败日志」固化为代码级
 * 诊断/修复工具。每个工具 = { id, name, layers, diagnose(), fix() }：
 *  - diagnose() 只读探测，判定是否命中该故障类型
 *  - fix() 执行对应修复动作（可回退/可重复，幂等优先）
 *
 * 守护进程探活失败 → classifyFault 分层 → 依次尝试命中工具（简单修复）
 * → 不能修复 → git 回退（⑥）→ 仍失败 → 纯净 dsh 协助（⑦）。
 */

import { promises as fs, constants } from 'node:fs'
import { join } from 'node:path'
import { runGit } from './git.js'

/** 执行探测命令（mount/dmesg/grep 等，只读，超时保护）。 */
async function execProbe(cmdArgs) {
  const { execFile } = await import('node:child_process')
  const [bin, ...args] = cmdArgs
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(''); return }
      resolve(String(stdout ?? ''))
    })
  })
}

/** 读文件尾部 N 行（不存在返回 ''）。 */
async function readTail(file, n = 40) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw.split('\n').filter(Boolean).slice(-n).join('\n')
  } catch { return '' }
}

// ============ 工具 1：插件配置修复（plugin_config） ============

/**
 * 诊断插件配置层故障：
 *  - cordis.patch.yml 非法 YAML
 *  - profiles/web/package.json 非法 JSON
 *  - 插件入口文件存在裸 test 标识符等语法残留（2026-08-19 实测事故）
 * @param {string} dshHome
 */
export async function diagnosePluginConfig(dshHome) {
  const findings = []
  const patch = join(dshHome, 'profiles/web/cordis.patch.yml')
  const pkg = join(dshHome, 'profiles/web/package.json')
  try {
    const raw = await fs.readFile(patch, 'utf8')
    // 简单 YAML 结构校验：insert 段格式
    const lines = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    let inInsert = false
    let insertCount = 0
    for (const line of lines) {
      if (line.trim() === '- insert:') { inInsert = true; continue }
      if (inInsert) {
        if (/^\s+- id:/.test(line)) insertCount++
        else if (/^\S/.test(line)) inInsert = false
      }
    }
    if (/^\s*\[\]\s*$/m.test(raw)) {
      findings.push({ type: 'empty-patch', detail: 'cordis.patch.yml 是空数组 []（插件未注册）' })
    } else if (insertCount === 0 && !/^- insert:/m.test(raw)) {
      findings.push({ type: 'patch-malformed', detail: 'cordis.patch.yml 结构异常：无 insert 段' })
    }
  } catch { findings.push({ type: 'patch-missing', detail: `cordis.patch.yml 缺失: ${patch}` }) }
  try {
    JSON.parse(await fs.readFile(pkg, 'utf8'))
  } catch {
    findings.push({ type: 'pkg-invalid-json', detail: `package.json 非法 JSON: ${pkg}` })
  }
  // 插件入口裸 test 残留（2026-08-19 dsh-session-manager 事故）
  try {
    const entries = await fs.readdir(join(dshHome, 'profiles/web/node_modules'), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const idx = join(dshHome, 'profiles/web/node_modules', e.name, 'lib', 'index.js')
      const src = await fs.readFile(idx, 'utf8').catch(() => null)
      if (src && /^\s*test\s*$/m.test(src)) {
        findings.push({ type: 'bare-test-identifier', detail: `插件 ${e.name} lib/index.js 末尾存在孤立 test 标识符（2026-08-19 事故类型）` })
      }
    }
  } catch { /* 扫描失败不致命 */ }
  return { matched: findings.length > 0, findings }
}

/**
 * 修复插件配置层故障。
 * 安全原则：只修确定性的语法级问题；结构性问题交给 git 回退。
 */
export async function fixPluginConfig(dshHome) {
  const { matched, findings } = await diagnosePluginConfig(dshHome)
  if (!matched) return { ok: true, skipped: true, detail: '无插件配置层故障' }
  const done = []
  for (const f of findings) {
    if (f.type === 'pkg-invalid-json') {
      // 尝试从 git 恢复该文件（本地仓库有历史时）
      const r = await runGit(['checkout', '--', 'profiles/web/package.json'], { cwd: dshHome })
      if (r.ok) done.push(`package.json 已从 git 恢复`)
      else done.push(`package.json 非法 JSON 且无 git 历史可恢复（${r.stderr}）`)
    }
    if (f.type === 'bare-test-identifier') {
      // 移除孤立 test 行（2026-08-19 修复动作）
      const idx = join(dshHome, 'profiles/web/node_modules', f.detail.match(/插件 (\S+) lib/)?.[1] || '', 'lib', 'index.js')
      try {
        const src = await fs.readFile(idx, 'utf8')
        const fixed = src.replace(/^\s*test\s*$/m, '')
        if (fixed !== src) {
          await fs.writeFile(idx, fixed)
          done.push(`已移除 ${idx} 的孤立 test 标识符`)
        }
      } catch { /* 文件已被处理 */ }
    }
  }
  return { ok: true, done }
}

// ============ 工具 2：引导层软链修复（boot_symlink） ============

/** 诊断引导层软链冲突：profiles/node_modules 下出现真实目录（非软链）。 */
export async function diagnoseBootSymlink(dshHome) {
  const nm = join(dshHome, 'profiles', 'node_modules')
  let conflicts = []
  try {
    const entries = await fs.readdir(nm, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = join(nm, e.name)
      const isLink = (await fs.lstat(p).catch(() => null))?.isSymbolicLink() ?? false
      if (!isLink) conflicts.push(e.name)
    }
  } catch { /* node_modules 不存在则无冲突 */ }
  if (conflicts.length === 0) return { matched: false, findings: [] }
  return {
    matched: true,
    findings: [{ type: 'real-dir-in-nm', detail: `profiles/node_modules 下 ${conflicts.length} 个真实目录（应为软链）: ${conflicts.slice(0, 8).join(', ')}` }],
  }
}

/**
 * 修复引导层软链冲突：把真实目录改名备份（.hoisted-bak-<ts>），
 * 重启时 dsh-app-boot 引导自建软链（2026-08-19 实测有效、可回退）。
 */
export async function fixBootSymlink(dshHome) {
  const { matched } = await diagnoseBootSymlink(dshHome)
  if (!matched) return { ok: true, skipped: true, detail: '无引导层软链冲突' }
  const nm = join(dshHome, 'profiles', 'node_modules')
  const bak = join(dshHome, 'profiles', `node_modules.hoisted-bak-${Date.now()}`)
  try {
    await fs.rename(nm, bak)
    return { ok: true, detail: `profiles/node_modules 已改名备份 → ${bak}（重启后引导自建软链）`, backup: bak }
  } catch (e) {
    return { ok: false, error: `改名失败: ${String(e?.message ?? e)}`, backup: null }
  }
}

// ============ 工具 3：系统卷只读（ro_volume） ============

/** 诊断系统卷只读：/vol1 挂载 ro 或 dmesg 有 I/O error。 */
export async function diagnoseRoVolume() {
  const findings = []
  const mountOut = await execProbe(['mount'])
  const roLines = mountOut.split('\n').filter((l) => (l.includes('/vol1') || l.includes('appdata')) && l.includes('ro,'))
  if (roLines.length) findings.push({ type: 'vol-ro', detail: roLines[0].slice(0, 120) })
  const dmesgOut = await execProbe(['dmesg', '-T'])
  const tail = String(dmesgOut).split('\n').slice(-60).join('\n')
  const m = tail.match(/I\/O error|EXT4-fs error|Remounting filesystem read-only|Read-only file system|btrfs error/i)
  if (m) findings.push({ type: 'fs-error', detail: m[0] })
  return { matched: findings.length > 0, findings }
}

/**
 * 修复系统卷只读：sudo remount rw（需要 sudo-key，绝不明文）。
 * 注意：磁盘 I/O 错误/RAID 降级时内核会立刻切回 ro——修复后需复核。
 */
export async function fixRoVolume(dshHome, { sudoKey = '' } = {}) {
  if (!sudoKey) return { ok: false, needSudoKey: true, detail: '未配置 sudo-key，无法自动 remount（请人工处理）' }
  const { execFile } = await import('node:child_process')
  for (const t of ['/vol1', '/']) {
    try {
      const out = await new Promise((resolve) => {
        const child = execFile('sudo', ['-S', '-p', '', 'mount', '-s', '-o', 'remount,rw', t], {
          timeout: 8000,
        }, (err, _stdout, stderr) => resolve(err ? { ok: false, stderr: String(stderr ?? '') } : { ok: true }))
        child.stdin.write(sudoKey + '\n')
        child.stdin.end()
      })
      if (out.ok) return { ok: true, detail: `已 remount rw ${t}` }
    } catch { /* 尝试下一个挂载点 */ }
  }
  return { ok: false, detail: 'remount 尝试全部失败（可能卷健康/I-O 错误/密码错误），需人工查盘' }
}

// ============ 工具 4：插件加载失败（plugin_load） ============

/** 诊断插件加载失败：stderr 中的 invalid plugin / Failed to load / Cannot find package。 */
export async function diagnosePluginLoad(dshHome) {
  const stderr = await readTail(join(dshHome, 'git-rescue', 'dsh-stderr.log'), 200)
  const findings = []
  if (/invalid plugin.*apply/i.test(stderr)) {
    findings.push({ type: 'invalid-plugin-export', detail: 'client 插件 exports.apply/inject 在 factory 外（invalid plugin, received object）' })
  }
  if (/failed to load plugins/i.test(stderr)) {
    findings.push({ type: 'client-load-failed', detail: '客户端 cordis 加载失败（白屏）' })
  }
  if (/cannot find package/i.test(stderr)) {
    findings.push({ type: 'missing-package', detail: '残留引用/缺包（Cannot find package）' })
  }
  if (/client\.js\?rev=.*failed to load/i.test(stderr)) {
    // Bug C 加固（2026-08-20）：从 stderr 提取实际报 404 的插件 id（client.js 前的 loader entry 名），
    // fixPluginLoad 只处理该插件，避免对全部 node_modules 插件误删 runtime:host
    const m = stderr.match(/failed to import loader entry\s+(\S+)\s+\(([^)]+)\)/) || stderr.match(/\/plugins\/([^/?]+)\/client\.js/)
    findings.push({
      type: 'runtime-host-client-404',
      detail: '纯 host 插件误声明 dsh.runtime:host 导致 client.js 404（2026-08-20 实测）',
      plugin: m ? (m[1] || m[2] || m[3] || '') : '',
    })
  }
  return { matched: findings.length > 0, findings }
}

/** 修复插件加载失败：移除 package.json 的 dsh.runtime:host（纯 host 插件误声明修复）。 */
export async function fixPluginLoad(dshHome) {
  const { matched, findings } = await diagnosePluginLoad(dshHome)
  if (!matched) return { ok: true, skipped: true, detail: '无插件加载层故障' }
  const done = []
  for (const f of findings) {
    if (f.type === 'runtime-host-client-404') {
      // Bug C 加固：只处理 stderr 明确报 404 的插件（若有），避免全局扫描误删健康插件
      const targets = f.plugin ? [f.plugin.replace(/[^a-zA-Z0-9@_./-]/g, '')] : null
      const nm = join(dshHome, 'profiles/web/node_modules')
      const entries = await fs.readdir(nm, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (targets && !targets.some((t) => e.name.includes(t))) continue
        const pkgPath = join(nm, e.name, 'package.json')
        try {
          const j = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
          if (j?.dsh?.runtime === 'host' && !(await fs.access(join(nm, e.name, 'client.js')).then(() => true).catch(() => false))) {
            delete j.dsh.runtime
            await fs.writeFile(pkgPath, JSON.stringify(j, null, 2) + '\n')
            done.push(`已移除 ${e.name} 的 dsh.runtime:host（纯 host 插件，stderr 404 命中）`)
          }
        } catch { /* 跳过 */ }
      }
    }
  }
  return { ok: true, done }
}

// ============ 工具 5：权限修复（permission，2026-08-20 救援教训） ============

/**
 * 诊断 .dsh 属主/权限问题（root 改配置后 EACCES 拦启动，2026-08-20 实战教训）。
 * 检查关键文件是否可被服务用户读取。只读诊断，不修改。
 * @param {string} dshHome
 */
export async function diagnosePermission(dshHome) {
  const findings = []
  const keyFiles = [
    'profiles/web/package.json',
    'profiles/web/cordis.patch.yml',
    'profiles/web/cordis.yml',
    'settings.yaml',
  ]
  for (const rel of keyFiles) {
    try {
      await fs.access(join(dshHome, rel), constants.R_OK)
    } catch {
      findings.push({ type: 'eacces', detail: `读取被拒: ${rel}（EACCES——root 改配置后未 chown 回服务用户，2026-08-20 实测）` })
    }
  }
  return { matched: findings.length > 0, findings }
}

/**
 * 修复权限：把 .dsh 关键文件属主改为服务用户、权限 644（目录 755）。
 * 需要 root；修复后复验可读。
 * @param {string} dshHome
 */
export async function fixPermission(dshHome) {
  const { matched, findings } = await diagnosePermission(dshHome)
  if (!matched) return { ok: true, skipped: true, detail: '无权限故障' }
  const done = []
  const { execFile } = await import('node:child_process')
  const serviceUser = process.env.DSH_SERVICE_USER || 'deepseek-harness'
  try {
    for (const rel of ['profiles/web', 'settings.yaml']) {
      const p = join(dshHome, rel)
      await new Promise((resolve) => {
        execFile('chown', ['-R', serviceUser, p], { timeout: 10000 }, () => resolve())
      })
      await new Promise((resolve) => {
        execFile('chmod', ['-R', '644', p], { timeout: 10000 }, () => resolve())
      })
    }
    await new Promise((resolve) => {
      execFile('chmod', ['755', join(dshHome, 'profiles'), join(dshHome, 'profiles', 'web')], { timeout: 5000 }, () => resolve())
    })
    done.push(`已修复 ${serviceUser} 属主 + 644 权限（profiles/web + settings.yaml，目录 755）`)
  } catch (e) {
    return { ok: false, error: `权限修复失败（需 root）: ${String(e?.message ?? e)}` }
  }
  const re = await diagnosePermission(dshHome)
  return { ok: re.findings.length === 0, done, remaining: re.findings.map((f) => f.detail) }
}

// ============ 工具 6：corrupt session log 修复（session_repair，2026-08-20 救援教训） ============

/**
 * DSH projectKey 编码（与 @deepseek-ai/dsh-session-persistence-jsonl 一致）：
 * `/` `\` `:` → `-`；不安全字符 → `~XXXX`（大写 hex）；包 `--...--`。
 * @param {string} cwd 会话 header 的 cwd 路径
 * @returns {string} 期望的目录名（如 --C-Users-x-Downloads--）
 */
export function projectKey(cwd) {
  if (!cwd) return ''
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 诊断 corrupt session log：
 *  - 逐会话读 session.jsonl.zstd 第一帧 header，取 cwd
 *  - 用 projectKey(cwd) 与所在目录名比对（不匹配 = 编码错位，corrupt，2026-08-20 导入事故）
 *  - 第一帧非 header 或 header 解析失败 = corrupt
 * @param {string} dshHome
 */
export async function diagnoseSessionRepair(dshHome) {
  const findings = []
  const sessionsRoot = join(dshHome, 'sessions')
  let entries = []
  try { entries = await fs.readdir(sessionsRoot, { withFileTypes: true }) } catch { return { matched: false, findings: [] } }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dirName = e.name
    // 只检查 --...-- 编码目录（跳过非会话目录如 Group）
    if (!/^--.*--$/.test(dirName)) continue
    const sessionFiles = await collectJsonlZstd(join(sessionsRoot, dirName))
    for (const file of sessionFiles) {
      try {
        const header = await readSessionHeader(file)
        if (!header || header.type !== 'session' || !header.id) {
          findings.push({ type: 'corrupt-header', file, dir: dirName, detail: `header 损坏/非 session: ${dirName}` })
          continue
        }
        const expected = projectKey(header.cwd || '')
        if (expected && dirName !== expected) {
          findings.push({ type: 'cwd-mismatch', file, dir: dirName, detail: `header cwd 编码不匹配: 目录=${dirName} 期望=${expected}（cwd=${(header.cwd || '').slice(0, 60)}）` })
        }
      } catch { /* 单文件失败跳过 */ }
    }
  }
  return { matched: findings.length > 0, findings }
}

/** 递归收集目录下所有 session.jsonl.zstd（深度 ≤3）。 */
async function collectJsonlZstd(root, depth = 0) {
  if (depth > 3) return []
  let entries = []
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const en of entries) {
    const p = join(root, en.name)
    if (en.isDirectory()) out.push(...await collectJsonlZstd(p, depth + 1))
    else if (en.name === 'session.jsonl.zstd' || en.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

/**
 * 读 zstd 文件第一帧并解析 header。
 * 用「读文件头 + zstd 流式解出首帧」而非整文件解压（大文件 3.4MB+ 整解会超 maxBuffer）。
 * 多帧格式：第一帧是 header（恰好一行 JSON）。取文件前 16KB（足够容纳 header 帧）流式解压。
 */
async function readSessionHeader(file) {
  const { readFile } = await import('node:fs/promises')
  const { createReadStream } = await import('node:fs')
  const { createZstdDecompress } = await import('node:zlib')
  try {
    const st = await (await import('node:fs')).promises.stat(file)
    const head = await readFile(file, { length: Math.min(st.size, 16 * 1024) })
    const text = await new Promise((resolve, reject) => {
      const chunks = []
      const d = createZstdDecompress()
      d.on('data', (c) => { chunks.push(c); if (chunks.length > 2) d.destroy() }) // header 一帧很小，够了就停
      d.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      d.on('error', () => resolve(''))
      d.end(head)
      setTimeout(() => { d.destroy(); resolve(Buffer.concat(chunks).toString('utf8')) }, 1500)
    })
    const firstLine = text.split('\n')[0] || ''
    if (!firstLine) return null
    try { return JSON.parse(firstLine) } catch { return null }
  } catch { return null }
}

/**
 * 修复 corrupt session log：
 *  - cwd 编码不匹配（导入事故类型）：把会话目录改名为 projectKey(cwd) 正确编码（可回退，改名非删除）
 *  - 目录名与多个会话 header 冲突时：保留多数，其余并入（保守：只报告不改名，防误操作）
 * @param {string} dshHome
 */
export async function fixSessionRepair(dshHome) {
  const { matched, findings } = await diagnoseSessionRepair(dshHome)
  if (!matched) return { ok: true, skipped: true, detail: '无 corrupt session' }
  const done = []
  // 只处理 cwd-mismatch：目录名 ≠ projectKey(header.cwd) 且目标目录不存在 → 安全改名
  for (const f of findings) {
    if (f.type !== 'cwd-mismatch') continue
    const srcDir = join(dshHome, 'sessions', f.dir)
    const targetDir = join(dshHome, 'sessions', projectKey(JSON.parse((await readSessionHeader(f.file)) || '{}').cwd || ''))
    if (srcDir === targetDir) continue
    try {
      const targetExists = await fs.access(targetDir).then(() => true).catch(() => false)
      if (!targetExists) {
        await fs.rename(srcDir, targetDir)
        done.push(`会话目录改名 ${f.dir} → ${targetDir.split('/').pop()}（header cwd 编码修复）`)
      } else {
        done.push(`⚠️ ${f.dir} 需并入 ${targetDir.split('/').pop()}（目标已存在，保守未动，请人工处理）`)
      }
    } catch (e) {
      done.push(`❌ ${f.dir} 改名失败: ${String(e?.message ?? e)}`)
    }
  }
  // 复验
  const re = await diagnoseSessionRepair(dshHome)
  return { ok: re.findings.length === 0, done, remaining: re.findings.map((x) => x.detail) }
}

// ============ 工具注册表 ============

/**
 * 全部专项恢复工具（按故障层分组，guardian 按序尝试）。
 * @param {string} dshHome
 */
export function repairTools(dshHome) {
  return [
    { id: 'plugin_config', name: '插件配置修复', layers: ['plugin'], diagnose: () => diagnosePluginConfig(dshHome), fix: () => fixPluginConfig(dshHome) },
    { id: 'boot_symlink', name: '引导层软链修复', layers: ['boot'], diagnose: () => diagnoseBootSymlink(dshHome), fix: () => fixBootSymlink(dshHome) },
    { id: 'ro_volume', name: '系统卷只读修复', layers: ['system'], diagnose: () => diagnoseRoVolume(), fix: () => fixRoVolume(dshHome) },
    { id: 'plugin_load', name: '插件加载失败修复', layers: ['plugin', 'client'], diagnose: () => diagnosePluginLoad(dshHome), fix: () => fixPluginLoad(dshHome) },
    { id: 'permission', name: '权限修复（root 改配置后 EACCES）', layers: ['system'], diagnose: () => diagnosePermission(dshHome), fix: () => fixPermission(dshHome) },
    { id: 'session_repair', name: 'corrupt session 修复（cwd 编码错位）', layers: ['data'], diagnose: () => diagnoseSessionRepair(dshHome), fix: () => fixSessionRepair(dshHome) },
  ]
}

/**
 * 守护进程调用入口：按层跑诊断，返回命中工具及尝试修复结果。
 * @param {string} dshHome
 * @param {object} opts { sudoKey }
 * @returns {Promise<{hits: Array, fixes: Array}>}
 */
export async function runRepairTools(dshHome, { sudoKey = '', only = '' } = {}) {
  const tools = repairTools(dshHome)
  const hits = []
  const fixes = []
  for (const t of tools) {
    if (only && t.id !== only) continue // only 过滤（2026-08-20 LLM config_fix 按 fixId 执行）
    try {
      const diag = await t.diagnose()
      if (diag.matched) {
        hits.push({ id: t.id, name: t.name, findings: diag.findings })
        const fix = await t.fix(dshHome, { sudoKey })
        fixes.push({ id: t.id, ok: fix.ok, detail: fix.detail || (fix.done || []).join('; ') || '已尝试修复', needSudoKey: !!fix.needSudoKey })
      }
    } catch { /* 单工具失败不阻断 */ }
  }
  return { hits, fixes }
}
