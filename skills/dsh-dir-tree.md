---
name: dsh-dir-tree
description: 【dsh-git-rescue 插件工具 skill（2026-08-21 固化）】目录结构查看工具 tools/dir-tree.mjs 的完整用法——零依赖、全平台兼容 Node.js 优先（不依赖 shell tree 命令，Linux/macOS/Windows 通用），默认只列目录不列文件、默认 2 层（项目文件夹那一层），支持深度/文件/隐藏/排除/JSON 五种参数，可 CLI 直接运行也可 import 调用。处理「查看目录结构/列目录树/巡检项目文件夹/救援时摸清目录布局」类任务时加载。
whenToUse: 需要查看任意目录的项目结构、救援/巡检场景摸清目录布局、要求"只要目录不要文件""只到项目文件夹那一层"、需要全平台可用的目录树方法时。
generatedBy: EIGHTfs 2026-08-21（用户指令：「把获取目录结构的方法写成代码放救援恢复插件」+「注意代码要全平台兼容的nodejs优先」）
---

# dsh-git-rescue 目录结构查看工具（dir-tree）

> 2026-08-21 用户指令固化：把「获取目录结构的方法」写成独立代码放入救援恢复插件（dsh-git-rescue），
> **不植入插件主入口**（独立方法代码），且**代码全平台兼容 Node.js 优先**——零依赖、纯 node:fs/node:path 实现，
> 不依赖 shell 的 `tree` 命令（Windows 无 tree，macOS/Linux 有但行为不一）。

## 一、文件位置与设计原则

| 项 | 值 |
|----|----|
| 代码文件 | `dsh-git-rescue/tools/dir-tree.mjs`（插件项目 tools/ 下，独立文件，不植入 lib/index.js） |
| 单测 | `dsh-git-rescue/test-git-rescue.mjs` **T13**（buildDirTree 导出/text/计数/dirsOnly/不存在路径/平台兼容） |
| 定位 | 纯救援工具：救援/巡检场景摸清目录布局 |
| 零依赖 | 只用 `node:fs/promises`（readdir/lstat/stat/readlink）+ `node:path`（join/basename）+ `node:url`（pathToFileURL） |

**全平台兼容要点（2026-08-21 用户强调，改代码必须遵守）**：
1. **不用 shell 命令**（tree/find/ls）——用 `readdir(dir, { withFileTypes: true })` 纯 Node API，Windows/Linux/macOS 行为一致
2. **路径拼接用 `node:path` 的 `join`/`basename`**——自动处理 `/` 与 `\` 分隔符差异
3. **CLI 直接运行判定用 `pathToFileURL(process.argv[1]).href === import.meta.url`**——不能用 `file://` 字符串拼接（Windows 盘符路径会失效）
4. **符号链接判断用 `stat`（跟随）而非 `lstat`**——`lstat` 不跟随链接会把链接目录当普通项跳过；`readlink` 读目标标注 `->`
5. **隐藏项/排除项/深度用通用逻辑**，不依赖平台特性

## 二、CLI 用法

```bash
cd <插件目录>
node tools/dir-tree.mjs <路径> [--depth N] [--files] [--hidden] [--exclude a,b] [--json]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `<路径>` | `.` | 起始目录（相对/绝对均可） |
| `--depth N` | `2` | 最大层级：1=只看一级子目录；2=项目文件夹那一层（用户常用口径） |
| `--files` | 关 | 开启后同时列出文件（默认只列目录） |
| `--hidden` | 关 | 显示隐藏项（默认跳过 `.` 开头） |
| `--exclude a,b` | 内置 | 追加排除目录名；内置排除：node_modules/.git/.cache/.npm/.local/.config/scoped_dir/__pycache__/dist/build/.idea/.vscode |
| `--json` | 关 | 输出结构化 JSON（`{name, children:[…], isDir, truncated, linkTarget}`） |
| `-h`/`--help` | — | 打印用法 |

## 三、模块调用

```js
import { buildDirTree } from './tools/dir-tree.mjs'

const tree = await buildDirTree('/vol1/@appshare/DeepSeekHarness', {
  depth: 2,        // 默认 2 = 项目文件夹那一层
  dirsOnly: true,  // 默认 true = 只列目录
  showHidden: false,
  exclude: new Set(['node_modules', '.git']), // 默认有内置排除集
})
console.log(tree.text) // 树形文本（│ ├── └── 风格）
console.log(tree.data) // 结构化 JSON
console.log(tree.dirs, tree.files) // 目录/文件计数
```

## 四、返回值

`{ root, text, data, dirs, files }`

- `text`：树形文本，根路径首行 + `├──`/`└──` 分支，深层省略标注 `（…更深层省略）`
- `data`：嵌套 JSON，节点 `{name, children?, isDir, truncated?, linkTarget?}`
- `linkTarget`：符号链接目标（如 `gamebanana-mods-downloader -> /vol02/...`）
- 路径不存在/无权限：不崩溃，text 标注 `（不存在或无权限）`，dirs=0

## 五、实测记录（2026-08-21）

| 场景 | 结果 |
|------|------|
| `node tools/dir-tree.mjs /vol1/@appshare/DeepSeekHarness`（默认） | ✅ 54 个目录，与 `tree -L 2 -d` 口径一致（排除隐藏后） |
| 符号链接目录 | ✅ `gamebanana-mods-downloader -> /vol02/1000-0-1c60be7b/gamebanana-mods-downloader` |
| `--files` 列文件 | ✅ `0 个目录, 1 个文件` |
| 路径不存在 | ✅ 不崩溃，标注不存在 |
| `--exclude workspace,任务` 自定义排除 | ✅ 生效 |
| import 模块调用 | ✅ text/data/dirs/files 全部可用 |
| 单测 T13 | ✅ 全绿（7 断言） |

## 六、已知坑

| 坑 | 处理 |
|----|------|
| `lstat` 不跟随符号链接 → 链接目录被跳过 | 用 `stat()`（跟随）判断 isDirectory + `readlink()` 取目标 |
| CLI 解析把 `--exclude` 的值当路径 | 循环解析选项值（`--depth`/`--exclude` 用 `++i` 消费值），第一个非选项参数才是路径 |
| Windows 路径 `file://` 拼接失效 | 直接运行判定用 `pathToFileURL` |
| 路径不存在时 `walk` 返回 null 导致 render 崩溃 | `?? { name, children: [] }` 兜底空节点 |

## 七、配套

- `dsh-git-rescue`：插件档案（本项目）
- `dsh-git-rescue-codelevel-repair`：代码级能力清单（本工具为独立方法，不属 repair-tools）
- `dsh-test-env`：测试环境用法
