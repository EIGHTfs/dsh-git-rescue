---
name: linkage-skill-convention
description: 联动 skill 命名与放置规范（2026-08-20 固化）：插件间联动（a 依赖/调用 b）时，在发起方插件仓库 skills/ 放 skill.<被联动方>.md，内容为纯契约（接口速查+联动方式+验证），不重复被联动方完整档案；联动是单向箭头，只有双向联动才两边各放。附测试环境→主环境 git 交接通用流程（任务清单格式/命名）。处理「联动 skill 怎么命名/放哪/写什么」「跨插件依赖怎么文档化」「skill.b.md 该不该写」「测试环境提交怎么交接」类场景时加载。
whenToUse: 需要文档化两个插件之间的联动关系、创建/修改 skill.<对方>.md、判断某个联动 skill 该放哪个仓库、审查现有 skill 是否违反本命名规范、或测试环境改动需要交接主环境提交时。
generatedBy: user-request 2026-08-20（EIGHTfs：a联动b，a中是skill.b.md）
---

# 联动 skill 规范（linkage-skill-convention）

> 2026-08-20 用户（EIGHTfs）确立。约束所有 AI 所有会话。
> 核心一句话：**联动是单向箭头，skill 跟着箭头走——a 联动 b，a 里放 skill.b.md（纯契约）**。

## 〇、执行优先级（插件优先，skill 备案）

> 2026-08-20 用户补充：**任务清单插件（dsh-tasklist）是代码级负责"规范的联动"**；本 skill 在 `.dsh` 是任务清单插件**不在时**的备案。

| 场景 | 用谁 |
|---|---|
| 有 dsh-tasklist 插件 | **用插件**：`POST /api/tasklist/create` / `GET /api/tasklist/list` / `done` 等 HTTP API 管理任务清单（确定性代码管道，零 token） |
| 无 dsh-tasklist 插件 | **用本 skill 备案**：LLM 按第六节格式手写清单文件兜底 |

- 其他插件联动任务清单 = 调 dsh-tasklist API（`http://127.0.0.1:<端口>/api/tasklist/*`），不是调本 skill
- 本 skill 的第六节交接流程在两种模式下都适用：插件模式 = API 生成同样格式的清单文件；备案模式 = 手写同格式
- 本规范文件（linkage-skill-convention.md）在**每个参与联动的插件仓库 skills/ 各放一份**（2026-08-20 用户确认：规范联动 skill 每个联动插件都有一份）

## 一、定义

**联动** = 插件 a 依赖/调用插件 b（a 需要 b 的接口、规则或数据才能工作）。
**联动 skill** = 文档化这种依赖关系的 skill，放在「发起联动方」的插件仓库。

## 二、命名与放置规则（核心）

| 场景 | 放置位置 | 文件名 | 内容 |
|---|---|---|---|
| a 联动 b（a 依赖 b） | a 仓库 `skills/` | `skill.b.md` | 纯契约：b 的接口速查 + a 如何联动 b |
| b 不联动 a | b 仓库 | **不放** | — |
| 双向联动（a↔b 互依赖） | a、b 仓库各放 | a 放 `skill.b.md`，b 放 `skill.a.md` | 各自视角的契约 |

⚠️ **联动是单向箭头**：a 联动 b 不代表 b 联动 a。只有确认 b 也依赖 a，才在 b 仓库放 `skill.a.md`。

## 三、内容要素（契约，不重复档案）

`skill.b.md` 只写「a 视角需要知道的 b」，不复制 b 的完整文档：

1. **b 是什么**（一句话定位）
2. **b 的接口速查**（a 实际用到的 API / 规则 / 数据；不是 b 的全部接口）
3. **a 如何联动 b**（调用时序 / 触发条件 / 参数 / 失败处理）
4. **验证方法**（怎么确认联动生效）
5. **指向 b 完整档案**（一句话引用 b 自家 skill，如 `dsh-git-rescue.md`，不重复内容）

## 四、与现有 skill 的关系

- 插件自家档案 skill（如 `dsh-git-rescue.md`）：完整文档，留在插件自己仓库
- 联动契约 skill（`skill.<对方>.md`）：**只写联动视角**，引用档案不复制
- 通用方法 skill（如 git 交接流程）：留在 `.dsh/skills` + ai-work-archive，不进插件仓库
- 规范（本文件）：通用约定类，权威源 `.dsh/skills`，归档 ai-work-archive

## 五、执行流程

1. 确认联动方向（谁依赖谁，单向/双向）
2. 在发起方仓库建 `skill.<被联动方>.md`（契约五要素）
3. 双向联动时，对方仓库建 `skill.<自己>.md`（对方视角）
4. 不重复档案内容，档案引用对方自家 skill

## 六、测试环境→主环境 git 交接通用流程（契约落地实例）

> 背景：测试环境禁止 git 提交（dsh-git-push 门禁代码级强制），改动通过任务清单交接主环境提交。

### 1. 门禁（代码级，已做）

- `dsh-git-push/lib/core.js` → `checkTestEnvCommitGate()`：DSH_HOME 含 `dsh-test-*` 时拦截 commit/push
- 返回 `{ ok:false, blocked:true, error:'测试环境禁止 git 提交…走任务清单交接' }`

### 2. 交接流程（skill 级，AI 执行）

写任务清单文件到 **workspace 根目录**：`任务清单-提交-<仓库名>-<主题>-<YYYYMMDD>.md`

**任务清单 md 规范（2026-08-20 补充）**：开头必须包含**涉及的工作区（本地 git 项目地址）指定，可指定多个**；由 dsh-tasklist 插件（代码级）负责管理 md 文档（创建/列表/读取/勾选），无插件时按本模板手写。

```markdown
# 任务清单：提交 <仓库名> <主题>（YYYYMMDD）

## 涉及 git 项目（本地工作区）
- `/vol1/@appshare/DeepSeekHarness/workspace/dsh-git-rescue`
- `/vol1/@appshare/DeepSeekHarness/workspace/dsh-git-push`

> 用途：由测试环境会话生成（测试环境禁止 git 提交，dsh-git-push 门禁拦截）。
> 请主环境会话按本清单执行 git 提交推送。

## 一、待提交改动
| 文件 | 改动 | 类型 |
|------|------|------|
| <相对路径> | <改了什么> | 代码/文档/skill |

## 二、提交命令（主环境执行）
```bash
cd <仓库绝对路径>
git add <文件1> <文件2>
git -c user.name="EIGHTfs" -c user.email="EIGHTfs@users.noreply.github.com" commit -m "<commit message>"
git push origin main
```

## 三、验证状态
- ✅/⚠️ <如实标注：实测通过/单测通过/待人工确认>

## 四、遗留事项
- <已知边界/待办/坑>
```

### 3. 主环境侧（收到清单时）

1. 读清单文件 → 按「二、提交命令」执行（可先 `git status --short` 核对改动是否仍在暂存区）
2. 提交推送成功后，在清单文件勾选/标注完成（或删除清单）
3. 若改动不在暂存区（测试环境撤销过提交但改动在），`git add` 会重新纳入

## 七、已应用实例

| 联动 | 文件 | 位置 |
|---|---|---|
| git-push 联动 git-rescue（借用 isTestEnvHome 规则） | `skill.git-rescue.md` | dsh-git-push/skills/ |
| git-rescue 联动 git-push（测试环境提交被门禁拦，走交接） | `skill.git-push.md` | dsh-git-rescue/skills/ |
