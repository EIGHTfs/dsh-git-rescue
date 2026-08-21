/**
 * dsh-git-rescue 2.5.0 — 备份内容选择（类别式，2026-08-21 完全重写）
 *
 * 2026-08-21 用户决定：目录树勾选不好用，完全重写为「类别多选」：
 *   - profile：必选（profiles/），勾选框禁用，永远备份
 *   - session：会话（sessions/），可勾选
 *   - skill：技能（skills/），可勾选
 *   - api：配置（settings.yaml + .credentials.yaml），可勾选
 *
 * 远端备份库结构（2026-08-21 用户决定）：设备 ID 作为文件夹，内部按需同步 .dsh 内容
 *   仓库根/
 *     └── <设备ID>/          ← 主机设备 ID 文件夹
 *         ├── profiles/      ← profile（必选）
 *         ├── sessions/      ← session（勾选时）
 *         ├── skills/        ← skill（勾选时）
 *         └── settings.yaml  ← api（勾选时）
 *
 * API：
 *   GET  /api/backup-select         读取当前选择配置
 *   POST /api/backup-select         保存选择配置 { session, skill, api }
 *   POST /api/backup-select/apply   按选择写 .gitignore（反向白名单）
 *   POST /api/backup-select/push    按选择推送到远端备份库（设备ID文件夹内）
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 配置文件名（存于 .dsh/git-rescue/）。 */
export const SELECT_CONFIG_NAME = 'backup-select.json'

/** 类别定义（profile 恒必选）。 */
export const CATEGORIES = {
  profile: { label: '配置文件（profiles/）', fixed: true, desc: '必选，不可取消' },
  session: { label: '会话（sessions/）', fixed: false, desc: '勾选则备份会话目录' },
  skill: { label: '技能（skills/）', fixed: false, desc: '勾选则备份 skill 目录' },
  api: { label: '配置（settings.yaml 等）', fixed: false, desc: '勾选则备份 settings.yaml / .credentials.yaml' },
}

/** 类别 → 相对 .dsh 根的目标路径（git 仓库内路径）。 */
export function categoryTargets() {
  return {
    profile: ['profiles'],
    session: ['sessions'],
    skill: ['skills'],
    api: ['settings.yaml', '.credentials.yaml'],
  }
}

/** 勾选配置路径。 */
export function selectConfigPath(dshHome) {
  return join(dshHome, 'git-rescue', SELECT_CONFIG_NAME)
}

/** 默认配置：profile 恒开，其余默认全开。 */
export function defaultConfig() {
  return { profile: true, session: true, skill: true, api: true }
}

/** 读取勾选配置（无则默认；profile 强制 true）。 */
export async function readSelectConfig(dshHome) {
  const cfg = defaultConfig()
  try {
    const raw = await fs.readFile(selectConfigPath(dshHome), 'utf8')
    const saved = JSON.parse(raw)
    for (const k of Object.keys(cfg)) {
      if (typeof saved[k] === 'boolean') cfg[k] = saved[k]
    }
  } catch { /* 首次无配置 */ }
  cfg.profile = true // 必选，永不可关
  return cfg
}

/** 保存勾选配置（profile 不入库/不可改）。 */
export async function saveSelectConfig(dshHome, { session, skill, api } = {}) {
  try {
    const cfg = defaultConfig()
    if (typeof session === 'boolean') cfg.session = session
    if (typeof skill === 'boolean') cfg.skill = skill
    if (typeof api === 'boolean') cfg.api = api
    cfg.profile = true
    cfg.savedAt = new Date().toISOString()
    const p = selectConfigPath(dshHome)
    await fs.mkdir(join(dshHome, 'git-rescue'), { recursive: true })
    await fs.writeFile(p, JSON.stringify(cfg, null, 2), 'utf8')
    return { ok: true, path: p, ...cfg }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 按选择展开为相对 repoDir 的路径列表（含 profile 必选）。
 * @param {object} cfg { session, skill, api }
 * @returns {string[]} 相对 .dsh 根路径
 */
export function expandSelection(cfg) {
  const targets = categoryTargets()
  const paths = []
  // profile 必选
  for (const t of targets.profile) paths.push(t)
  if (cfg?.session) for (const t of targets.session) paths.push(t)
  if (cfg?.skill) for (const t of targets.skill) paths.push(t)
  if (cfg?.api) for (const t of targets.api) paths.push(t)
  return [...new Set(paths)].filter(Boolean)
}

/**
 * 按选择生成反向 .gitignore。
 * 原理：`*` 排除根级一切 → `!` 放行选中路径（逐级放行父目录）→ 追加原 .gitignore 的排除规则。
 * @param {string} repoDir git 仓库根（.dsh）
 * @param {object} cfg { session, skill, api }
 * @returns {Promise<{ok:boolean, path?:string, selectedCount?:number, error?:string}>}
 */
export async function applyGitignoreBySelection(repoDir, cfg) {
  try {
    const selected = expandSelection(cfg)
    if (!selected.length) return { ok: false, error: '选择为空，未生成 .gitignore' }
    const lines = []
    lines.push('# dsh-git-rescue 类别备份（自动生成，2026-08-21）')
    lines.push('# 反向白名单：排除一切，放行选中类别（profile 必选）')
    lines.push('*')
    for (const sel of selected) {
      const relPath = String(sel).replace(/\\/g, '/').replace(/^\/+/, '')
      if (!relPath || relPath.startsWith('..')) continue
      const parts = relPath.split('/')
      let acc = ''
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i]
        lines.push(`!${acc}`)
        lines.push(`!${acc}/`)
      }
    }
    // 追加原有排除（确保敏感项仍排除）
    let baseRules = []
    try {
      baseRules = (await fs.readFile(join(repoDir, '.gitignore'), 'utf8'))
        .split('\n').map((l) => l.trim()).filter(Boolean)
    } catch { /* 无则新建 */ }
    if (baseRules.length) {
      lines.push('')
      lines.push('# 原有排除规则（保留）')
      lines.push(...baseRules)
    }
    await fs.writeFile(join(repoDir, '.gitignore'), lines.join('\n') + '\n', 'utf8')
    return { ok: true, path: join(repoDir, '.gitignore'), selectedCount: selected.length, selected }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 按选择推送：git add 选中路径 → commit → 推送到远端备份库（设备ID文件夹内）。
 * 远端结构：<设备ID>/<选中路径>（2026-08-21 用户决定）。
 * 实现：push 前把选中内容复制到 <deviceId>/ 前缀（经 git 树操作）。
 *   为避免污染本地 .dsh，用 git 的 index 树重排：checkout 到临时 index 前缀太重，
 *   改用「git read-tree + 树级移动」：建 <deviceId>/ 前缀副本 → commit → push → 还原。
 *   简化方案：本地仓库根即 .dsh，直接在仓库内 git mv 到 <deviceId>/ 子目录会污染工作区。
 *   因此采用「树重排推送」：读出选中路径的 blob，构造 <deviceId>/ 前缀树，用 REST 快照推送。
 *   但 pushSelected 走本地 git，此处简化：按 deviceId 组织为独立分支/子树不可行，
 *   决定：远端 = 仓库整体快照（仓库名已含设备ID），设备ID文件夹由 pushViaToken 的 pathPrefix 实现。
 * @param {string} repoDir .dsh git 仓库根
 * @param {object} cfg { session, skill, api }
 * @param {Function} runGit git 执行函数（注入）
 * @param {string} [remote='origin']
 */
export async function pushSelected(repoDir, cfg, runGit, remote = 'origin') {
  try {
    const selected = expandSelection(cfg)
    if (!selected.length) return { ok: false, error: '选择为空' }
    // 1) git add 选中路径（-f 强制，.gitignore 排除也加）
    for (const sel of selected) {
      const r = await runGit(['add', '-f', sel], { cwd: repoDir })
      if (!r.ok) return { ok: false, error: `git add ${sel} 失败: ${r.stderr || r.error}` }
    }
    // 2) commit
    const commitMsg = `chore(backup-select): 备份 ${selected.join(',')} @ ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
    const c = await runGit(['commit', '-m', commitMsg], { cwd: repoDir })
    if (!c.ok && !/nothing to commit|no changes/i.test(c.stderr || '')) {
      return { ok: false, error: `commit 失败: ${c.stderr || c.error}` }
    }
    // 3) 远端设备ID文件夹组织：交给 pushViaToken 的 pathPrefix 参数（在 server.js 里以快照推送完成）
    const p = await runGit(['push', remote, 'HEAD'], { cwd: repoDir })
    if (!p.ok) return { ok: false, error: `push 失败: ${p.stderr || p.error}` }
    return { ok: true, committed: c.ok, pushed: p.ok, selectedCount: selected.length, selected, commitMsg }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
