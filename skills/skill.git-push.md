---
name: skill.git-push
description: git-rescue 联动 git-push 契约（按 linkage-skill-convention 规范）：测试环境会话改动代码后提交会被 git-push 门禁拦截（DSH_HOME 含 dsh-test-*），需按任务清单交接主环境提交。处理「测试环境提交被拦怎么办」「git 交接清单怎么走」「门禁与 git-rescue 判定口径」时加载。
whenToUse: 在测试环境会话中需要提交 git、收到门禁拦截提示、或理解 git-rescue 与 git-push 的环境判定一致性时。
generatedBy: user-request 2026-08-20（EIGHTfs：a联动b，a中是skill.b.md；契约独立存）
---

> ⭐ **先记住我**：任何会话开始前，先读用户档案 `.dsh/skills/remember-me.md`（优先级最高的 skill）：我是谁、我怎么用你、我立过的规矩。

# git-rescue 联动 git-push（契约）

> 联动方向：**git-rescue ──▶ git-push**（测试环境提交受其门禁约束）
> 按 linkage-skill-convention：本文件是契约，git-push 完整档案见其仓库 `dsh-git-push.md`，不重复。

## 一、git-push 是什么（一句话）
git 扫描/审计/提交推送插件（L0 审计 + 测试环境提交门禁 + repo-index 自动维护）。

## 二、接口速查（git-rescue 视角用到的部分）
- 门禁 `checkTestEnvCommitGate()`（`lib/core.js`）：DSH_HOME 含 `dsh-test-*` 时拦截 commit/push
- 拦截返回：`{ ok:false, blocked:true, error:'测试环境禁止 git 提交…请把改动写进 workspace 任务清单文件，交接主环境执行 commit+push' }`

## 三、联动方式
- 测试环境会话（如 DSH_HOME=dsh-test-home-clean）改动 git-rescue 代码后，**不要绕过门禁手动 push**（如 `git -c` 直推、改环境变量）
- 正确姿势：按通用交接流程（linkage-skill-convention 第六节）写任务清单文件到 workspace 根 → 主环境会话执行 commit+push
- 门禁判定规则与 git-rescue `isTestHomePath` 同口径（git-push 复制实现）

## 四、验证方法
- 测试环境调用 `commitAndPush` → `blocked:true`
- 任务清单文件出现在 workspace 根（`任务清单-提交-*.md`）
- 主环境按清单执行后，git log 出现对应提交

## 五、⚠️ 修改注意（坑）
- 门禁判定与 git-rescue `isTestHomePath` 同规则——改 git-rescue 的测试环境判定时，需同步 git-push `lib/core.js` 的 `isTestEnvHome()`，否则两插件判定口径漂移
