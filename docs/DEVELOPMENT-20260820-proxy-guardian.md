# 工作留痕：3080 透明代理纳入 guardian 守护（2026-08-20）

## 任务背景
用户反馈「启动 3080 的 dsh」。实测发现：
- 主实例 3081 正常（200），但 **3080 对外代理无任何进程监听**（http_code=000）
- 3080 与 3081 是官方"父子捆绑"启动关系（start.sh / runner.js 一起拉起），当前主实例被**绕过 runner 直接 `bin.js web --port 3081` 拉起**（父进程=1 的孤儿进程），导致配套 3080 代理无人托管
- dsh-git-rescue 的 guardian 只守护 3081，不含 3080 → 3080 长期缺失

用户确认：「纳入管理，更新代码」——把 3080 代理纳入 guardian 统一守护并提交。

## 关键发现（实测）

### 1. 根因链（verify-before-diagnose 全实测）
- `ss -tlnp`：3080 无监听；3081 监听 127.0.0.1；3082 guardian 监听 0.0.0.0
- `ps -ef`：主实例 3081 进程父进程=1（init），`bin.js web --port 3081` 直接启动，**无 runner.js 主进程**
- `main-runner.log`：runner 曾因 `EROFS: read-only file system`（写 `.rescue-dsh/profiles/web/cordis.yml` 失败）退出码 1，之后主实例改为绕过 runner 拉起
- guardian `server.js`：健康检查只探 `--port ${CFG.dshPort}`（3081），无 proxy 逻辑 → 3080 无人兜底
- 官方 `start.sh`/`bin/proxy.js` 注释：代理默认 `0.0.0.0:3080 -> 127.0.0.1:3081`，env 可覆盖（PROXY_LISTEN_PORT/PROXY_TARGET_PORT 等）

### 2. 改动（guardian v1.12.0 → v1.13.0）
`components/git-rescue/guardian/server.js`：
- CFG 增加：`proxyEnabled`（GUARDIAN_PROXY_ENABLED=0 关）、`proxyListenHost/Port`（默认 0.0.0.0:3080）、`proxyTargetHost/Port`（默认 127.0.0.1:3081）
- state 增加：`proxy`（running/stopped/starting）、`proxyStartAt`
- 新函数：
  - `resolveProxyStartCmd()`：同 root 推导官方 proxy.js 路径
  - `findProxyPid()`：**按监听端口匹配**（`ss -tlnp` + `:${proxyListenPort}` + `pid=`），防多实例串扰
  - `startProxy()`：spawn 官方 proxy.js，env 注入端口配置，stderr 落盘
  - `ensureProxy()`：每轮 tick 实时查端口，缺失才拉起；starting 状态 30s 内不重复 spawn
- tick()：DSH 健康分支**每轮无条件** `ensureProxy()`（不依赖 state.proxy 缓存）
- 新 API：`GET /api/proxy/status`（enabled/pid/state）、`POST /api/proxy/start`
- `/api/status` state 增加 `proxy`

### 3. 测试（隔离测试环境验证，非主环境直接试）
**测试 guardian 实例**（DSH_HOME=dsh-test-home，端口 3092，代理 3093→3081）：
- 新代码启动正常，日志 `透明代理守护: ON (0.0.0.0:3093 -> 127.0.0.1:3081)`
- 自动拉起 3093 代理，经 3093 访问 3081 返回 200，`/api/proxy/status` 返回 pid + running

### 4. 测试抓到的两个 bug（写代码不测试的代价）
1. **Bug A：ps 全局匹配串扰**——findProxyPid 初版用 `ps aux | grep bin/proxy.js`，把主实例 3080 的 proxy 误判为测试 3093 的代理在跑（`state.proxy=running` 不拉起）。修复：**按端口精确匹配**（ss -tlnp 查 `:port` + pid）
2. **Bug B：state 缓存短路**——tick 初版 `if (state.proxy !== 'running')` 才检查，proxy 掉线后 state 仍是 running，**永远不会再拉起**。主环境闭环测试抓到（kill 手动 proxy 后 guardian 无反应、proxy/status 报死 pid 261417）。修复：**每轮无条件 ensureProxy()** + 30s 防重复 spawn 冷却

### 5. 主环境闭环验证（最终验收）
- 主 guardian 重启（3082）后自动拉起 3080，`http://127.0.0.1:3080/` 200
- kill 掉 guardian 拉起的 proxy → 20s 内 guardian 自动重新拉起（日志：缺失→拉起→恢复），3080 恢复 200
- 手动 proxy 与 guardian 托管 proxy 均被正确识别（pid 视角一致）

## 踩坑教训
- **guardian 也按 `pgrep -f "guardian/server.js"` 匹配**：pkill 会同时杀主实例 guardian（81443）——本次误杀后用新代码立即重启恢复；测试 guardian 与主 guardian 共用一个进程名，清理测试实例时必须按端口（ss 查 :3092 pid）精确杀
- **主环境 .dsh 沙箱命名空间只读**：同步运行版代码、重启 guardian 需要 danger-full-access（服务器进程命名空间 rw）；普通 shell cp 报 EROFS
- **self-update 版本保护**：guardian 自更新按 `compareVersions(remote, installed) > 0` 判断，本地升 1.13.0 后远端 1.12.0 不会覆盖本地改动；改代码必须同步升版本号

## 交付物
- `components/git-rescue/guardian/server.js`（v1.13.0 proxy 守护）
- `components/git-rescue/package.json`（1.12.0 → 1.13.0）
- 主实例运行版已同步：`/vol1/@appshare/DeepSeekHarness/.dsh/profiles/web/node_modules/dsh-git-rescue/`
- 主 guardian 已重启生效（3082）

## 后续可做
- guardian 网页（public/index.html + app.js）展示 proxy 状态（当前仅 API 可见）
- runner.js 若被恢复使用（cmd/main restart），需处理与 guardian 托管 proxy 的端口冲突（EADDRINUSE 由 proxy.js 失败退出，guardian 下一轮复核）
