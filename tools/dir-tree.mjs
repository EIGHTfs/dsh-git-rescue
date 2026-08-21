#!/usr/bin/env node
/**
 * dir-tree.mjs — dsh-git-rescue 独立目录结构查看工具（零依赖）
 *
 * 用途：救援/巡检场景查看任意目录的项目结构，默认只列目录、不列文件、
 *      只到指定层级（默认 2 层 = 项目文件夹那一层），输出与 `tree` 相似的树形文本。
 * 独立方法：不植入插件主入口，可 import 调用，也可命令行直接运行。
 *
 * 用法（CLI）：
 *   node tools/dir-tree.mjs <path> [--depth N] [--files] [--hidden] [--exclude a,b] [--json]
 *
 * 用法（模块）：
 *   import { buildDirTree } from './tools/dir-tree.mjs'
 *   const tree = await buildDirTree('/vol1/@appshare/DeepSeekHarness', { depth: 2, dirsOnly: true })
 *   console.log(tree.text)   // 树形文本
 *   console.log(tree.data)   // 结构化 JSON
 */

import { readdir, lstat, stat, readlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

// 默认排除的噪音目录（与日常目录巡检口径一致）
const DEFAULT_EXCLUDE = new Set([
  'node_modules', '.git', '.cache', '.npm', '.local', '.config',
  'scoped_dir', '__pycache__', 'dist', 'build', '.idea', '.vscode',
])

/**
 * 递归构建目录树。
 * @param {string} root       起始目录绝对/相对路径
 * @param {object} opts
 * @param {number} opts.depth       最大深度（1 = 只看一级子目录；默认 2 = 项目文件夹那一层）
 * @param {boolean} opts.dirsOnly   只列目录不列文件（默认 true）
 * @param {boolean} opts.showHidden 是否显示隐藏项（默认 false）
 * @param {Set<string>} opts.exclude 排除的目录名集合（默认 DEFAULT_EXCLUDE）
 * @returns {Promise<{root:string, text:string, data:object, dirs:number, files:number}>}
 */
export async function buildDirTree(root, opts = {}) {
  const depth = opts.depth ?? 2
  const dirsOnly = opts.dirsOnly ?? true
  const showHidden = opts.showHidden ?? false
  const exclude = opts.exclude instanceof Set ? opts.exclude : DEFAULT_EXCLUDE

  const stats = { dirs: 0, files: 0 }
  const rootAbs = await resolveRoot(root)

  const data = await walk(rootAbs, 0, { depth, dirsOnly, showHidden, exclude }, stats, null) ?? { name: rootAbs, children: [] }
  const lines = []
  lines.push(rootAbs)
  render(data, '', lines)

  return {
    root: rootAbs,
    text: lines.join('\n'),
    data,
    dirs: stats.dirs,
    files: stats.files,
  }
}

async function resolveRoot(root) {
  try {
    return (await lstat(root)).isDirectory() ? root : root + '（不是目录）'
  } catch {
    return root + '（不存在或无权限）'
  }
}

async function walk(abs, level, cfg, stats, parentName) {
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return null // 无权限/已删除：跳过该分支
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  const node = { name: basename(abs) || abs, children: [] }
  for (const ent of entries) {
    const name = ent.name
    if (!cfg.showHidden && name.startsWith('.')) continue
    if (ent.isDirectory() && cfg.exclude.has(name)) continue

    const childAbs = join(abs, name)
    let isDir = ent.isDirectory()
    let linkTarget = null
    if (ent.isSymbolicLink()) {
      // 符号链接：stat 跟随链接判断是否为目录；标注目标，不递归（防环）
      try {
        const st = await stat(childAbs)
        isDir = st.isDirectory()
        linkTarget = await readlink(childAbs)
      } catch { /* 悬空链接：按普通项跳过 */ }
    }

    if (isDir) {
      stats.dirs++
      const child = level + 1 >= cfg.depth
        ? { name, isDir: true, truncated: true, linkTarget }
        : await walk(childAbs, level + 1, cfg, stats, name)
      if (child) node.children.push({ ...child, linkTarget: child.linkTarget ?? linkTarget })
    } else if (!cfg.dirsOnly) {
      stats.files++
      node.children.push({ name, isDir: false, linkTarget })
    }
  }
  return node
}

/** 渲染树形文本（│ ├── └── 风格，与 tree 一致）。 */
function render(node, prefix, lines) {
  const kids = node.children || []
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i]
    const last = i === kids.length - 1
    const branch = last ? '└── ' : '├── '
    const suffix = kid.linkTarget ? ` -> ${kid.linkTarget}` : ''
    const mark = kid.truncated ? '（…更深层省略）' : ''
    lines.push(`${prefix}${branch}${kid.name}${suffix}${mark}`)
    if (kid.children && kid.children.length) {
      render(kid, prefix + (last ? '    ' : '│   '), lines)
    }
  }
}

// ---------- CLI ----------

async function main(argv) {
  const args = [...argv]
  const opt = { depth: 2, dirsOnly: true }
  let root = null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--depth') { opt.depth = Number(args[++i]) || 2; continue }
    if (a === '--files') { opt.dirsOnly = false; continue }
    if (a === '--hidden') { opt.showHidden = true; continue }
    if (a === '--json') { opt.json = true; continue }
    if (a === '--exclude') {
      const list = (args[++i] || '').split(',').filter(Boolean)
      opt.exclude = new Set([...DEFAULT_EXCLUDE, ...list])
      continue
    }
    if (a === '-h' || a === '--help') {
      console.log(`用法: node tools/dir-tree.mjs <路径> [--depth N] [--files] [--hidden] [--exclude a,b] [--json]
  默认: 只列目录、深度 2 层（项目文件夹那一层）、排除 node_modules/.git 等噪音`)
      return
    }
    if (a.startsWith('-')) continue // 未知选项跳过
    if (root === null) root = a // 第一个非选项参数 = 路径
  }

  const tree = await buildDirTree(root ?? '.', opt)
  if (opt.json) {
    console.log(JSON.stringify(tree.data, null, 2))
    return
  }
  console.log(tree.text)
  console.log(`\n${tree.dirs} 个目录${opt.dirsOnly ? '' : `, ${tree.files} 个文件`}`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('dir-tree 错误:', e?.message ?? e)
    process.exit(1)
  })
}
