---
name: skill.session-manager
description: git-rescue 联动 dsh-session-manager 契约（按 linkage-skill-convention 规范）：崩溃检出后自动探测 session-manager 并调用其 scan/continue 续跑中断会话（装了才调、没装跳过、不内置）。含接口速查（list/scan/continue）、探测规则（404/405=未装跳过，200/5xx=已装）、联动时机与验证。处理「崩溃后怎么自动恢复会话」「git-rescue 与 session-manager 联动」「会话续跑机制」时加载。
whenToUse: 涉及 git-rescue 崩溃后自动续跑会话、session-link 联动机制、判断 session-manager 是否装了/可调用时。
generatedBy: EIGHTfs 2026-08-20（合并版补契约）
---

# git-rescue 联动 dsh-session-manager（契约）

> 联动方向：**git-rescue ──▶ dsh-session-manager**（崩溃后自动恢复中断会话）
> 按 linkage-skill-convention：本文件是契约，session-manager 完整档案见其仓库 `skills/`，不重复。
> 实现代码：`lib/session-link.js`（2.0.0 合并自旧版）。

## 一、session-manager 是什么（一句话）
会话管理插件：会话列表/续跑/分组/归档/峰谷控制，崩溃后可用 `scan` 扫描并自动续跑中断会话。

## 二、接口速查（git-rescue 用到的部分）

| API | 方法 | 用途 |
|-----|------|------|
| `/api/session-manager/list` | GET | 探测（0.4+）；返回会话列表 |
| `/api/session-manager/scan` | POST | 扫描全部会话并自动续跑可续的（0.3+） |
| `/api/session-manager/continue` | POST | 续跑单会话 `{sessionId}` |
| `/api/session-manager/detach` | POST | 释放会话（非 live 时返回 not-live） |
| `/api/session-manager/peak-status` | GET | 峰谷状态（pauseAutoContinue/isPeakHour） |

## 三、联动规则（关键）

- **装了才调用，没装就不调用，不内置**：探测 `list` 或 `scan`，**404/405 = 未装（跳过）**；**200 或 5xx = 已装**（5xx 是服务在响应但内部错误，仍算已装）
- 全部失败静默（联动失败不影响 git-rescue 主流程）
- 调用时机：git-rescue 启动检出崩溃（crash-detected）后 → `scan` 续跑
- 手动触发：`git_rescue_link_recovery` 工具 / `POST /api/git-rescue/link-session-recovery`

## 四、验证方法

- `GET /api/session-manager/list` 200 = session-manager 已装（联动可用）
- 崩溃后 events.jsonl 出现 `session-recovery-link` 事件（available=true 且 ok=true）
- 续跑后目标会话 `running=true`（session-manager list 可见）

## 五、完整档案

- session-manager 档案：`dsh-session-manager/skills/`（本项目，多个）
- 通用交接流程：`linkage-skill-convention.md` 第六节
- 崩溃救援主流程：`dsh-rescue-restore.md`（权威）
