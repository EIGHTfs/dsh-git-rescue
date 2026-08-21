# dsh-guardian

DSH 守护服务：实时监控 Harness 运行状态，启动失败自动按快照顺序回退测试，网页可手动控制恢复。

> 独立于 DSH 运行（DSH 崩溃时它照样存活）。配合 [dsh-snapshot-archive](../dsh-snapshot-archive) 插件使用——读取其 zip 快照。

## 功能

- 🔍 **实时监控**：每 10 秒健康检查 DSH（`GET http://127.0.0.1:3081`）
- ↩️ **自动回退**：连续 3 次检查失败 → 从最新快照开始逐个恢复 + 尝试启动 + 健康检查，找到能正常启动的快照为止
- 🖥️ **网页面板**：`http://127.0.0.1:3082` 查看状态、快照列表、日志
- 🎛️ **手动控制**：网页一键 恢复快照 / 启动 / 停止 DSH / 触发回退
- 🔒 **敏感保护**：恢复时脱敏占位符不覆盖真实密钥

## 启动

```sh
./start.sh start        # 启动
./start.sh stop         # 停止
./start.sh restart      # 重启
./start.sh status       # 状态
```

默认端口 3082，可用环境变量覆盖：

```sh
GUARDIAN_PORT=3082          # 网页端口
DSH_PORT=3081               # 被监控的 DSH 端口
GUARDIAN_INTERVAL_MS=10000  # 健康检查间隔
GUARDIAN_FAIL_THRESHOLD=3   # 连续失败次数触发回退
GUARDIAN_AUTO_ROLLBACK=1    # 自动回退开关（0 关闭）
```

## 网页功能

| 区域 | 功能 |
|------|------|
| 状态徽章 | DSH 运行中 / 已停止 / 异常 / 回退中 |
| 手动控制 | 创建快照提示 / 立即检查 / 启动 / 停止 / 触发回退 |
| 快照列表 | 每条可点"恢复"（恢复+重启 DSH） |
| 监控日志 | 实时滚动，分颜色显示 info/warn/error/ok |

## 自动回退流程

```
连续 3 次健康检查失败
  → 停止 DSH
  → 读取快照列表（从新到旧）
  → 恢复最新快照 → 启动 DSH → 等 15 秒 → 健康检查
  → 成功：停止回退，DSH 恢复运行
  → 失败：恢复更早快照，继续测试
  → 全部失败：报警，需人工介入
```

## 手动恢复 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 状态 |
| GET | `/api/snapshots` | 快照列表 |
| GET | `/api/log` | 日志 |
| POST | `/api/restore` | 恢复 `{id}` + 重启 DSH |
| POST | `/api/start` / `/api/stop` | 启停 DSH |
| POST | `/api/rollback` | 触发自动回退 `{reason}` |
| POST | `/api/check` | 立即健康检查 |

## License

MIT
