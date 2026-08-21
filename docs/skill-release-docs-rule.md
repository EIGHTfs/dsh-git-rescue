---
name: release-docs-rule
description: 发版文档约定（通用约束）：**新功能提交必须整理 README 文档**（功能说明/版本记录/使用方式），**bug 修复除非严重 bug 可不写 README**。适用于本机所有 DSH 相关项目与仓库。涉及提交新功能、发版、更新 README、判断某提交是否要写文档时加载。
whenToUse: 任何项目新增功能准备提交/发版、需要更新 README、判断一次提交（新功能 vs bug 修复）是否该写文档、评审他人提交时。与 versioning-rule（版本号）配套使用。
---

# 发版文档约定（release-docs-rule）

> 来源：用户 2026-08-18 制定（dsh-git-rescue 开发过程中定下的规矩）。
> 核心一句话：**新功能必须留文档，小修小补不必惊动 README。**

## 规则

### 新功能（必须写 README）

每次提交**新功能**（功能序号 Y+1，见 versioning-rule），必须整理 README 文档，至少包含：

1. **功能说明**：README 的「功能」章节新增该功能条目（一句话 + 关键能力列表）
2. **版本记录**：README 版本表新增一行（版本号 + 功能内容）
3. **使用方式**：新增 API / Agent 工具 / 配置项要在 README 中说明
4. **版本号同步**：README 标题版本号与 package.json 一致
5. **配套档案**：如有新机制/新方案，附一份独立文档（如 skill 档案或 docs/ 下的说明）

检查清单（提交前自查）：

- [ ] 版本号已递增（Y+1，Z 归零）
- [ ] README 功能章节有该功能条目
- [ ] README 版本表有该版本行
- [ ] README 标题版本号与 package.json 一致
- [ ] 新 API/工具/配置已说明

### bug 修复（一般可不写，严重 bug 必须写）

- **普通 bug 修复**（Z+1）：**可以不写 README**。提交信息写明修复内容即可。
- **严重 bug 修复**：**必须写 README**（至少版本表一行 + 已知坑/注意事项说明）。

**严重 bug 判定**（满足任一即算严重）：

- 插件/服务完全无法启动或核心功能不可用
- 数据丢失 / 损坏（会话、配置、仓库）
- 崩溃 / 无限重启 / 救援机制自身失灵
- 安全相关（凭据泄漏、越权、权限错误）
- 影响所有用户（非个例环境问题）

### 边界与例外

- 文档类提交（docs:）本身不需要重复写 README（除非它就是要更新 README）
- 新功能但纯内部实现（无用户可见 API/行为变化）——仍建议写一行版本记录，至少让版本表可追溯
- 拿不准时：**多写比少写好**；或问用户

## 落地位置（按项目）

| 项目 | README 位置 |
|------|-------------|
| dsh-git-rescue（三合一仓库） | 根 `README.md`（功能总览/组件章节）+ `components/<组件>/README.md`（版本记录） |
| gamebanana-mods-downloader | 见 readme-craft / versioning-rule skill |
| 其他 DSH 插件/工具 | 各自仓库根 README |

## 配套

- 版本号规则 → `versioning-rule` skill
- README 写作技巧 → `readme-craft` skill
- 本约定约束**所有 AI 会话**（本机 .dsh/skills 全局加载），不限于某个项目
