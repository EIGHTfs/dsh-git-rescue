---
name: dsh-git-rescue
description: DSH git 版本管理 + 崩溃自动救援项目（EIGHTfs/dsh-git-rescue）的完整档案：结构、崩溃检测/救援机制、故意破坏测试方法、宣传发布状态、部署状态、已知坑与版本记录。处理 dsh-git-rescue 开发、调试、测试、崩溃记录分析、宣传发布、版本更新时加载。
whenToUse: 涉及 dsh-git-rescue 插件/guardian 的代码改动、故意破坏测试、崩溃记录整理、备份仓库配置、宣传发帖、商店上线、主实例部署，或复盘本项目的崩溃/救援实测数据时
---

# dsh-git-rescue 项目指南

> 经验来源：2026-08-18 开发实测 + 仓库 `docs/crash-records-test-env.md`（测试环境崩溃记录）+ `docs/harness-startup-failure-log.md`（生产启动失败史）。核心原则：**历史即资产，救援 = git 回退，测试 = 故意破坏**。

## 一、项目结构与版本

仓库 `EIGHTfs/dsh-git-rescue`（main），三合一合并后结构：

```
├── README.md                 # 设计原理/设计溯源/测试体系门面
├── docs/
│   ├── harness-startup-failure-log.md   # 生产环境无法启动史（14 片段 + 3 显式失败）
│   └── crash-records-test-env.md        # 测试环境崩溃/救援实录
└── components/
    ├── snapshot-archive/     # 组件 A：zip 快照（原仓库已删，仅留存）
    ├── guardian/             # 组件 B：zip 版守护（原仓库已删，仅留存）
    └── git-rescue/           # 组件 C v1.2.2：git 版本管理插件 + git 版 guardian（核心）
        ├── lib/{index,git,github,device}.js
        ├── guardian/server.js + public/  # 独立救援进程 + web 控制台
        └── test-git-rescue.mjs
```

**版本记录**（遵循 versioning-rule，X.Y.Z = 功能序号.修复次数）：

| 版本 | 内容 |
|------|------|
| 1.11.0 | 功能11：测试环境不自动救援（guardian 探测 DSH_HOME 为 `dsh-test-*` 即禁用自动 git 回退/拉起，插件崩溃由开发者自行解决；判定抽离 `lib/test-home.js` 单一真源，guardian 与插件共用）+ 活跃对话保护（救援前检测 `running\|\|continueRunning`，存在则落盘 `git-rescue/restart-request.json` 提交重启申请，不打断对话；未装 session-manager 降级扫描事件流仅 running；DSH down 视为无活跃）+ 手动救援前记录近期变动文件（`pre-restart-changes-<ts>.json`，默认 10 分钟窗口） |
| 1.10.0 | 功能10：测试环境路径判定（`status.self.isTest`，DSH_HOME 含 `dsh-test-*` 前缀目录；替代端口范围 3083-3182——端口会漂移、残留实例也可能落在范围内）+ 沙盒环境能力检测（`lib/sandbox.js`：NoNewPrivs/CapEff/sudo 可行性/只读挂载，status 暴露 `sandbox` 字段，供 guardian/故障分类决策） |
| 1.9.0 | 功能9：测试环境入口整合（原 dsh-test-env-entry：侧边栏面板 + /api/dsh-test-env/*） |
| 1.8.0 | 功能8：可选 sudo-key（插件配置，绝不明文显示/存储）——系统故障时 guardian 自动 remount rw 修复；无 root 环境不配置则保持"告警人工" |
| 1.2.2 | 修复：`tools.register` 缺 `parameters` 导致 schema 投影抛 `parameters must be lossless JSON before schema projection`（Agent 一调用 git_rescue_* 工具整轮就死）——`defineToolSimple` 补默认 `{type:'object',properties:{}}`，backup/log 声明真实参数 |
| 1.2.1 | 修复：备份仓名改用设备指纹 machine-id（不再依赖主机名） |
| 1.2.0 | 功能2：guardian 独立救援进程（探活/坏点标记/git回退/拉起/自检/web UI） |
| 1.1.0 | 功能1：git 版本管理插件本体（检测/双仓库/自动commit/心跳/崩溃检测/token推送/tools） |

## 二、崩溃检测与救援机制（实测事实，勿改动默认行为）

### 插件侧（lib/index.js）

- **心跳**：默认每 30s 写 `~/.dsh/git-rescue/heartbeat`（json：ts/pid/plugin/ok）
- **崩溃检出**：启动时读上次心跳，`age > heartbeatMs*3`（默认 90s）判定"上次异常退出" →
  写 `crash-detected` 事件到 `events.jsonl` + 自动 commit 现场（`chore(guard): crash-detected | ...`）
- **自动 commit**：启动/定时(30min)/事件/手动四类触发；commit 规范 `chore(guard): <原因> | 摘要`
- **回退（rollbackRepo）顺序（关键，改错过）**：① 先 commit 坏现场 → ② 再对【刚生成的坏提交】打 `bad-*` tag → ③ 才 `reset --hard` 目标 ref。**不能**先取 current 再打标记（会把好提交标坏）
- **状态目录**：`~/.dsh/git-rescue/`（config.json/token/heartbeat/events.jsonl），`.gitignore` 必含 `git-rescue/`

### guardian 侧（guardian/server.js，独立进程）

- 探活：`fetch(http://host:port/, timeout 5s)`，默认 10s 间隔
- 触发：连续 `failThreshold=3` 次失败才救援（防单次误判）
- 救援流程：commit 坏现场 → markBad(坏提交) → `lastGoodCommit`（跳过 bad 标记）→ `reset --hard` → `startDsh`（DSH_START_CMD 或自动推导 bin.js）→ 轮询健康（startWaitMs 默认 15s）
- 配置全环境变量：DSH_PORT/DSH_HOME/GUARDIAN_PORT/GUARDIAN_INTERVAL_MS/GUARDIAN_FAIL_THRESHOLD/DSH_START_CMD/GUARDIAN_SESSION_LIST_PATH/GUARDIAN_PRERESTART_WINDOW_MS
- **v1.11.0 前置闸门（recover 开头，自动/手动都过）**：
  - 测试环境（`isTestHomePath(DSH_HOME)` 命中 `dsh-test-*`）→ **不救援**：保留现场（stderr+TERM 上下文）+ 事件 + 冷却，返回 `{testEnv:true, blocked:'test-env-no-rescue'}`——插件编写导致的崩溃由开发者自行解决
  - 活跃对话检测：`GET /api/session-manager/list`（装了 session-manager）→ 任一 `running||continueRunning` 即拦截；404（未装）→ 降级 `zstdcat` 扫描 sessions 事件流（尾部 turn/start 未 end = running）；fetch 失败（DSH down）→ 视为无活跃，正常救援
  - 拦截结果：不重启，落盘 `git-rescue/restart-request.json`（status:'pending'，含活跃会话清单），冷却；`DELETE /api/restart-request` 清除
  - 手动 recover（`/api/recover` = source 'manual'）：无活跃对话时先记录重启前 10 分钟（`GUARDIAN_PRERESTART_WINDOW_MS`）内变动文件 → `git-rescue/pre-restart-changes-<ts>.json` → 再执行回退；`/api/recover-auto` 走自动语义
- ⚠️ **guardian 的 git 命令沿目录树上溯**：DSH_HOME 若指向某 git 仓库的子目录（如验证时放 repo 内），`git reset --hard` 会回退**上层仓库**——验证 guardian 必须用独立 git 仓库（自带 .git 拦截上溯）

### 实测数据（可信基准）

- kill -9 后 90s 阈值检出；实测过期 233s/277s 均正确检出
- guardian 灭门级救援（破坏 cordis.patch.yml 致无法启动）：3×10s 检出 → 坏点标记 → 秒级回退 → 拉起 → **5 秒自愈**
- 每次崩溃/回退都留可复盘 commit + bad 标记（`git show bad-*` 可见损坏现场）

## 三、测试方法：故意破坏矩阵（核心测试哲学）

**不测"正常"，专测"搞破坏"**。5 类破坏全部在测试实例实测通过：

| # | 破坏 | 验证 |
|---|------|------|
| 1 | 篡改 settings.yaml | 回退恢复 |
| 2 | 删除被跟踪文件 | 回退找回 |
| 3 | 恢复后再破坏（连环） | bad 标记防死循环 |
| 4 | kill -9 进程 | 心跳过期检出 + 自动 commit |
| 5 | 破坏 cordis.patch.yml 致无法启动（灭门级） | guardian 全自动救援 |

- 测试实例（3083-3182）用法见 `dsh-test-env` skill；干净隔离基线见 `dsh-clean-env` skill
- ⚠️ **共享测试环境 dsh-test-home 可能被其他会话占用**（实测：dsh-ai-work-archive 插件在开发中且曾导致实例启动失败）——做对照/隔离测试优先用 dsh-clean-env 的独立环境，不要动共享测试环境的 cordis.patch.yml
- ⚠️ **主实例 test-sync 类插件会自动重启测试实例**（监听测试实例 cordis.patch.yml 变更）——崩溃测试前先确认无此类干扰，或禁用
- 单测运行：`GITHUB_TOKEN=xxx node test-git-rescue.mjs`（T6 真实推送需 token；当前 23/23 通过）

## 四、已知坑（实测踩坑记录）

| 坑 | 修复 |
|----|------|
| `webServer.register` 旧签名 `(handler, {path})` 全 404 | 必须对象签名 `{kind:'prefix'|'exact', path, handler}`，且用 `ctx.inject(['webServer'], ...)` 包（fiber 时序） |
| `tools.register` 报 `must declare output {schema, render}` | 每个工具带 `output.schema`（如 `{type:'string'}`）+ `render(args,value)=>[{type:'text',text}]` |
| `tools.register` 缺 `parameters` → 报 `parameters must be lossless JSON before schema projection` | 每个工具必须带 `parameters`（lossless JSON，如 `{type:'object',properties:{}}`）；缺省为 `undefined`，`snapshotJsonValue(undefined)` 直接抛错，**注册时不报、Agent 会话枚举工具时才炸**（v1.2.2 修复） |
| rollbackRepo bad 标记打在好提交上 | 先 commit 坏现场，再标记刚生成的坏提交（见第二节） |
| GitHub 空仓库建 blob 报 "Git Repository is empty" | 推送前 `ensureRepoSeeded`：Contents API 种 README 初始提交 |
| 分支更新报 "Update is not a fast forward" | ref 更新 PATCH force 优先，404 才 POST |
| pushSnapshot 读软链/目录报 EISDIR | lstat 判断：软链推链接文本(mode 120000)、目录跳过 |
| 备份仓名用 hostname 会撞车/改名漂移 | `lib/device.js`：machine-id → 持久化 UUID → hostname 哈希；仓名 = `dsh-git-rescue-backup-<id前12位>` |
| `/tmp` 跨命令被清 | 日志/临时文件落 workspace，别用 /tmp |
| `pkill -f` 匹配到自己命令行被杀 | 用精确 PID（`ps aux | grep ... | grep -v 3081` 防误杀主实例） |

## 五、备份仓库约定

- 默认：`<账号>/dsh-git-rescue-backup-<设备ID前12位>`（private，首次 push 自动创建 + seed）
- 设备 ID：`/etc/machine-id` 优先；持久化 UUID 兜底（`git-rescue/device-id`）；hostname 只进仓库描述
- 推送 = 当前快照（`git ls-files` 跟踪集 → blobs/tree/commit/ref），**不是**历史同步
- 敏感隔离：`.credentials.yaml`/token/`storages/`/`git-rescue/` 在 .gitignore，实测推送零泄漏
- `githubRepo` 配置可手动覆盖默认仓名
- api.github.com 间歇性 503 → 重试；HTTP/2 报错加 `--http1.1`；token 在 `~/.ssh/github-token`（60 行内先 `grep -v '^#'` 取有效行）

## 六、宣传与发布状态（2026-08-18）

| 项 | 状态 | 说明 |
|----|------|------|
| 公开仓库 `EIGHTfs/dsh-git-rescue` | ✅ 已上线 | main 分支，MIT LICENSE，README 门面齐全 |
| topics | ✅ 已打 | `dsh-plugin` / `backup` / `git`（官方社区可发现） |
| 宣传素材 | ✅ 已入库 | `docs/PROMO.md`：三版宣传语 + 简易说明（"填一个 GitHub token 即用"） |
| 插件商店 EIGHTfs.github.io | ✅ 自动收录 | 前端动态拉 EIGHTfs 公开仓库，推 main 即上线，无需额外操作 |
| 官方 Discussions 发帖 | ⚠️ 需人工 | `deepseek-ai/deepseek-harness` 讨论区 API **发帖需仓库 write 权限**（非协作者 POST 返回 404，GET 正常）；只能浏览器手动发：https://github.com/deepseek-ai/deepseek-harness/discussions/new |

⚠️ **发帖权限坑**：官方仓库 Discussions 的创建 API 对非协作者返回 404（不是接口不存在），别浪费时间重试 API；网页端任何登录用户都能发，把 PROMO.md 完整版粘贴即可。

## 七、当前部署状态（2026-08-18）

| 位置 | 状态 |
|------|------|
| 主实例（生产 3081） | ⚠️ **未安装**——主实例 `.dsh` 只读（EROFS），待确认时机后：解决只读挂载 → 注册插件 → 重启主实例（会中断会话）→ 验证 |
| 共享测试环境 dsh-test-home | ⚠️ 曾用于全量测试，现被其他会话的 `dsh-ai-work-archive` 插件占用（其代码导致实例启动失败）——不要动它的 cordis.patch.yml |
| 隔离验证环境 | ✅ 已验证后清理（dsh-clean-env 一键重建） |
| guardian 测试进程 / 备份测试仓 | ✅ 已全部清理 |

## 八、验证状态速查（2026-08-18 实测）

| 能力 | 状态 |
|------|------|
| git 环境检测 / https 助手缺失检测 | ✅ 实测（2.43.0 / 缺失=true） |
| 插件 API（status/init/commit/log/config/push/rollback） | ✅ 实测（组件 C） |
| **Agent 工具 schema 投影（git_rescue_* 6 个）** | ✅ **v1.2.2 修复后实测**：真实 `ToolRuntime.schemas()`/`sdkSchemas()` 全投影无异常（原 v1.2.1 缺 `parameters` → 整轮运行报 `parameters must be lossless JSON before schema projection`，实例重启后验证通过） |
| 破坏恢复 A/B/C | ✅ 实测（组件 C） |
| 崩溃检测（心跳过期） | ✅ 实测 ×2 |
| guardian 自动救援（灭门级） | ✅ 实测（5s 自愈，git 版） |
| 远端推送 + 敏感零泄漏 | ✅ 实测（159 文件） |
| 设备指纹备份仓名 | ✅ 实测（machine-id 来源） |
| **组件 A snapshot-archive（zip 快照）** | ✅ **已修复并实测（2026-08-18）**：v1.0.1 修 3 bug——① register 旧签名→对象签名 ② tools 缺 output.schema（原致命：插件树加载失败）③ 不认 DSH_HOME（原快照目录写错）。隔离环境实测：status/创建快照/列表/zip 三平台恢复脚本 全通过 |
| **组件 B guardian（zip 版守护）** | ✅ **实测通过（2026-08-18）**：多快照逐个回退验证——新快照(坏配置)恢复后启动失败被跳过 → 旧快照(好配置)恢复 → 启动成功。⚠️ 设计注意：B **不读 `DSH_HOME` 环境变量**，快照源写死 `$HOME/.dsh/snapshot-archive/<profile>`，测试/部署需用 `HOME` 指向正确位置（或用它自带配置文件时注意） |
| sessions 基线+增量策略 | ⚠️ 未实现（后续优化项） |
| 主实例安装 | ⚠️ 未做（主实例只读，待 GUI 确认） |
