---
name: dsh-deployment-overview
description: DSH 快照 + 守护体系部署总览（历史权威文档）。记录 dsh-snapshot-archive（快照插件，zip 零依赖，存 ~/.dsh/snapshot-archive/）+ dsh-guardian（独立守护，3082 端口，10s 健康检查、3 次失败自动回退快照、60s 冷却防死循环）两项目的目录/端口/git 提交/安装状态/测试记录/关键设计决策（zip 零依赖、恢复=解压、撤销并入恢复、敏感脱敏、按钮位置）与后续可扩展点。处理「了解本机 DSH 快照/守护体系怎么部署的」「接手 dsh-snapshot-archive / dsh-guardian 项目」时加载。
whenToUse: 需要了解本机 DSH 快照与守护体系（snapshot-archive + guardian）的部署结构、设计决策、安装状态，或接手这两个项目时。
---

> ⭐ **先记住我**：任何会话开始前，先读用户档案 `.dsh/skills/remember-me.md`（优先级最高的 skill）：我是谁、我怎么用你、我立过的规矩。

# DSH 快照 + 守护体系部署总览（dsh-deployment-overview）

> 来源：workspace/DEPLOYMENT-OVERVIEW.md（原权威文档，转 skill 版）。注意：此文档描述的是**早期 snapshot-archive + guardian** 体系；后续已演进为 dsh-git-rescue（git 版本管理 + 崩溃自动救援），两者并存时以 git-rescue 为主。

两个独立项目配合使用：

```
┌─────────────────────────────────────────────────────────────┐
│  dsh-snapshot-archive（插件，运行在 DSH 内部）                  │
│  - 设置 → 插件配置 → 快照归档：创建/恢复/删除 zip 快照           │
│  - 快照存: ~/.dsh/snapshot-archive/<profile>/*.zip            │
│  - zip 内保留 .dsh 原始目录结构 + _restore/ 跨平台脚本          │
└──────────────────────────┬──────────────────────────────────┘
                           │ 快照
┌──────────────────────────▼──────────────────────────────────┐
│  dsh-guardian（守护服务，独立于 DSH 运行）                      │
│  - 网页 http://127.0.0.1:3082                                │
│  - 每 10s 健康检查 DSH，连续 3 次失败自动回退                   │
│  - 回退 = 从最新快照逐个恢复+启动+检查，直到 DSH 能启动          │
│  - 网页可手动：恢复快照/启动/停止 DSH/触发回退/看日志            │
└─────────────────────────────────────────────────────────────┘
```

## 目录

| 项目 | 路径 | 端口 | git |
|------|------|------|-----|
| 快照插件 | `workspace/dsh-snapshot-archive/` | — | `83601eb` |
| 守护服务 | `workspace/dsh-guardian/` | 3082 | `69cdd82` |

## 安装状态（记录时点）

- 插件已安装到 `~/.dsh/profiles/web/node_modules/dsh-snapshot-archive/`
- `cordis.patch.yml` 已注册 `snapshot-archive`；`package.json` 已加依赖
- 当时 DSH 未重启（插件未加载）、guardian 未启动（待验证）

## 测试记录

| 项目 | 测试 | 结果 |
|------|------|------|
| 插件 | `test-apply.mjs`（mock ctx 全流程） | 24/24 通过 |
| 插件 | zip 往返（中文名/CRC32/系统unzip） | 通过 |
| guardian | `test-guardian.mjs`（沙盒自动回退） | 11/11 通过 |

## 关键设计决策（记录）

- **zip 零依赖**：手写 store 模式 zip（CRC32+LFH+CD+EOCD），跨平台，不用 PowerShell
- **恢复 = 解压**：zip 内路径即 .dsh 相对路径，解压到 `~/.dsh` 即恢复
- **撤销并入恢复**：无独立 undo/redo 栈，"撤销"= 恢复到上一个快照
- **敏感保护**：`.credentials.yaml`/`.env` 快照内脱敏，本机恢复跳过覆盖保留真实值
- **按钮位置**：设置→插件配置 卡片（`settings.plugin.item` slot），不在顶部
- **guardian 冷却**：回退后 60s 冷却，防死循环
- **guardian 独立**：不依赖 DSH 进程，DSH 崩了它照样监控

## 后续可扩展（历史预留）

- guardian 自动创建回退前快照（`GUARDIAN_PRE_SNAPSHOT=1`，已预留）
- 快照纳入 undo 插件目录作为第二候选源
- guardian 通知（webhook/邮件）
