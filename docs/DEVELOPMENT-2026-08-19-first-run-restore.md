# 开发计划：初次启动远端还原功能

> 版本：v1.9.0-dev  
> 日期：2026-08-19  
> 状态：**待实现**

---

## 一、需求背景

### 场景描述

用户初次安装 dsh-git-rescue 插件时：
- `.dsh` 目录为空（无历史 commit）
- workspace 目录可能已有项目文件（但未纳入 git 管理）
- 用户已在 GitHub 上配置好备份仓库（有历史快照）
- **问题**：当前插件只会初始化新仓库并 commit 空基线，不会主动询问"是否从远端还原已有数据"

### 用户故事

> 作为新用户，我首次安装插件后希望：
> 1. 插件自动检测当前是"空状态"（无历史 commit）
> 2. 询问我是否要从远端 GitHub 仓库还原数据
> 3. 确认后，自动拉取最新快照并合并到本地 `.dsh` 和 `workspace`
> 4. 保留现有配置不被覆盖（合并策略）

---

## 二、功能设计

### 2.1 触发逻辑

```
插件启动 → 检测是否为"初次状态" → 是 → 询问是否从远端还原
                                      ↓ 否
                              正常启动流程
```

**"初次状态"判定条件**（满足任一即视为初次）：

| 条件 | 说明 |
|------|------|
| `.dsh` 仓库无 commit | `git log` 为空 |
| 或 `.dsh` 仓库仅有 1 个空 commit | `git log --oneline` 仅显示 init commit |
| 且未配置 GitHub token | `config.json` 中无 `githubOwner`/`githubRepo` |

**注意**：若已配置 token 且有历史 commit，则跳过此流程（非初次启动）。

---

### 2.2 交互流程

```
┌─────────────────────────────────────────────────────────────┐
│  ① 插件启动检测：初次状态？                                  │
└─────────────────────────────────────────────────────────────┘
                            ↓ 是
┌─────────────────────────────────────────────────────────────┐
│  ② 检查远端仓库是否存在且可访问                               │
│     - 调用 GitHub REST API: GET /repos/{owner}/{repo}       │
│     - 失败 → 记录 warning，跳过还原提示                       │
└─────────────────────────────────────────────────────────────┘
                            ↓ 成功
┌─────────────────────────────────────────────────────────────┐
│  ③ 弹窗询问用户                                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 🔍 检测到您是首次使用 dsh-git-rescue                   │  │
│  │                                                       │  │
│  │ 您是否要从远端 GitHub 仓库还原已有数据？               │  │
│  │                                                       │  │
│  │ 仓库：EIGHTfs/dsh-git-rescue-backup-abc123            │  │
│  │ 最新提交：chore(guard): 2026-08-18 | 159 files        │  │
│  │                                                       │  │
│  │ [✓ 从远端还原]  [暂不还原]                             │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ↓ 用户选择
         ┌──────────────────┴──────────────────┐
         ↓                                     ↓
    [从远端还原]                          [暂不还原]
         ↓                                     ↓
    执行还原流程                          记录 "dismissed" 状态
         │                               （本次启动不重复询问）
         ↓
┌─────────────────────────────────────────────────────────────┐
│  ④ 还原流程                                                 │
│  - 下载远端 zip 快照                                         │
│  - 解压到临时目录                                            │
│  - 合并策略：                                                  │
│    · settings.yaml → 保留本地（若存在）                       │
│    · profiles/ → 合并（同名文件本地优先）                      │
│    · sessions/ → 全量覆盖（会话数据可重新生成）                │
│    · workspace/ → 增量合并（保留本地新增文件）                 │
│  - 验证合并结果                                              │
│  - 提交新 commit                                             │
│  - 更新 status 状态                                          │
└─────────────────────────────────────────────────────────────┘
```

---

### 2.3 API 设计

#### 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/git-rescue/first-run-status` | 检测是否为初次状态 + 远端仓库信息 |
| `POST` | `/api/git-rescue/restore-from-remote` | 执行从远端还原 |
| `POST` | `/api/git-rescue/first-run-dismiss` | 用户选择暂不还原（记录状态） |

#### 端点详情

**`GET /api/git-rescue/first-run-status`**

响应示例：
```json
{
  "ok": true,
  "isFirstRun": true,
  "hasRemoteRepo": true,
  "remoteInfo": {
    "owner": "EIGHTfs",
    "repo": "dsh-git-rescue-backup-abc123",
    "latestCommit": "a1b2c3d",
    "latestCommitMsg": "chore(guard): 2026-08-18 | 159 files",
    "lastPushAt": "2026-08-18T10:30:00Z"
  },
  "dismissed": false
}
```

若未配置 token 或远端仓库不可达：
```json
{
  "ok": true,
  "isFirstRun": true,
  "hasRemoteRepo": false,
  "reason": "no-token"
}
```

---

**`POST /api/git-rescue/restore-from-remote`**

请求体：
```json
{
  "scope": "all",  // "dsh-only" | "workspace-only" | "all"
  "mergeStrategy": "local-priority"  // "local-priority" | "remote-priority"
}
```

响应：
```json
{
  "ok": true,
  "restored": {
    "dsh": true,
    "workspace": true
  },
  "filesRestored": 159,
  "mergeConflicts": [],
  "newCommit": "e4f5g6h"
}
```

---

**`POST /api/git-rescue/first-run-dismiss`**

请求体：
```json
{}
```

响应：
```json
{
  "ok": true,
  "message": "已记录：本次启动跳过远端还原提示"
}
```

状态存储：`git-rescue/first-run-dismissed` 文件（标记本次启动已询问）

---

### 2.4 Agent 工具扩展

新增工具（供 AI 调用）：

| 工具名 | 说明 |
|--------|------|
| `git_rescue_first_run_status` | 检测初次状态并返回远端信息 |
| `git_rescue_restore_from_remote` | 执行从远端还原 |

---

## 三、实现计划

### 阶段一：核心逻辑（~2h）

**文件变更**：
- `components/git-rescue/lib/first-run.js`（新增）
  - `detectFirstRunState()`：检测是否为初次状态
  - `checkRemoteRepo(token, owner, repo)`：检查远端仓库可达性
  - `downloadRemoteSnapshot(token, owner, repo)`：下载 zip 快照
  - `mergeSnapshots(localDir, remoteSnapshot, strategy)`：合并逻辑
  - `recordDismissal()` / `isDismissed()`：状态记录

**代码结构**：
```javascript
// lib/first-run.js
export async function detectFirstRunState(stateRoot, dshRoot, workspaceDir) {
  // 1. 检查 .dsh 仓库 commit 数量
  // 2. 检查是否已配置 token
  // 3. 检查是否已记录 dismissal
  // 返回: { isFirstRun, hasRemoteRepo, remoteInfo, dismissed }
}

export async function restoreFromRemote(token, owner, repo, targetDir, strategy) {
  // 1. 下载 zip 快照
  // 2. 解压到临时目录
  // 3. 按策略合并
  // 4. git add + commit
  // 返回: { ok, filesRestored, conflicts }
}
```

---

### 阶段二：API 集成（~1h）

**文件变更**：
- `components/git-rescue/lib/index.js`
  - 导入 `first-run.js` 模块
  - 在 `apply()` 中添加初次状态检测
  - 注册新 API 端点
  - 注册新 Agent 工具

**关键改动位置**：
```javascript
// lib/index.js - apply() 函数末尾（启动流程）
// v1.9.0：初次启动远端还原检测
if (isFirstRun && !dismissed) {
  const remoteInfo = await checkRemoteRepo(token, owner, repo)
  if (remoteInfo.exists) {
    // 弹窗提示（通过 webServer 前端实现）
    console.log(`[git-rescue] 检测到初次启动，远端仓库可用: ${remoteInfo.repo}`)
  }
}
```

---

### 阶段三：前端 UI（~1.5h）

**文件变更**：
- `components/git-rescue/public/index.html`（或对应的前端文件）
- `components/git-rescue/public/app.js`

**UI 组件**：
```javascript
// 初次启动提示卡片
function renderFirstRunCard(status) {
  if (!status.isFirstRun || status.dismissed) return null
  
  return `
    <div class="card first-run-card">
      <h3>🔍 检测到您是首次使用 dsh-git-rescue</h3>
      ${status.hasRemoteRepo ? `
        <p>发现远端备份仓库：<code>${status.remoteInfo.owner}/${status.remoteInfo.repo}</code></p>
        <p>最新提交：${status.remoteInfo.latestCommitMsg}</p>
        <div class="actions">
          <button onclick="restoreFromRemote()">从远端还原</button>
          <button onclick="dismissFirstRun()">暂不还原</button>
        </div>
      ` : `
        <p class="warning">未检测到远端仓库配置，将初始化新仓库</p>
      `}
    </div>
  `
}
```

---

### 阶段四：测试与验证（~1h）

**测试用例**：

| # | 场景 | 预期结果 |
|---|------|----------|
| 1 | 全新安装（无 commit、无 token） | 提示"初始化新仓库"，无弹窗 |
| 2 | 有 token、有远端仓库 | 弹出还原确认框 |
| 3 | 点击"暂不还原" | 记录 dismissal，本次启动不再询问 |
| 4 | 点击"从远端还原" | 下载→合并→commit 成功 |
| 5 | 远端仓库不存在 | 显示 warning，跳过还原流程 |
| 6 | 合并冲突（本地有同名文件） | 记录冲突列表，用户可选择策略 |

---

## 四、版本规划

| 版本 | 功能 | 状态 |
|------|------|------|
| **v1.9.0** | 初次启动远端还原功能 | **开发中** |
| v1.8.0 | 可选 sudo-key | ✅ 已完成 |
| v1.7.2 | 故障分类（P0/P1） | ✅ 已完成 |
| v1.7.0 | 救援积分 | ✅ 已完成 |

---

## 五、风险与边界

### 已知限制

1. **合并策略简单**：当前仅支持"本地优先"或"远程优先"，不支持手动冲突解决
2. **sessions 覆盖风险**：还原时会覆盖本地 sessions 目录，若本地有重要会话需提前备份
3. **网络依赖**：还原过程需要稳定网络连接 GitHub

### 安全考虑

- Token 仅在内存中使用，不写入任何日志
- 远端下载使用 HTTPS，校验 zip 完整性（SHA256）
- 合并前备份当前状态（`git-rescue/pre-restore-backup/`）

---

## 六、后续优化方向

1. **智能合并**：按文件类型差异化处理（配置 vs 数据 vs 会话）
2. **还原预览**：展示将要覆盖/新增的文件列表，经确认后执行（预览 + 确认两步流程）
3. **多仓库支持**：支持从多个远端仓库选择性还原（如仅还原 settings、仅还原 workspace）
4. **还原历史**：记录每次还原操作，支持"撤销还原"

---

## 七、文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `components/git-rescue/lib/first-run.js` | 新增 | 初次状态检测 + 还原逻辑 |
| `components/git-rescue/lib/index.js` | 修改 | 集成 API + Agent 工具 |
| `components/git-rescue/public/index.html` | 修改 | 添加初次启动提示 UI |
| `components/git-rescue/public/app.js` | 修改 | 前端交互逻辑 |
| `components/git-rescue/README.md` | 修改 | 文档更新 |
| `docs/DEVELOPMENT-2026-08-19-first-run-restore.md` | 新增 | 本开发计划 |

---

## 八、开发检查清单

- [ ] 实现 `lib/first-run.js` 核心逻辑
- [ ] 添加 API 端点（3 个）
- [ ] 注册 Agent 工具（2 个）
- [ ] 实现前端 UI 组件
- [ ] 单元测试（6 个用例）
- [ ] 集成测试（测试实例 3083）
- [ ] 更新 README
- [ ] 提交推送

---

**文档版本**：v1.0  
**最后更新**：2026-08-19  
**作者**：EIGHTfs（需求）+ Agnes（文档）
