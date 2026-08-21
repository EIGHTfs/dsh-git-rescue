# P0 优化方案：主实例（3081）部署 dsh-git-rescue 插件 + guardian

> 状态：方案稿 v2（2026-08-18 深夜，承接会话更新）
> 目标：让主实例异常可感知、可留痕、可自动救援——补齐本次"无限重启"调查暴露的最大盲区（主实例 12 次重启、8 段抖动，git-rescue 一条事件都没记到）。

## 〇、认知修正（v2 关键更新）

**旧认知**：主实例 `.dsh` 只读（EROFS），无法安装插件。
**新事实**（2026-08-18 22:5x 实测）：
- 主实例进程（PID 184715）的 mount namespace 里 `/vol1` 挂载为 **rw**；
- 我的 Agent bash 沙箱把 `/vol1` 挂成 **ro**（只放行 `workspace/dsh-git-rescue` 子目录 rw）——这是 DSH 文件沙箱的写入策略，**不是文件系统只读**；
- 铁证：`.dsh/storages/` 里 22:55 的 `.ffaa7ebd-*.tmp` 活跃写入、`session_projcache.json` 22:55 更新、sessions 目录 22:29 mtime——全部来自主实例进程自身。

**结论**：主实例部署插件的障碍从"文件系统只读"修正为"Agent 沙箱不可直接写 .dsh"。可行路径：
1. 通过主实例 runner 的启动前钩子/用户通道写入（推荐）；
2. 或由用户在 GUI/终端手动放置插件包；
3. 或在获得批准后以更大权限执行写入（沙箱放行 .dsh）。

## 一、部署目标与现状

| 项 | 现状 |
|---|---|
| 主实例 | 3081（PID 184706 runner / 184715 dsh web），root 200 OK |
| 主实例 profile | `.dsh/profiles/web/`：cordis.patch.yml（insert: session-manager/galgame）、package.json（依赖 3 个插件）、node_modules 真实目录 |
| 插件加载方式 | `package.json` dependencies `file:./node_modules/<pkg>` + `cordis.patch.yml` insert（测试实例同构，node_modules_local 软链） |
| 主实例 .dsh | **尚不是 git 仓库**（`git log` → not a git repository），git-rescue 状态目录 `.dsh/git-rescue/` 不存在 |
| 服务管理 | fnOS s6 → `bin/runner.js`（spawn dsh web + 3080 反代 + secureDshTree 权限修复）→ dsh 退出码非 0 延迟 1s 退出交给守护层重拉 |
| guardian | 独立进程，探活 3081，failThreshold=3，git 回退 + 拉起 + 自检 |

## 二、部署步骤（分两阶段，可独立落地）

### 阶段 A：插件注册（最小可用：异常可感知 + 自动 commit 留痕）

1. **放置插件包**：将 `components/git-rescue/`（v1.2.2）拷入主实例 `node_modules` 目录
   - 方式：`cp -r` 到 `.dsh/profiles/web/node_modules/dsh-git-rescue/`（真实目录，与现有 session-manager 同构）；
   - 或软链 `node_modules/dsh-git-rescue -> node_modules_local/dsh-git-rescue`（与测试实例同构，便于热更新）。
2. **注册依赖**：`.dsh/profiles/web/package.json` dependencies 增加
   `"dsh-git-rescue": "file:./node_modules/dsh-git-rescue"`（软链方案则指向 node_modules_local）。
3. **patch 挂载**：`.dsh/profiles/web/cordis.patch.yml` 增加
   ```yaml
   - insert:
       - id: git-rescue
         name: 'dsh-git-rescue'
   ```
4. **重启主实例**：`kill 184706`（runner）→ s6 自动重拉 → 插件加载。⚠️ 会中断当前所有会话（含本会话），需用户择时。
5. **验证**：
   - `curl http://127.0.0.1:3081/api/git-rescue/status` → ok:true；
   - `.dsh/git-rescue/heartbeat` 心跳开始写入；
   - 启动时自动对 `.dsh` git init + 基线 commit（首启会较大，sessions 走基线+增量策略）。

### 阶段 B：guardian 部署（崩溃自动回退 + 拉起）

1. **准备启动命令**：`DSH_START_CMD` 需指向主实例真实拉起方式。注意 **runner.js 是唯一正确入口**（内含 secureDshTree 权限修复，直接 spawn dsh 会踩 777 权限坑）：
   `DSH_START_CMD="/vol1/@appcenter/deepseek-harness/bin/start.sh"`（或触发 s6 重启的命令）。
2. **启动 guardian**：
   ```bash
   DSH_PORT=3081 DSH_HOME=/vol1/@appshare/DeepSeekHarness/.dsh \
   GUARDIAN_PORT=3082 DSH_START_CMD="<上面命令>" \
   node /vol1/@appshare/DeepSeekHarness/workspace/dsh-git-rescue/components/git-rescue/guardian/server.js
   ```
   建议以系统服务/独立 setsid 方式常驻，日志落 `.dsh/git-rescue/guardian-dsh.log`。
3. **冲突检查**：主实例已有 s6 守护（dsh 退出会被自动重拉）——guardian 的"拉起"职责与 s6 重叠。**设计要点**：guardian 负责"回退到好版本"（s6 不做 git 回退），拉起交给 s6；guardian 的 DSH_START_CMD 仅在 s6 未自动重拉时兜底，避免双头拉起抢 3081 端口。

## 三、风险与注意

| 风险 | 说明 | 缓解 |
|---|---|---|
| 重启中断会话 | 主实例重启 = 全部会话断线 | 用户择时（夜间/空闲）；重启前可先 `git_rescue_backup` |
| 首启基线 commit 体积 | sessions 为 zstd 二进制，全量基线大 | 插件已有"定期全量基线 + 短周期增量"策略 |
| runner 与 guardian 双拉起 | 同时拉起抢 3081 | guardian 只回退不主动拉起，拉起交 s6（见阶段 B-3） |
| .dsh 权限收紧冲突 | runner 启动前 chmod 700/600 全树 | git-rescue 的 .git 目录会被 chmod 不影响功能（git 对 600 目录内文件可读） |
| Agent 沙箱不能写 .dsh | 部署动作受限 | 走 runner/用户通道，或沙箱放行（需批准） |

## 四、验收标准

1. `/api/git-rescue/status` ok:true，心跳 <90s；
2. Agent 会话可调用 `git_rescue_status/backup/log`（v1.2.2 parameters 修复已就位）；
3. 手动破坏 settings.yaml → `git_rescue_rollback` 恢复；
4. guardian 探活 3081，kill dsh web → 3×10s 检出 → git 回退 → s6 拉起 → 自检通过；
5. 事件流 `events.jsonl` 记录本次所有异常（补上"异常无痕"盲区）。

## 五、待用户确认事项

1. 部署时机（重启主实例会断当前会话）；
2. 插件放置方式：真实目录 vs node_modules_local 软链（软链利于后续热更新）；
3. guardian 是否常驻系统服务（fnOS 无 systemd，需确认 s6 服务注册方式）；
4. GitHub token 是否现在配置（远端备份）。
