---
name: dsh-git-rescue-codelevel-repair
description: 【dsh-git-rescue 插件 skill（2026-08-20 固化）】救援插件**代码级自动修复能力**权威清单——哪些启动失败根因已被固化成代码（guardian 救援时自动执行），哪些只有文档记录待补：①OOM 防护（guardian startDsh 带 NODE_OPTIONS=--max-old-space-size=4096）②root 改配置后权限修复（repair-tools permission 工具：chown deepseek-harness + chmod 644）③裸 test 标识符检测（plugin_config 工具）④import 冒烟测试（单测 T10）⑤corrupt session log 修复（⚠️ 仅文档，未代码化）⑥peak-resume（⚠️ 仅文档，未代码化）。处理「哪些启动失败已被代码级自动修复」「guardian 会自动修什么」「repair-tools 有哪些工具」「救援经验是否已代码化」类问题时加载；与 dsh-rescue-restore（通用救援流程）、dsh-boot-troubleshooting（排查顺序）、dsh-git-rescue（项目档案）配套。
whenToUse: 需要确认 dsh-git-rescue 的自动修复能力覆盖哪些故障、判断某启动失败根因是否已被代码级修复、扩展 repair-tools、给 guardian 加自动修复工具、复盘救援经验是否落地代码时。
generatedBy: EIGHTfs 2026-08-20（外部救援经验学习融入）
---

# dsh-git-rescue 代码级修复能力权威清单

> 2026-08-20 外部救援 AI 经验学习后固化。核心价值：**分清"哪些启动失败根因已被 guardian 自动修，哪些还要人工/文档"**——避免误以为"写进文档=已修复"。

## 一、✅ 已代码化（guardian 救援时自动执行）

| # | 故障根因 | 代码位置 | 触发方式 | 验证 |
|---|----------|----------|----------|------|
| 1 | **OOM 崩溃**（数据写坏→启动吃满 Node 默认 2GB heap→SIGABRT） | `guardian/server.js` `startDsh()`：spawn 时 `env.NODE_OPTIONS = '--max-old-space-size=4096'` | guardian 拉起 DSH 时自动带 | 启动后 60s 不崩 = 生效；`tr '\0' '\n' < /proc/<pid>/environ \| grep NODE_OPTIONS` |
| 2 | **EACCES 权限**（root 改配置后未 chown 回服务用户） | `lib/repair-tools.js` 工具 `permission`：`diagnosePermission()`（fs.access R_OK 检查 package.json/cordis.patch.yml/cordis.yml/settings.yaml）+ `fixPermission()`（chown -R deepseek-harness + chmod 644/755） | guardian recover 时 `runRepairTools()` 自动跑；手动 `POST /api/git-rescue/repair-tools` | `diagnosePermission(.dsh)` 返回 matched:false = 无故障 |
| 3 | **裸 test 标识符**（插件 lib/index.js 末尾孤立 `test`，ESM 加载 ReferenceError） | `lib/repair-tools.js` 工具 `plugin_config`：`diagnosePluginConfig()` 检出 `bare-test-identifier` + `fixPluginConfig()` 移除 | guardian 救援自动跑；手动 repair-tools API | 单测 T3/T4 破坏恢复场景 + T10 import 冒烟 |
| 4 | **import 冒烟**（node --check 查不出裸 test，必须真实 import） | `test-git-rescue.mjs` **T10**：真实 `import()` index.js + 全部 12 个 lib 模块 | 部署前跑 `node test-git-rescue.mjs` | T10 全 ✅ = 插件树可加载 |
| 5 | **corrupt session log**（header cwd 与目录编码不匹配，2026-08-20 导入事故） | `lib/repair-tools.js` 工具 `session_repair`：`projectKey()`（复刻 DSH 编码：`/ \ :` → `-`、不安全字符 → `~XXXX`）+ `diagnoseSessionRepair()`（逐会话读 header 帧比对目录名）+ `fixSessionRepair()`（cwd 不匹配且目标不存在→改名修复，保守不删） | guardian 救援自动跑；手动 repair-tools API | `diagnoseSessionRepair(.dsh)` 返回 0 findings = 无 corrupt（大文件用首帧流式解码，避免整解超限） |
| 6 | **高峰续跑被暂停**（peak-resume 需手动） | `guardian/server.js` `resumePeakIfPaused()`：recover 成功后探测 `/api/session-manager/peak-status`，若 `pauseAutoContinue` 则 POST `/api/session-manager/peak-resume` 恢复自动续跑；fail-soft 不阻断 | 救援成功自动执行 | `curl /api/session-manager/peak-status` 确认 pauseAutoContinue 状态 |

> ✅ 2026-08-20 全部 6 项已代码化，无"仅文档待补"项。

## 三、代码化判定原则（防止"文档当修复"）

1. **真代码级 = guardian/插件运行时能自动执行**（repair-tools 注册、startDsh env、apply 自检）——不是写在 md 里
2. 判断标准：查 `lib/repair-tools.js` 的 `repairTools()` 注册表是否含该工具 + guardian recover 是否调 `runRepairTools`
3. 新根因融入流程：诊断函数（只读）→ 修复函数（可回退）→ 注册进 `repairTools()` → 单测 → 同步测试环境副本 → 本 skill 更新为 ✅

## 四、相关

- `dsh-rescue-restore`：通用救援流程权威（3.7 OOM / 3.8 corrupt 背景）
- `dsh-boot-troubleshooting`：排查顺序（先系统→引导→插件）
- `dsh-git-rescue`：项目档案（版本/结构/机制）
- 单测：`node test-git-rescue.mjs`（T10 冒烟；T3/T4 破坏恢复）
