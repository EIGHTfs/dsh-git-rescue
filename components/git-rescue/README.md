# 🛟 dsh-git-rescue（组件 C）v1.6.0

**DSH git 版本管理 + 崩溃自动救援** —— 仅 GitHub token 方案。

## 功能

- **v1.1.0 功能一：git 版本管理插件本体**
  - git 环境检测（`git --version`、`git-remote-https` 缺失检测）
  - 双仓库管理：`~/.dsh`（配置+会话+skills，默认）+ workspace 白名单（可选）
  - 自动 commit（启动 / 定时 30min / 事件 / 手动），commit 规范 `chore(guard): <原因> | 摘要`
  - 心跳写入（`git-rescue/heartbeat`，供 guardian 探活）
  - 启动崩溃检测（心跳过期 → `crash-detected` 事件 + 自动 commit 坏现场）
  - GitHub token 配置 + 远端快照推送（**REST API 降级**，绕开 `git-remote-https` 缺失环境）
  - API：`/api/git-rescue/*`（status/init/commit/log/config/push/rollback/heartbeat）
  - Agent 工具：`git_rescue_status/init/backup/log/push/rollback`

- **v1.2.0 功能二：guardian 独立救援进程**
  - 独立于 DSH（DSH 崩了它活着），HTTP 探活 + 连续失败阈值
  - 自动救援：commit 坏现场 → bad 标记 → `git reset --hard` 到最后一个好提交 → 拉起 DSH → 健康自检
  - 坏点标记防回退死循环
  - 网页控制台（默认 3082）+ `/api/status`、`/api/recover`、`/api/start`

- **v1.3.0 功能三：自动更新（强制跟随 GitHub 最新稳定版）**
  - **每次启动成功 30s 后检查 + 每天一次定时检查**远端 `EIGHTfs/dsh-git-rescue` main 分支
  - 远端版本 > 本地 → 自动下载 `components/git-rescue/` 子树 → 语法校验 → 原子替换 → 重启生效
  - **隐藏开关强制开启**：不写入 config、不暴露设置 API；仅环境变量 `DSH_GIT_RESCUE_AUTO_UPDATE=0` 可关闭（调试/隔离用）
  - 安全：路径白名单（只同步插件子树）、替换前备份、失败自动回滚、语法校验不过不替换
  - API：`POST /api/git-rescue/auto-update`（检查；`?apply=1` 立即应用）

- **v1.4.0 功能四：接管式重启（dsh-restart-takeover 方案固化）**
  - 独立脚本接管：TERM runner → 轮询端口恢复 → 验证插件 API → 结果写 `git-rescue/restart-latest.log`
  - 规避核心困境：DSH 重启会中断所有会话，同步"kill→验证"会在 kill 瞬间断掉；setsid 脱离进程组后脚本自持完整流程
  - Agent 工具 `git_rescue_restart` + `POST /api/git-rescue/restart` + `GET /api/git-rescue/restart-log`
  - 配套 skill 档案：`docs/skill-dsh-restart-takeover.md`（模板/机制/已知坑/验证清单）

- **v1.5.0 功能五：会话恢复联动（与 dsh-session-manager 协同，不内置）**
  - 原则：**装了 session-manager 才调用，没装就不调用，不内置会话恢复**
  - 崩溃检出（crash-detected）后自动扫描全部会话并续跑可续的（调 session-manager 的 `scan`）
  - 探测：GET `/api/session-manager/list` 可用才联动；联动失败静默，不影响 git-rescue 主流程
  - Agent 工具 `git_rescue_link_recovery` + `POST /api/git-rescue/link-session-recovery`（手动触发）
  - status 输出 `sessionLink` 字段（available/lastResult）

- **v1.6.0 功能六：异常感知增强（flapping 检测 / 业务就绪探活 / 现场捕获 / sessions 基线）**
  - **flapping 检测器**（`lib/flapping.js`）：guardian 记录每次救援重启，窗口内（默认 10 分钟）≥3 次 → 判定"无限重启"→ 停止自动拉起循环 + 冷却期（默认 10 分钟）+ 事件留痕，防"反复拉起即崩"无人识别；可配 `GUARDIAN_FLAPPING_WINDOW_MS` / `GUARDIAN_FLAPPING_MAX_RESTARTS`
  - **业务就绪探活**（`lib/probe.js`）：guardian 健康检查从"GET / 200"升级为分级探测——healthy（根+API+tools 全通）/ **degraded（根通但 API 404 = 假活，按失败触发救援）** / down；可配 `GUARDIAN_PROBE_API_PATH` / `GUARDIAN_PROBE_TOOLS_PATH`
  - **现场捕获**（`lib/process-capture.js`）：guardian 启动 DSH 时 stderr/stdout 落盘 `git-rescue/dsh-stderr.log`（滚动 500KB）；救援时抓取退出现场（/proc 残留 + stderr 尾部 + journalctl/dmesg）→ 写入事件流，回答"谁发的 TERM / 为什么崩"
  - **sessions 基线+增量策略**：sessions/storages 移出常规增量 commit（zstd 二进制变化大），改为**定期全量基线**（默认每天，可配 `sessionsBaselineMs`；启动 5 分钟后首跑）——`git add -f` 强制入库 → 基线 commit → `git rm --cached` 恢复忽略；控制仓库体积增长

- **v1.7.0 功能七：救援积分（rescue scores，防刷分）**
  - **记录成功救援次数**：guardian 救援成功 + 插件回退成功（crash/manual）+ 崩溃检出，按设备统计
  - **防刷分设计**：积分**不以可写文件为权威**（文件可篡改刷分）——从插件自身的保存恢复记录留档（`events.jsonl` / `guardian-events.jsonl`）**实时加载计算**；DSH 启动后重新计算覆盖缓存快照
  - **设备标识**：用设备稳定 ID（machine-id，区别于 git 私人备份库名）作文件名 `rescue-scores-<id12>.json`，未来可汇总多台设备做排行榜
  - 积分结构：`{deviceId, hostname, total, byType:{crash,guardian,manual}, breakdown, history}`
  - 展示：status API 的 `scores` 字段；工具 `git_rescue_status` 含积分行

- **v1.7.2 故障分类（P0/P1）**：guardian 探活失败时先分类——`lib/fault-classify.js` 判定 system（/vol1 只读/dmesg I-O 错误）/ boot（软链冲突）/ plugin（插件配置变更）/ unknown；**系统与引导故障不可回退**（停止自动救援+冷却+告警人工，不再对只读卷做无意义回退重启），插件故障才走 git 回退

- **v1.8.0 可选 sudo-key（无 root 部署友好）**：

  > 🔓 **完全可选，不强求！** 插件**核心功能（git 管理 / 回退 / 积分 / 探活）一行 root 密码都不用填**。
  > sudo-key 只是给「愿意提供 root 密码的设备」加一个自动修复只读卷的便利；不填完全不影响使用，
  > 系统故障时插件会安全地停下并提示人工处理，绝不擅自操作系统。

  - 插件配置可填写 sudo-key（**绝不明文显示/存储**：GET config 只报 `sudoKeySet`，单独文件 600 权限，不进 config.json/不进 git；敏感用户完全可以跳过此项）
  - guardian 判定 system 故障时，若配置了 sudo-key → **自动 `sudo mount -s -o remount,rw` 修复只读卷**（含 -s 忽略 fnOS trimacl 等专有选项）→ 修复后继续探活
  - **无 root / 不配置 sudo-key**：保持"告警人工"（P0 设计不变），插件核心功能完全不需要 root

## 已验证（2026-08-18，测试实例 3083）

- 单元测试 19/19（含真实 GitHub 推送建仓/推两次/清理）
- 插件加载 / API（status/init/commit/log）
- 破坏测试：篡改 `settings.yaml`、删被跟踪文件 → 回退恢复（bad 标记打在坏提交）
- 崩溃检测：kill -9 → 心跳过期 → 重启检出 `crash-detected` + 自动 commit
- **guardian 自动救援 e2e**：破坏 `cordis.patch.yml` 致 DSH 无法启动 → 自动 git 回退 → 拉起 → 健康自检通过
- token 配置 + 远端推送：159 文件快照，敏感文件（.credentials.yaml/token）零泄漏

## 运行

```bash
# 插件：注册进 profile（cordis.patch.yml insert + node_modules 软链），重启 DSH
# guardian（独立进程）：
DSH_PORT=3081 DSH_HOME=$HOME/.dsh GUARDIAN_PORT=3082 \
node guardian/server.js
```

## 设备身份与备份仓库

- 备份仓默认名 = `dsh-git-rescue-backup-<设备ID前12位>`，**与主机名无关**
- 设备 ID 来源优先级：`/etc/machine-id`（或 `/var/lib/dbus/machine-id`）→ 持久化 UUID（`git-rescue/device-id`）→ hostname 哈希
- 同一账号多台设备（即使主机名相同）备份仓不冲突；hostname 只进仓库描述
- `githubRepo` 配置可手动覆盖默认名

## 测试

```bash
GITHUB_TOKEN=xxx node test-git-rescue.mjs   # 单元 + 真实推送（T6 需 token）
```

## 版本记录（X.Y.Z：功能序号.修复次数）

| 版本 | 说明 |
|------|------|
| 1.10.0 | 功能10：测试环境路径判定（status.self.isTest，DSH_HOME 含 dsh-test-*）+ 沙盒环境能力检测（lib/sandbox.js：NoNewPrivs/CapEff/sudo 可行性/只读挂载，status 暴露 sandbox 字段） |
| 1.9.0 | 功能9：测试环境入口整合（原 dsh-test-env-entry：侧边栏面板 + /api/dsh-test-env/*） |
| 1.8.0 | 功能8：可选 sudo-key（插件配置，绝不明文显示/存储）——系统故障时 guardian 自动 remount rw 修复；无 root 环境不配置则保持"告警人工" |
| 1.7.2 | 修复（严重/P0）：guardian 故障分类——系统只读/引导软链冲突判定为不可回退（停止无意义回退重启，防无限重启），仅插件配置变更才走 git 回退 |
| 1.7.1 | 修复：guardian 插件安装事故识别（救援时 diff 插件配置，标注疑似装插件崩溃）+ 开机自启脚本 |
| 1.7.0 | 功能7：救援积分（事件流权威防刷分，设备 ID 标识，未来排行榜） |
| 1.6.0 | 功能6：异常感知增强——flapping 检测（无限重启识别+冷却）/ 业务就绪探活（假活识别）/ 现场捕获（stderr 落盘+TERM 追踪）/ sessions 基线+增量策略 |
| 1.5.1 | 修复（严重）：接管式重启增加「超时后主动拉起」——手动启动的实例（如测试实例 dsh-test-instance.sh）kill 后无自动重拉，60s 未恢复则执行 DSH_START_CMD（默认测试实例脚本）主动拉起，再轮询 240s |
| 1.5.0 | 功能5：会话恢复联动（session-manager 装了才调用 scan 续跑，没装跳过，不内置） |
| 1.4.1 | 修复（严重）：接管式重启脚本不再 kill -9 runner（SIGKILL 触发 s6 退避，重拉延迟 15s→4min），只发 TERM；轮询窗口 150s→240s |
| 1.4.0 | 功能4：接管式重启（独立脚本重启+验证，规避会话中断；配套 skill 档案） |
| 1.3.0 | 功能3：自动更新（强制跟随 GitHub 最新稳定版，隐藏开关 env 可关） |
| 1.2.2 | 修复：工具注册补 parameters（Agent 调用 git_rescue_* 整轮失败） |
| 1.2.1 | 修复：备份仓名改用设备稳定指纹（machine-id），不再依赖主机名 |
| 1.2.0 | 功能2 guardian 独立救援进程 |
| 1.1.0 | 功能1 git 版本管理插件本体 |

> 开发期修复的 bug（webServer 注册签名、tools output schema、bad 标记顺序、空仓 seed、ref 更新、软链推送）计入功能实现本身，Z 从发布后修复开始计数。
