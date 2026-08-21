# 📋 崩溃记录：测试环境（2026-08-18）

> dsh-git-rescue 插件 + guardian 在**测试实例**（dsh-test-home，端口 3083）实测产生的全部崩溃/救援记录。
> 时间均为 Asia/Shanghai（UTC+8）。来源文件：
> `dsh-test-home/git-rescue/events.jsonl`（插件事件）、`guardian-events.jsonl`（guardian 事件）、
> `dsh-test-home/.git`（崩溃留证提交）。

---

## 一、崩溃事件清单（插件检出 ×2）

| # | 检出时间 | 崩溃进程 | 心跳过期 | 自动动作 | 留证提交 |
|---|----------|----------|----------|----------|----------|
| 1 | 02:19:29 | pid 751607 | 233,612ms | commit 现场 | `bd6824c` |
| 2 | 02:31:46 | pid 755516 | 277,878ms | commit 现场 | `96b244c` |

事件原文：

```
{"ts":"2026-08-18T02:19:29.483Z","type":"crash-detected","lastHeartbeatAgeMs":233612,"lastPid":751607}
{"ts":"2026-08-18T02:31:46.375Z","type":"crash-detected","lastHeartbeatAgeMs":277878,"lastPid":755516}
```

**行为**：实例被 kill -9 → 心跳停止 → 重启后插件读到过期心跳（>90s 阈值）→ 记录 `crash-detected` 事件 → 自动 commit 坏现场（`chore(guard): crash-detected | pre-rollback snapshot of broken state`）。

---

## 二、guardian 自动救援记录（×1 完整流程）

**场景**：故意破坏 `cordis.patch.yml` 为非法 YAML → DSH 完全无法启动 → guardian（独立进程）自动救援。

```
02:21:44  健康检查失败（连续 1/3）
02:21:54  健康检查失败（连续 2/3）
02:22:04  健康检查失败（连续 3/3）→ 触发自动救援
02:22:04  坏点标记: bad-c6a588b            ← 坏提交标记，防回退死循环
02:22:04  已回退到 bd6824c（from c6a588b） ← git reset --hard 秒级完成
02:22:04  启动 DSH: <自动拉起命令>
02:22:09  ✅ 救援成功：回退到 bd6824c 后 DSH 恢复正常  ← 5 秒自愈
```

**关键事实**：
- 检出阈值：连续 3 次探活失败（每 10s 一次，`GUARDIAN_FAIL_THRESHOLD=3`）
- 救援动作全自动：保留坏现场 commit → bad 标记 → git 回退 → 拉起 DSH → 健康自检
- 恢复后 `cordis.patch.yml` 回到合法内容，实例 3083 健康（HTTP 200）
- 坏提交 `c6a588b` 完整保留损坏现场（`git show c6a588b` 可见被破坏的 patch），供事后分析

---

## 三、git 留证（崩溃/回退全部留痕）

### 提交历史

```
96b244c chore(guard): crash-detected | pre-rollback snapshot of broken state | auto snapshot
bd6824c chore(guard): crash-detected | pre-rollback snapshot of broken state | auto snapshot
0283daf chore(guard): init | baseline snapshot of .dsh
```

### bad 标记（坏点清单）

| tag | 指向提交 | 来源 |
|-----|----------|------|
| `bad-17bd8b3` | 17bd8b39 | 破坏测试 A（篡改 settings.yaml） |
| `bad-89cf28e` | 89cf28e1 | 破坏测试 B（连环破坏） |
| `bad-ab0f4f3` | ab0f4f32 | 破坏测试 C（删除被跟踪文件） |
| `bad-c6a588b` | c6a588bd | guardian 自动救援（灭门级破坏） |

---

## 四、附带观察

1. **崩溃 commit 保护了并发开发内容**：`96b244c`（崩溃#2 现场）顺带保住了另一个会话开发中的 `dsh-ai-work-archive` 插件源码 500+ 行（lib/index.js、scanner.js、syncer.js）——崩溃时工作区未提交内容被全量快照，这就是"历史即资产"的实证。
2. **startup 事件不等于健康**：events 里 02:32~02:38 有 8 次 startup，其中多次是测试实例因 `dsh-ai-work-archive` 插件报错导致**整体启动失败**，但 git-rescue 在完整 boot 前已写入 startup 事件。健康与否以 guardian 探活为准。
3. **心跳现状**：最后一次心跳 10:40:13 由 pid 763438 写入（实例已停）——若再次启动将检出第 3 次崩溃，可作为回归验证样本。

---

## 五、验证了哪些能力（对照设计）

| 设计能力 | 证据 |
|----------|------|
| 崩溃检测（心跳过期阈值） | 2 次 `crash-detected`，过期 233s/277s 均正确检出 |
| 崩溃自动留证 | 每次崩溃自动 commit 现场 |
| guardian 独立探活 + 阈值防误判 | 连续 3 次失败才触发 |
| 坏点标记防死循环 | `bad-c6a588b` 等 4 个标记生效 |
| git 回退秒级完成 | 02:22:04 检出 → 02:22:09 恢复 |
| 自动拉起 + 健康自检 | 恢复后 HTTP 200 |

*记录整理于 2026-08-18，基于测试环境实测日志。*
