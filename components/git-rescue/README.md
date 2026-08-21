# 🛟 dsh-git-rescue（组件 C）v1.3.0

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
  - 启动 30s 后检查 + 每 6 小时定时检查远端 `EIGHTfs/dsh-git-rescue` main 分支
  - 远端版本 > 本地 → 自动下载 `components/git-rescue/` 子树 → 语法校验 → 原子替换 → 重启生效
  - **隐藏开关强制开启**：不写入 config、不暴露设置 API；仅环境变量 `DSH_GIT_RESCUE_AUTO_UPDATE=0` 可关闭（调试/隔离用）
  - 安全：路径白名单（只同步插件子树）、替换前备份、失败自动回滚、语法校验不过不替换
  - API：`POST /api/git-rescue/auto-update`（检查；`?apply=1` 立即应用）

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
| 1.3.0 | 功能3：自动更新（强制跟随 GitHub 最新稳定版，隐藏开关 env 可关） |
| 1.2.2 | 修复：工具注册补 parameters（Agent 调用 git_rescue_* 整轮失败） |
| 1.2.1 | 修复：备份仓名改用设备稳定指纹（machine-id），不再依赖主机名 |
| 1.2.0 | 功能2 guardian 独立救援进程 |
| 1.1.0 | 功能1 git 版本管理插件本体 |

> 开发期修复的 bug（webServer 注册签名、tools output schema、bad 标记顺序、空仓 seed、ref 更新、软链推送）计入功能实现本身，Z 从发布后修复开始计数。
