# 🧩 组件一览（三合一结构）

`dsh-git-rescue` 仓库按组件组织，每组件独立版本号（遵循 X.Y.Z：Y=功能序号，Z=bug 修复次数）。

| 目录 | 组件 | 职责 | 独立版本 |
|------|------|------|----------|
| `snapshot-archive/` | 组件 A：快照归档 | zip 全量快照 + 恢复脚本，DSH 插件 | 见其 `package.json` |
| `guardian/` | 组件 B：守护进程 | 独立进程探活 + zip 回退 + 拉起 DSH | 见其 `package.json` |
| `git-rescue/` | 组件 C：git 救援 | git 版本管理 + GitHub token 远端备份 + 崩溃自动回退（开发中） | 见其 `package.json` |

## 协同关系

- **A 快照归档**：零依赖兜底，网页全崩也能手动 `unzip` 恢复
- **B guardian**：网页/进程全崩时自动回退（基于 A 的 zip 快照）+ 拉起 DSH
- **C git 救援**：精细增量历史、可 diff、GitHub token 远端备份；崩溃回退基于 git commit

> 组件 B 当前基于组件 A 的 zip 快照做回退；组件 C 上线后，B 可扩展为「zip + git 双源回退」。
