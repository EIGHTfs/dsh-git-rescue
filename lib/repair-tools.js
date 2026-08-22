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
  const done = []
  // 0) seq gap 修复（2026-08-21 新增）：先截断损坏会话到连续前缀（最优先，恢复可加载）
  const gapDiag = await diagnoseAllSessionSeqGaps(dshHome)
  if (gapDiag.matched) {
    for (const g of gapDiag.findings) {
      try {
        const r = await fixSessionSeqGap(g.file)
        done.push(r.ok ? `✅ seq gap 截断: ${r.detail}` : `❌ seq gap 修复失败 ${g.file}: ${r.error}`)
      } catch (e) {
        done.push(`❌ seq gap 修复异常 ${g.file}: ${String(e?.message ?? e)}`)
      }
    }
  }
  if (!matched && !gapDiag.matched) return { ok: true, skipped: true, detail: '无 corrupt session' }
  // 1) cwd 编码错位修复（原有逻辑）
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

// ============ 工具 6b：session log seq gap 修复（seq_gap，2026-08-21 新增） ============

/** 解析存储行 → 事件列表（复刻官方 decodeStorageRecord + expandRow）：
 *  - 普通行：单事件（seq 字段）
 *  - text-chunks / reasoning-chunks / tool-call-chunks：seq0 + members(dt) 展开为多个连续 seq 事件
 *  - 非法/未知行：返回 null（跳过，不计入 committed） */
function decodeRow(parsed) {
  if (!parsed || typeof parsed !== 'object') return Array.isArray(parsed) ? parsed : null
  const tag = parsed.type
  if (tag === 'text-chunks' || tag === 'reasoning-chunks' || tag === 'tool-call-chunks') {
    try {
      const { seq0, time0, data } = parsed
      if (!Number.isSafeInteger(seq0) || !data || !Array.isArray(data.dt)) return [parsed]
      const members = tag === 'tool-call-chunks' ? data.args : data.texts
      if (!Array.isArray(members)) return [parsed]
      const events = []
      let time = time0
      for (let k = 0; k < members.length; k++) {
        if (k > 0) time += data.dt[k - 1]
        const chunk = tag === 'tool-call-chunks'
          ? { type: 'tool-call-delta', index: data.index, id: data.id, argumentsDelta: members[k], seq: seq0 + k, time }
          : { type: tag === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: data.index, text: members[k], seq: seq0 + k, time }
        events.push(chunk)
      }
      return events
    } catch { return [parsed] }
  }
  return [parsed]
}

/**
 * 检测会话日志 seq 空洞（与官方 dsh-session-persistence-jsonl 校验一致）：
 * 官方规则：committed region 内每条事件的 seq 必须严格等于已读事件数（0,1,2,...），
 * 遇到第一个不连续处（expected=N, got=M>N）即判 corrupt（seq gap in committed region）。
 * 注意：会话日志是 zstd 拼接帧（多帧追加写入），流式解压（createZstdDecompress）可能
 * 只解出部分帧导致误判——必须用 zstd -dc 整文件解压后逐行解析。
 * @param {string} file session.jsonl.zstd 路径
 * @returns {Promise<{ok:boolean, gapLine?:number, expected?:number, got?:number, committedEvents?:number, error?:string}>}
 */
export async function diagnoseSessionSeqGap(file) {
  try {
    const { execFile } = await import('node:child_process')
    const st = await fs.stat(file)
    if (st.size === 0) return { ok: false, error: '空文件' }
    const decompressed = await new Promise((resolve, reject) => {
      execFile('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
        if (err) { reject(new Error(`zstd 解压失败: ${err.message}`)); return }
        resolve(stdout)
      })
    })
    const lines = decompressed.toString('utf8').split('\n')
    let lineNo = 0
    let eventCount = 0 // 已连续事件数（官方 events.length）
    let committedEvents = 0
    let gap = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      lineNo = i + 1
      if (lineNo === 1) continue // header 行
      if (!line.trim()) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      const events = decodeRow(parsed)
      if (!events) continue
      const rowStart = eventCount
      let rowBroken = false
      for (const ev of events) {
        if (typeof ev?.seq !== 'number') continue
        if (ev.seq !== eventCount) {
          gap = { gapLine: lineNo, expected: eventCount, got: ev.seq }
          eventCount = rowStart
          rowBroken = true
          break
        }
        eventCount += 1
      }
      if (rowBroken) { committedEvents = eventCount; break }
      committedEvents = eventCount
    }
    if (gap) {
      return { ok: false, ...gap, committedEvents, detail: `seq gap: line ${gap.gapLine} expected ${gap.expected} got ${gap.got}（committed 事件 ${committedEvents}）` }
    }
    return { ok: true, committedEvents, detail: `seq 连续（committed 事件 ${committedEvents}）` }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 修复会话日志 seq 空洞：截断到第一个 gap 前（保留 committed 连续事件前缀）。
 * 原理与官方一致：committedBytes 是最后连续事件的字节偏移，其后的内容视为损坏丢弃。
 * 实现：流式解码定位 gap 前的「最后连续事件行」，按行边界截断原文件（保留 header + 连续事件），
 * 原子写回（.seqgap-tmp + rename），原文件先备份（.seqgap.bak-<ts>）。
 * @param {string} file session.jsonl.zstd 路径
 * @returns {Promise<{ok:boolean, detail:string, backup?:string, truncated?:boolean, error?:string}>}
 */
export async function fixSessionSeqGap(file) {
  try {
    const { execFile } = await import('node:child_process')
    const st = await fs.stat(file)
    // 定位第一个 gap 行（与 diagnose 同一展开逻辑）
    const decompressed = await new Promise((resolve, reject) => {
      execFile('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
        if (err) { reject(new Error(`zstd 解压失败: ${err.message}`)); return }
        resolve(stdout)
      })
    })
    const text = decompressed.toString('utf8')
    const lines = text.split('\n')
    let eventCount = 0
    let gapIndex = -1
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      const events = decodeRow(parsed)
      if (!events) continue
      const rowStart = eventCount
      let broken = false
      for (const ev of events) {
        if (typeof ev?.seq !== 'number') continue
        if (ev.seq !== eventCount) { gapIndex = i; eventCount = rowStart; broken = true; break }
        eventCount += 1
      }
      if (broken) break
    }
    if (gapIndex === -1) return { ok: true, skipped: true, detail: '无 seq gap，无需截断' }
    // 截断内容 = 前 gapIndex 行（保留 header + 连续事件），补尾部换行
    const keep = lines.slice(0, gapIndex).join('\n') + (gapIndex > 0 ? '\n' : '')
    // 备份原文件
    const backup = `${file}.seqgap.bak-${Date.now()}`
    await fs.copyFile(file, backup)
    // 原子写回（zstd 压缩，spawn 管道写 stdin 防 execFile input 大缓冲挂起）
    const tmp = `${file}.seqgap-tmp`
    const { spawn } = await import('node:child_process')
    await new Promise((resolve, reject) => {
      const child = spawn('zstd', ['-f', '-q', '-o', tmp])
      let errOut = ''
      child.stderr?.on('data', (d) => { errOut += String(d) })
      child.on('error', (e) => reject(new Error(`zstd spawn 失败: ${e.message}`)))
      child.on('close', (code) => {
        if (code !== 0) { reject(new Error(`zstd 压缩退出码 ${code}: ${errOut.slice(0, 200)}`)); return }
        resolve()
      })
      child.stdin.on('error', () => {})
      child.stdin.write(keep)
      child.stdin.end()
    })
    await fs.rename(tmp, file)
    return { ok: true, truncated: true, backup, detail: `已截断到 line ${gapIndex}（保留 ${gapIndex} 行 / ${eventCount} 个连续事件，原 ${lines.length - 1} 行），原文件备份: ${backup}` }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 诊断全部会话的 seq gap（并入 session_repair 诊断；大文件流式，逐个返回 findings）。 */
export async function diagnoseAllSessionSeqGaps(dshHome) {
  const findings = []
  const sessionsRoot = join(dshHome, 'sessions')
  let entries = []
  try { entries = await fs.readdir(sessionsRoot, { withFileTypes: true }) } catch { return { matched: false, findings } }
  for (const e of entries) {
    if (!e.isDirectory() || !/^--.*--$/.test(e.name)) continue
    const sessionFiles = await collectJsonlZstd(join(sessionsRoot, e.name))
    for (const file of sessionFiles) {
      const r = await diagnoseSessionSeqGap(file)
      if (!r.ok && r.detail?.includes('seq gap')) {
        findings.push({ type: 'seq-gap', file, dir: e.name, detail: r.detail, committedEvents: r.committedEvents })
      }
    }
  }
  return { matched: findings.length > 0, findings }
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
    { id: 'credentials_fix', name: '.credentials.yaml 扁平格式修复（嵌套 refs/version 不识别）', layers: ['system'], diagnose: () => diagnoseCredentialsFormat(dshHome), fix: () => fixCredentialsFormat(dshHome) },
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

// ============ 工具 7：.credentials.yaml 扁平格式修复（credentials_fix，2026-08-22 救援教训） ============

/**
 * 诊断 .credentials.yaml 是否被写成「嵌套 refs/version 包装」，而 DSH 的
 * parseCredentialsDocument 要求纯扁平 mapping（顶层 key → 字符串值）。
 * 嵌套写法被 DSH 拒绝 → credentials 插件加载失败 → DSH 起不来（实测：the value for "version"/"refs" must be a string）。
 *
 * @param {string} dshHome
 * @returns {Promise<{matched:boolean, findings:Array}>}
 */
export async function diagnoseCredentialsFormat(dshHome) {
  const findings = []
  const file = join(dshHome, '.credentials.yaml')
  try {
    await fs.access(file, constants.R_OK)
  } catch {
    return { matched: false, findings } // 文件不存在/不可读：不是本工具的故障
  }
  try {
    const raw = await fs.readFile(file, 'utf8')
    // 嵌套特征：顶层出现 `refs:` 或 `version:` 键（值非字符串）
    const hasNestedRefs = /(^|\n)\s*refs\s*:\s*(\n|$)/m.test(raw)
    const hasVersionKey = /(^|\n)\s*version\s*:\s*(?!["'])/m.test(raw) // version 裸值（非引号字符串）
    if (hasNestedRefs || hasVersionKey) {
      findings.push({ type: 'nested-refs', detail: '.credentials.yaml 被写成 refs/version 嵌套，DSH 要求扁平 mapping（2026-08-22 实测：credentials-local must be a string）' })
    } else {
      // 再验证顶层每个值都是字符串（DSH 校验）
      try {
        const { parse } = await import('../lib/vendor/yaml.mjs').catch(() => ({ parse: null }))
        if (parse) {
          const doc = parse(raw)
          if (doc && typeof doc === 'object' && Object.entries(doc).some(([, v]) => typeof v !== 'string' && v !== null)) {
            findings.push({ type: 'non-string', detail: '.credentials.yaml 存在非字符串值，DSH 要求每个凭据值为 string' })
          }
        }
      } catch { /* vendor yaml 缺失则跳过深度校验 */ }
    }
  } catch (e) {
    findings.push({ type: 'read-error', detail: `读取 .credentials.yaml 失败: ${String(e?.message ?? e)}` })
  }
  return { matched: findings.length > 0, findings }
}

/**
 * 修复 .credentials.yaml：把嵌套 refs/version 重写为 DSH 期望的扁平 mapping（顶层 key → 字符串）。
 * 只保留 refs 下的真正凭据键；version 等非凭据键剔除；保留 key 值，写回后复验。
 *
 * @param {string} dshHome
 * @returns {Promise<{ok:boolean, done?:string[], detail?:string, error?:string}>}
 */
export async function fixCredentialsFormat(dshHome) {
  const { matched, findings } = await diagnoseCredentialsFormat(dshHome)
  if (!matched) return { ok: true, skipped: true, detail: '.credentials.yaml 已是扁平格式' }
  const file = join(dshHome, '.credentials.yaml')
  try {
    const raw = await fs.readFile(file, 'utf8')
    // 备份
    const bak = `${file}.bak-credentials-${Date.now()}`.replace(/#/g, '-')
    await fs.copyFile(file, bak)
    // 提取 refs 下的 key:value 行
    const refRe = /^\s{2,}([A-Za-z0-9_]+):\s*(.+)$/gm
    const entries = []
    let m
    while ((m = refRe.exec(raw))) {
      const key = m[1]
      const val = m[2].trim().replace(/^"|"$/g, '')
      if (val) entries.push([key, val])
    }
    // 若没有 refs 行，尝试顶层非引号/引号字符串行（兼容非嵌套但非字符串的 case）
    if (!entries.length) {
      const flatRe = /^([A-Za-z0-9_]+):\s*"?(.+?)"?\s*$/gm
      let m2
      while ((m2 = flatRe.exec(raw))) {
        const key = m2[1], val = m2[2].trim()
        if (key !== 'version' && key !== 'refs' && val) entries.push([key, val])
      }
    }
    if (!entries.length) return { ok: false, error: '未能从 .credentials.yaml 提取到任何凭据键，未改写（保守）' }
    // 重写为扁平
    const flat = entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n'
    await fs.writeFile(file, flat, { mode: 0o600 })
    // 复验
    const re = await diagnoseCredentialsFormat(dshHome)
    const done = [`已修复 .credentials.yaml 为扁平格式（${entries.length} 个凭据键；备份 ${bak.split('/').pop()}）`]
    return { ok: re.findings.length === 0, done, detail: done[0], remaining: re.findings.map((f) => f.detail) }
  } catch (e) {
    return { ok: false, error: `credentials 修复失败: ${String(e?.message ?? e)}` }
  }
}
