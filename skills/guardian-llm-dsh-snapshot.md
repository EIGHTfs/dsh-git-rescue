---
name: guardian-llm-dsh-snapshot
description: guardian 内置 LLM 读 .dsh 智能快照能力（2026-08-22，权威 skill）。说明内置 LLM（网页对话 /api/llm-chat + 救援诊断 llmDiagnoseRescue）通过 collectDshSnapshot() 注入 .dsh 智能快照——收集用户档案(remember-me)/核心配置/守护状态/会话概览/skill清单，跳过二进制/超大/zstd/zip/node_modules/.credentials（只报存在），脱敏后让内置 LLM 认识用户、看全配置与故障现场；含"为什么不全读 .dsh（629MB/1331 文件 token 爆炸）"与接入点。处理"内置LLM为什么不知道我/不认识用户""内置LLM能读哪些.dsh文件""collectDshSnapshot/智能快照"类场景时加载；与 dsh-restart-takeover、dsh-git-rescue 配套。权威源 = 本插件项目 skills/。
whenToUse: 需要了解/排查 guardian 内置 LLM 的 .dsh 读取范围、为什么内置 LLM 认识/不认识用户、或改动 collectDshSnapshot 快照收集逻辑时。
generatedBy: user-request 2026-08-22（EIGHTfs：让内置LLM每次都读.dsh；固化"读.dsh智能快照"能力）
---

> ⭐ **先记住我**：任何会话开始前，先读用户档案 `.dsh/skills/remember-me.md`（优先级最高的 skill）：我是谁、我怎么用你、我立过的规矩。

# guardian 内置 LLM 读 .dsh 智能快照（guardian-llm-dsh-snapshot）

> 2026-08-22 用户（EIGHTfs）确立。核心一句话：**内置 LLM 通过 collectDshSnapshot() 注入 .dsh 智能快照，让它认识用户 + 看全配置 + 故障现场；不全量读（.dsh 太大）。**

## 一、为什么内置 LLM 之前"不知道你"

- 内置 LLM（guardian 进程的 /api/llm-chat + 救援诊断）**原本上下文只有守护进程最近 50 条日志**（`state.log.slice(-50)`），从不读 `.dsh` 文件。
- 所以它只认识"设备机器ID"，不认识用户（remember-me 是给运行在 DSH 里的 agent 用的，guardian 是独立进程没接 skill 注入）。
- 修复：注入 .dsh 智能快照后，内置 LLM 能从 remember-me 读出用户身份（实测答出"你是 EIGHTfs…"）。

## 二、为什么不全读 .dsh（量化事实）

- `.dsh` 总 **629MB、1331 个文件**：169MB zip、8MB zstd 会话、图片、node_modules、git 等。
- 全读喂给 LLM → **token 爆炸（上亿）** + 二进制无用 + 每次又慢又重，**不可行**。
- 正解 = **智能快照**：只收文本配置类/关键状态，跳过二进制/超大/无关，可控 token（实测约 21KB）。

## 三、collectDshSnapshot() 收集范围（lib/llm.js）

| 段 | 内容 | 作用 |
|---|---|---|
| 用户档案 | `.dsh/skills/remember-me.md`（脱敏：内部路径→`<内部路径>`、IP→`<IP>`） | **认识用户**（身份/画像/规矩） |
| 核心配置 | settings.yaml / .gitignore / profiles/web/package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml | 看插件/模型/路径配置 |
| 守护状态 | git-rescue/heartbeat / config.json / device-last.json / backup-select.json / llm-config.json / plugin-registry.json | 看设备/守护/插件状态 |
| 事件流 | events.jsonl 最近 40 行 | 看故障现场 |
| skill 清单 | `.dsh/skills/*.md` 名称（不读全文） | 知道有哪些规则 |
| 会话概览 | sessions 顶层编码目录名（不读 zstd 正文） | 看有哪些工作区会话 |
| 凭据 | `.credentials.yaml` 只报存在（600），**不读值** | 防泄密 |

**跳过**：node_modules / node_modules_local / .git / sessions 正文 / storages / snapshot-archive / session-transfer / supervisor / rescue 目录；`.zip/.zstd/.gz/.tar/.jpg/.jpeg/.png/.gif/.bin/.lock` 等二进制扩展。

**参数**：`maxTotalChars`（默认 200KB，实测 ~21KB）、`maxFileChars`（默认 30KB/文件）。

## 四、接入点

1. **/api/llm-chat**（guardian 网页"向 LLM 提问"）：`systemPrompt` 明确"快照第一节【用户档案】= 本机用户身份，问'我是谁'从这里提取"；`userPrompt = 【.dsh 快照】+【守护日志】+【用户问题】`。
2. **llmDiagnoseRescue**（救援多轮诊断）：`buildRescueContext` 支持 `dshSnapshot`，置顶拼接给救援 LLM 全现场（recover ⑥ 段 turn0ctx 传入 `collectDshSnapshot`）。

## 五、常见坑

| 坑 | 处理 |
|---|---|
| 内置 LLM 说"没有用户档案" | systemPrompt 未引导它识别【用户档案】段 → 明确告诉它第一节就是用户档案（本 skill 四.1） |
| 想全读 .dsh | 不可行（629MB/1331 文件）；用智能快照，必要时加 `maxTotalChars` |
| 脱敏 | remember-me 身份在快照里保留（EIGHTfs 等），但内部路径/IP 替换；`.credentials.yaml` 值永不注入 |
| 改了 collectDshSnapshot 不生效 | 重启 guardian（内置 LLM 在 guardian 进程，非 DSH 会话） |

## 六、配套

- `dsh-restart-takeover`：接管式重启（内置 LLM 改代码后需重启 guardian 生效）
- `dsh-git-rescue`：救援诊断用快照做全现场
- `remember-me`：用户档案（快照的核心身份来源）
- `host-address-convention`：内置 LLM 输出里地址/身份按脱敏约定
