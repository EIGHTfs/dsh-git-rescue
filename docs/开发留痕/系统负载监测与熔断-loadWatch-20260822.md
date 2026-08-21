# 工作留痕：系统负载监测与熔断 loadWatch（v2.3.1，2026-08-22）

## 任务背景
2026-08-22 本机 DSH 崩溃：死循环解码损坏 zstd 会话日志的进程（91% CPU / 200MB+）把 fnOS 内存+CPU 撑爆 → 系统崩溃重启 → 正在写入的会话文件被物理截断（EIO 损坏）。根因：guardian 只能「事后救援」，无法「事前发现」高负载进程。

本任务：让救援插件**主动拦截/保护**高负载任务，防死循环进程拖垮系统。

## 改动

### guardian/server.js（核心）
- **CFG 新增** 7 个负载监测配置项（loadWatchEnabled / loadMemFreeMbMin / loadCpuPctMax / loadKillCpuPct / loadKillMaxRetainMb / loadKillConsecutiveCount / loadContinueStopGate，均可 env 覆盖）
- **state 新增** `load` 字段（lastSample / highLoadSince / killed / alerts）
- **`readMemFreeMb()`**：读 /proc/meminfo MemAvailable → 可用内存 MB
- **`sampleProcesses()`**：`ps -eo pid,pcpu,rss,cmd` 采样，返回按 CPU 排序的进程列表
- **`loadWatch()`**：每 tick 调用——
  1. 找「死循环级」进程（CPU≥95% 且 RSS≤200MB 且非 guardian/runner/主DSH）→ 连续 3 次采样超阈值 → `SIGKILL` 熔断（防误杀豁免正则）
  2. 可用内存 <512MB → 记事件 + 网页告警
  3. 高负载持续 30s → 联动 session-manager 暂停自动续跑
- **`stopSessionAutoContinue()`**：调 `/api/session-manager/auto-continue-gate` 置 closed
- **tick()** 开头调用 loadWatch（独立 try-catch fail-soft，失败不影响主流程）
- **/api/status** 暴露 `load` 字段

### lib/index.js（插件侧增强）
- **`readSystemLoad()`**：读 /proc/meminfo + /proc/loadavg → 负载快照
- **collectStatus** 新增 `load` 字段
- **git_rescue_status 工具** 展示「系统内存: 可用 XMB + 负载」

### README.md
新增 v2.3.1 功能记录（背景/能力表/测试/版本）

## 测试
- 熔断防误杀逻辑单测 4/4：主 DSH 高 CPU 不杀 / guardian 不杀 / 死循环 zstd 解码杀 / 批量 hash 杀
- ps 采样真实输出正则匹配验证通过（header 行跳过）
- guardian 重启后 `/api/status.load` freeMb=7410（实际读到），lastScanAt 实时更新 ✅

## 实际运行时踩的坑
1. **`fs.readFileSync` vs `fs.promises`**：server.js 是 ESM，`import { promises as fs }` 后 `fs` 是 promises 命名空间，**没有** readFileSync → 必须 `import { readFileSync } from 'node:fs'` 并直接用 `readFileSync()`。踩坑后 loadWatch 的 freeMb 一直是 null，实测定位修复。
2. **ps 语法**：`ps -eox` 是错的，会报 `process ID list syntax error`；正确是 `ps -eo pid,pcpu,rss,cmd`。
3. 沙箱：写 `.dsh/profiles/*/node_modules/` 需 danger-full-access（本项目升级后可写）。

## 说明
- guardian 侧（核心 loadWatch/熔断）已重启生效。
- 插件侧（load 快照显示）需重启主 DSH 才生效——为避免中断当前会话，未现在重启，留待下次 DSH 自然重启生效。

## 配套
- README v2.3.1 记录
- skill：low-load-task-discipline（AI 侧低负载纪律）、long-silence-ack（长时间没回复打招呼）
- zstd-session-log-repair 更新：EIO 尾部损坏 + seq gap 深层引用重写 + 死循环解码教训
