/**
 * dsh-git-rescue 2.0.0 — web 多选备份（会话/skill 定向备份，2026-08-20 EIGHTfs 需求）
 *
 * 流程：
 *  1. guardian 网页调 `GET /api/backup-select/tree` → 用 tools/dir-tree.mjs 生成目录树（根目录 . 可指定）供多选
 *  2. 用户勾选（目录级）→ `POST /api/backup-select` 保存为 `.dsh/git-rescue/backup-select.json`（可复用配置）
 *  3. `POST /api/backup-select/apply` → 按勾选写 .gitignore（反向白名单：`*` 排除 + `!选中项` 放行）
 *  4. `POST /api/backup-select/push` → git commit + 按勾选推送选中文件到备份仓
 *
 * .gitignore 反向白名单原理：
 *  - 根级 `*` 排除一切 → `!` 白名单放行勾选目录 → 确保勾选的会话/skill 被 git 跟踪
 *  - 保留原有的排除规则（node_modules/.git/credentials 等）在其后追加
 */

import { promises as fs } from 'node:fs'
import { join, relative, isAbsolute, resolve } from 'node:path'

/** 配置文件名（存于 .dsh/git-rescue/）。 */
export const SELECT_CONFIG_NAME = 'backup-select.json'

/** 勾选配置路径。 */
export function selectConfigPath(dshHome) {
  return join(dshHome, 'git-rescue', SELECT_CONFIG_NAME)
}

/**
 * 生成可选目录树（复用 tools/dir-tree.mjs）。
 * @param {string} root 起始目录（默认 .dsh 根）
 * @returns {Promise<{ok:boolean, root?:string, tree?:object, error?:string}>}
 */
export async function buildSelectableTree(root) {
  try {
    const { buildDirTree } = await import('../tools/dir-tree.mjs')
    const tree = await buildDirTree(root, { depth: 3, dirsOnly: false, showHidden: true })
    return { ok: true, root: tree.root, tree: tree.data, dirs: tree.dirs, files: tree.files }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 保存勾选配置（目录级路径数组，相对 root）。
 * @param {string} dshHome
 * @param {object} opts { root, selected: string[] }  selected 为相对 root 的目录路径
 */
export async function saveSelectConfig(dshHome, { root, selected = [] }) {
  try {
    const cfg = { root, selected: [...new Set(selected)].filter(Boolean), savedAt: new Date().toISOString() }
    const p = selectConfigPath(dshHome)
    await fs.mkdir(join(dshHome, 'git-rescue'), { recursive: true })
    await fs.writeFile(p, JSON.stringify(cfg, null, 2), 'utf8')
    return { ok: true, path: p, ...cfg }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 读取勾选配置（无则 null）。 */
export async function readSelectConfig(dshHome) {
  try {
    const raw = await fs.readFile(selectConfigPath(dshHome), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

/**
 * 按勾选生成反向 .gitignore。
 * 原理：`*` 排除根级一切 → `!` 放行选中目录（递归）→ 追加原 .gitignore 的排除规则。
 * @param {string} repoDir git 仓库根（.dsh）
 * @param {object} cfg { root, selected }
 * @returns {Promise<{ok:boolean, path?:string, selectedCount?:number, error?:string}>}
 */
export async function applyGitignoreBySelection(repoDir, cfg) {
  try {
    const selected = cfg?.selected || []
    if (!selected.length) return { ok: false, error: '勾选为空，未生成 .gitignore' }
    const rootAbs = resolve(cfg?.root || repoDir)
    // 原 .gitignore 排除规则（node_modules/credentials 等）
    let base = ''
    try { base = await fs.readFile(join(repoDir, '.gitignore'), 'utf8') } catch { /* 无则新建 */ }
    const baseRules = base.split('\n').map((l) => l.trim()).filter(Boolean)
    // 反向白名单：相对 repoDir 的路径（需逐级放行父目录，否则 git 不进入被忽略目录）
    const lines = []
    lines.push('# dsh-git-rescue web 多选备份（自动生成，2026-08-20）')
    lines.push('# 反向白名单：排除一切，放行勾选项（含父目录逐级放行）')
    lines.push('*')
    for (const sel of selected) {
      const relPath = relative(repoDir, isAbsolute(sel) ? sel : resolve(rootAbs, sel)).replace(/\\/g, '/')
      if (!relPath || relPath.startsWith('..')) continue
      // 逐级放行父目录链：sessions/会话A → !sessions → !sessions/ → !sessions/会话A → !sessions/会话A/
      const parts = relPath.split('/')
      let acc = ''
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i]
        lines.push(`!${acc}`)
        lines.push(`!${acc}/`)
      }
    }
    // 追加原有排除（确保敏感项仍排除）
    if (baseRules.length) {
      lines.push('')
      lines.push('# 原有排除规则（保留）')
      lines.push(...baseRules)
    }
    await fs.writeFile(join(repoDir, '.gitignore'), lines.join('\n') + '\n', 'utf8')
    return { ok: true, path: join(repoDir, '.gitignore'), selectedCount: selected.length }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 按勾选推送：git add 选中目录 → commit → push 到 origin（备份仓）。
 * @param {string} repoDir .dsh git 仓库根
 * @param {object} cfg { root, selected }
 * @param {Function} runGit git 执行函数（注入，避免重复实现）
 * @param {string} [remote='origin']
 */
export async function pushSelected(repoDir, cfg, runGit, remote = 'origin') {
  try {
    const selected = cfg?.selected || []
    if (!selected.length) return { ok: false, error: '勾选为空' }
    const rootAbs = resolve(cfg?.root || repoDir)
    // 1) git add 选中目录
    for (const sel of selected) {
      const relPath = relative(repoDir, isAbsolute(sel) ? sel : resolve(rootAbs, sel)).replace(/\\/g, '/')
      if (!relPath || relPath.startsWith('..')) continue
      const r = await runGit(['add', '-f', relPath], { cwd: repoDir }) // -f 强制（.gitignore 排除也加）
      if (!r.ok) return { ok: false, error: `git add ${relPath} 失败: ${r.stderr || r.error}` }
    }
    // 2) commit
    const commitMsg = `chore(backup-select): 按勾选备份 ${selected.length} 个目录 @ ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
    const c = await runGit(['commit', '-m', commitMsg], { cwd: repoDir })
    if (!c.ok && !/nothing to commit|no changes/i.test(c.stderr || '')) {
      return { ok: false, error: `commit 失败: ${c.stderr || c.error}` }
    }
    // 3) push 到备份仓
    const p = await runGit(['push', remote, 'HEAD'], { cwd: repoDir })
    if (!p.ok) return { ok: false, error: `push 失败: ${p.stderr || p.error}` }
    return { ok: true, committed: c.ok, pushed: p.ok, selectedCount: selected.length, commitMsg }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
