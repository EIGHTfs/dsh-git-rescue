# 工作留痕：远端备份库 web 入口（P2-2，2026-08-21）

## 任务背景
用户之前问「P2-2 远端恢复备份库 web 入口」，本次实现。

## 改动

### guardian/server.js
新增两个 API 端点：
- `GET /api/backup/status`：读取备份仓库信息（owner/repo/deviceId/dshVersion）、认证状态（token/SSH/none）、最近推送记录（从 events.jsonl 解析最后一条 push 事件）
- `POST /api/backup/push`：调用 `pushSnapshot()` 推送到 `.dsh@<版本>.<设备ID>` 仓库，返回结果

### guardian/public/index.html
新增「📦 远端备份库（② GitHub）」卡片，含：
- 状态行（认证方式 + 仓库名 + 版本 + 设备）
- 仓库详情条（snap）
- 「立即推送」按钮
- 操作消息区

### guardian/public/app.js
新增 `loadBackupStatus()`（每 5s 刷新）+ `doBackupPush()`（按钮点击）+ `start()` 中注册调用。

## 验证
- `node --check guardian/server.js` ✅
- `node --check guardian/public/app.js` ✅
- 未推送（等用户验收）
