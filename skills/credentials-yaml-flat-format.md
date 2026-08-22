---
name: credentials-yaml-flat-format
description: .credentials.yaml 必须扁平格式 + 「credentials_fix」救援工具（2026-08-22 实战，权威 skill）。DSH 的 dsh-credentials-local 的 parseCredentialsDocument 只接受**纯扁平 mapping**（顶层每个 key → 字符串值）；若被写成 `version:`+`refs:` 嵌套 → 报 `the value for "version"/"refs" must be a string` → credentials 插件加载失败 → DSH 起不来。含扁平格式模板、嵌套格式的识别、以及 repair-tools 的 `credentials_fix` 工具（自动检测+重写为扁平+备份）、以及「guardian 救援链盲区」教训（guardian 自身 LLM 依赖凭据，凭据坏则救援链全断）。处理"DSH 起不来报 credentials must be a string""crentials.yaml 嵌套格式""credentials_fix"类场景时加载；权威源 = 本插件项目 skills/。与 dsh-boot-troubleshooting、dsh-git-rescue 配套。
whenToUse: 主 DSH 起不来 / 日志报 credentials-local must be a string、需要修 .credentials.yaml、排查 guardian 救援为何失败 / LLM 连不上（"DEEPSEEK_API_KEY 未配置"）时。
generatedBy: user-request 2026-08-22（EIGHTfs：归纳问题，代码修复 → 固化成权威 skill）
---

> ⭐ **先记住我**：任何会话开始前，先读用户档案 `.dsh/skills/remember-me.md`（优先级最高的 skill）：我是谁、我怎么用你、我立过的规矩。

# .credentials.yaml 扁平格式 + credentials_fix（credentials-yaml-flat-format）

> 2026-08-22 实战教训（主 DSH 起不来）。核心一句话：**.credentials.yaml 必须是纯扁平 mapping；写坏成嵌套会让 DSH 起不来，且会让 guardian 救援链全断。**

## 一、现象（致命）

- 主 DSH 起不来，日志尾部反复：
```
credentials-local: the value for "version" in /vol1/@appshare/DeepSeekHarness/.dsh/.credentials.yaml must be a string
（或 "refs" ... must be a string）
```
- 根因：`.credentials.yaml` 被写成了**嵌套**：
```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: "sk-..."
  FREE_API_KEY: sk-...
```
- 但 DSH 的 `dsh-credentials-local/lib/index.js` `parseCredentialsDocument` 只接受**纯扁平 mapping（顶层 key → 字符串值）**，不认 `version`/`refs` 包装；嵌套值（mapping）非字符串 → 抛错 → 插件加载失败 → DSH 引导中断。

## 二、正确（DSH 期望的）扁平格式

```yaml
DEEPSEEK_API_KEY: "sk-..."
FREE_API_KEY: "sk-..."
```
- 顶层每个 key 直接是凭据引用 → 字符串值（非空）
- **不要** `version:` / `refs:` 包装；凭据值必须是 string
- 文件权限：600（仅 owner 可读），属主 deepseek-harness
- 校验：可用 `node -e "import {parseCredentialsDocument} from 'dsh-credentials-local/...'"` 或直接重启 DSH 验证

## 三、修复方式（两种）

### 1. 手工（临时）
```bash
# 提取 refs 下的 key:value 重写为扁平（先备份）
cp .credentials.yaml .credentials.yaml.bak-<ts>
# 用 node 把 refs 下键提为顶层、去 version/refs
```

### 2. 代码级：repair-tools 的 `credentials_fix`（优先，2026-08-22 起）
- **诊断** `diagnoseCredentialsFormat`：检测嵌套 `refs:` / 裸 `version:` 特征
- **修复** `fixCredentialsFormat`：提取 refs 下凭据键 → 重写为扁平 → **写前自动备份**（`.credentials.bak-credentials-<ts>`）
- 注册在 `repairTools()` 数组，**guardian 救援链 ⑤（专项恢复工具）自动跑**
- LLM 也可通过 `suggest_config_fix` 调 fixId=`credentials_fix`

## 四、⚠️ guardian 救援链盲区（本次连带教训，必读）

- **现象**：guardian 检测到故障、全救援链跑一遍仍失败——日志：
  - `package.json 非法 JSON 且无 git 历史可恢复（spawn git ENOENT）`
  - `🤖 LLM 自治救援 ... 未恢复（1轮）`
  - `没有可回退的好提交`
  - `唤起纯净环境失败`
  - **`LLM 对话失败: DEEPSEEK_API_KEY 未配置`** ← 关键
- **根因链**：`.credentials.yaml` 坏 → **guardian 自身 LLM 读不到 DEEPSEEK key → LLM 自治救援没法用**；同时 git 命令 ENOENT（git 环境问题）→ 回退兜底也没了 → 救援链全断，只能靠人工。
- **教训**：凭据文件坏会**连累 guardian 自己的救援能力**（LLM 依赖凭据）。所以 `credentials_fix` 必须在**最前阶段**（⑤专项工具）就能跑，先修好凭据，LLM⑥ / git⑦ 才有救的可能。
- **排查**：guardian 救援失败且日志有 `DEEPSEEK_API_KEY 未配置` → 先查 `.credentials.yaml` 是否扁平；用 `credentials_fix` 修好再让 guardian 重跑救援。

## 五、配套

- `dsh-boot-troubleshooting`：启动失败排查清单（credentials 类归入）
- `dsh-git-rescue`：guardian 救援机制 / credentials_fix 归属
- `remember-me`：凭据位置与脱敏（不露值）
