---
name: skill.tasklist
description: git-rescue 联动 dsh-tasklist 契约（按 linkage-skill-convention 规范）：救援/测试环境会话的代码改动通过任务清单交接主环境提交（测试环境 git 提交被门禁拦），清单由 dsh-tasklist API 管理。处理「救援环境改动怎么交接提交」「测试环境会话改动走清单交接」「git-rescue 与任务清单的衔接」时加载。
whenToUse: 在测试/纯净/救援环境会话中改了代码需要交接主环境提交、或确认 git-rescue 与 dsh-tasklist 的衔接时。
generatedBy: user-request 2026-08-20（EIGHTfs：a联动b，a中是skill.b.md；契约独立存）
---

# git-rescue 联动 dsh-tasklist（契约）

> 联动方向：**git-rescue ──▶ dsh-tasklist**（测试环境会话改动走清单交接）
> 按 linkage-skill-convention：本文件是契约，dsh-tasklist 完整档案见其仓库 `skills/dsh-tasklist.md`，不重复。

## 一、dsh-tasklist 是什么（一句话）
任务清单插件：自动维护「任务」工作区，代码级 API 管理任务清单 md（命名 `任务清单-<类型>-<主题>-<日期>.md`）。

## 二、接口速查（git-rescue 用到的部分）
- `POST /api/tasklist/create`：创建交接清单 `{type:'git-handoff', title, sections:{repos[], items[]}}`
- `GET /api/tasklist/list` / `read?name=`：查看清单与勾选进度
- 清单根目录：`/vol1/@appshare/DeepSeekHarness/任务`（.dsh 同层级，任何环境可读写）

## 三、联动方式
- 测试/纯净环境会话（DSH_HOME 含 dsh-test-*）改动 git-rescue 等代码后：**不要绕过门禁手动 push**，调 `/api/tasklist/create` 生成交接清单（涉及仓库写 sections.repos，可多个）
- 主环境会话读取清单 → 按「提交命令」执行 commit+push → 勾选完成
- 主实例崩溃期间也可布置/沉淀任务：清单是普通 md，不依赖主实例进程

## 四、验证方法
- `GET /api/tasklist/list` 能扫到新清单；主环境提交推送成功后勾选对应项
- 救援场景：崩溃前后清单文件均落盘「任务」文件夹，`ls 任务/任务清单-*.md` 可见

## 五、完整档案
- dsh-tasklist 档案：`dsh-tasklist/skills/dsh-tasklist.md`（本项目）
- 通用交接流程：`linkage-skill-convention.md` 第六节
