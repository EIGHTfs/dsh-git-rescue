/**
 * dsh-git-rescue — profile 变化提交 git 时的 zip 还原点（unzip 手动覆盖小功能）
 *
 * 背景（用户确立，2026-08-21）：旧快照恢复插件「备份变化的文件但作者水平不够，
 * 恢复没有全自动恢复还改了文件名都不方便手动覆盖恢复」→ 本功能修正：
 *   - zip 内保留文件【原始相对路径】（根目录 = .dsh），恢复 = 手动解压覆盖同名文件
 *   - profile 变化提交 git 时自动打包还原点（提交前生成，随提交点留存）
 *   - 压缩包文件名后缀标注「是哪个插件导致的这次变化」（从 cordis.patch.yml 的
 *     diff 新增行推断插件名；推断不到回退 config/unknown）
 *
 * 定位：纯救援小功能——git 是主恢复通道，zip 是「不依赖 git 的手动覆盖兜底」。
 * 恢复命令示例（zip 在 .dsh 根目录时）：
 *   cd ~/.dsh && unzip -o git-rescue/restore-points/profile-restore-*.zip
 *
 * zip 内 manifest.json 记录元信息（生成时间/原因/触发插件/文件清单），
 * 文件名格式：profile-restore-<YYYYMMDD-HHmmss>-<plugin|config|unknown>.zip
 */

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { zipStore, unzipStore } from './zip.js'
import { runGit } from './git.js'

/** 还原点存放目录：<dshRoot>/git-rescue/restore-points/（git-rescue/ 已被 .gitignore 排除，不入库） */
export function restorePointDir(dshRoot) {
  return join(dshRoot, 'git-rescue', 'restore-points')
}

/** 文件名时间戳：20260821-103000 */
export function restoreStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 清洗插件名（文件名安全）：非 [A-Za-z0-9._-] → '-' */
export function sanitizePluginName(name) {
  return String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown'
}

/**
 * 从 git diff 推断触发本次 profile 变化的插件名。
 * 依据：cordis.patch.yml 的新增行（+ 开头）——插件注册块里的 `name:` / `id:` 字段，
 * 以及块上方 `# dsh-xxx：…` 注释。多个插件命中时取第一个（按出现顺序）。
 * 推断不到返回 null（调用方回退 config/unknown）。
 * @param {string} dshRoot .dsh 仓库根
 * @returns {Promise<string|null>}
 */
export async function inferPluginFromDiff(dshRoot) {
  try {
    // 只看未提交 diff（含已暂存 + 未暂存），范围限 cordis.patch.yml
    const r = await runGit(['diff', 'HEAD', '--', 'profiles/*/cordis.patch.yml'], { cwd: dshRoot })
    if (!r.ok) return null
    const added = r.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    for (const line of added) {
      const content = line.slice(1).trim()
      // name: 'dsh-xxx' / name: dsh-xxx / name: "@scope/pkg"
      let m = content.match(/^name:\s*['"]?([\w@./-]+)['"]?\s*$/)
      if (!m) m = content.match(/^id:\s*['"]?([\w.-]+)['"]?\s*$/)
      if (!m) m = content.match(/^#\s*(dsh-[\w.-]+)[:：]?/)
      if (m && m[1]) {
        const p = m[1].trim()
        // 排除非插件常见 id（如 web/main 等非 dsh- 前缀且无 @ 作用域）
        if (p.startsWith('dsh-') || p.startsWith('@') || p.includes('/')) return p
      }
    }
    return null
  } catch { return null }
}

/**
 * 收集 .dsh 仓库当前【未提交】的 profile/配置类变更文件（相对 .dsh 的路径）。
 * 复用 git.js 的配置类路径白名单（与 restoreProfileOnly 一致），
 * 排除数据目录（sessions/storages/git-rescue 等已被 .gitignore 排除，diff 不会出现）。
 * @param {string} dshRoot
 * @returns {Promise<string[]>} 变更文件相对路径列表
 */
export async function collectChangedProfileFiles(dshRoot) {
  try {
    const r = await runGit(['status', '--porcelain'], { cwd: dshRoot })
    if (!r.ok) return []
    const CONFIG_PREFIXES = ['profiles', 'settings.yaml', 'skills', '.anonymous-user-id', '.gitignore']
    const out = []
    // 注意：runGit 会 trim 输出，首行 ` M xxx` 前导空格可能丢失，不能用固定 slice(3)；
    // 用「状态码 1-2 字符 + 空白 + 路径」正则稳健解析
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^[ MADRCU?!]{1,2}\s+(.+)$/)
      if (!m) continue
      const rel = m[1].trim().replace(/\\/g, '/')
      if (!rel) continue
      const top = rel.split('/')[0]
      if (!CONFIG_PREFIXES.includes(top)) continue
      out.push(rel)
    }
    return out
  } catch { return [] }
}

/**
 * 生成一次 profile 还原点 zip（提交 git 前调用）。
 * 内容：全部未提交的 profile/配置类变更文件，zip 内路径 = 相对 .dsh 的原始路径
 *      （根目录 = .dsh → 手动 unzip 覆盖即恢复）。
 * 文件名：profile-restore-<YYYYMMDD-HHmmss>-<plugin|config|unknown>.zip
 * @param {object} opts { dshRoot, reason }  reason 写入 manifest（如 'periodic'/'manual'）
 * @returns {Promise<{ok:boolean, path?:string, name?:string, plugin?:string|null, count?:number, error?:string}>}
 */
export async function buildRestorePoint({ dshRoot, reason = 'manual' }) {
  try {
    const rels = await collectChangedProfileFiles(dshRoot)
    if (!rels.length) return { ok: true, empty: true, count: 0, path: null }

    // 读取变更文件内容（原相对路径）
    const files = []
    for (const rel of rels) {
      try {
        const data = await fs.readFile(join(dshRoot, rel))
        files.push({ name: rel, data })
      } catch { /* 文件已删除则跳过（还原点只保留现存文件） */ }
    }
    if (!files.length) return { ok: true, empty: true, count: 0, path: null }

    // 推断触发插件
    const plugin = await inferPluginFromDiff(dshRoot)
    const tag = plugin ? sanitizePluginName(plugin) : 'config'

    // manifest + 文件一起打包
    const manifest = Buffer.from(JSON.stringify({
      kind: 'profile-restore',
      createdAt: new Date().toISOString(),
      reason,
      plugin: plugin || null,
      files: files.map((f) => f.name),
    }, null, 2), 'utf8')
    const zipBuf = zipStore([{ name: 'manifest.json', data: manifest }, ...files])

    const dir = restorePointDir(dshRoot)
    await fs.mkdir(dir, { recursive: true })
    const name = `profile-restore-${restoreStamp()}-${tag}.zip`
    const path = join(dir, name)
    await fs.writeFile(path, zipBuf, { mode: 0o600 })
    return { ok: true, path, name, plugin, count: files.length }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 列出现有还原点（按文件名倒序，最新在前）。 */
export async function listRestorePoints(dshRoot) {
  try {
    const dir = restorePointDir(dshRoot)
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.zip')).sort().reverse()
    const out = []
    for (const n of names) {
      const stat = await fs.stat(join(dir, n)).catch(() => null)
      out.push({ name: n, size: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 })
    }
    return { ok: true, points: out }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 手动覆盖恢复：把还原点 zip 解压覆盖到 .dsh 根（同名文件覆盖）。
 * zip 内 manifest.json 不落盘（仅元信息）。
 * @param {object} opts { dshRoot, name }  name = 还原点文件名（含 .zip）
 * @returns {Promise<{ok:boolean, restored?:string[], skipped?:string[], error?:string}>}
 */
export async function restoreRestorePoint({ dshRoot, name }) {
  try {
    // 文件名白名单校验：仅允许 profile-restore-*.zip 且不带路径分隔符（防穿越）
    if (!name || !/^profile-restore-[0-9]{8}-[0-9]{6}-[\w.-]+\.zip$/.test(name)) {
      return { ok: false, error: `非法还原点文件名: ${name}` }
    }
    const dir = restorePointDir(dshRoot)
    const zipPath = join(dir, name)
    const buf = await fs.readFile(zipPath)
    const entries = unzipStore(buf)
    const restored = []
    const skipped = []
    for (const [rel, data] of entries) {
      if (rel === 'manifest.json') continue
      // 路径安全：绝对路径/上级目录穿越一律拒绝
      if (rel.startsWith('/') || rel.startsWith('\\') || rel.split('/').includes('..')) {
        skipped.push({ name: rel, reason: 'unsafe-path' })
        continue
      }
      const dest = join(dshRoot, rel)
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, data)
      restored.push(rel)
    }
    return { ok: true, restored, skipped }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 删除一个还原点（按文件名）。 */
export async function removeRestorePoint({ dshRoot, name }) {
  try {
    if (!name || !/^profile-restore-[0-9]{8}-[0-9]{6}-[\w.-]+\.zip$/.test(name)) {
      return { ok: false, error: `非法还原点文件名: ${name}` }
    }
    const p = join(restorePointDir(dshRoot), name)
    await fs.rm(p, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
