# DEVELOPMENT-2026-08-19-test-env-jump-fix

## 任务背景

主环境（3081）web「跳转测试环境」功能异常：点击跳转按钮**根本没有跳**（用户预期新标签页打开），且跳转地址打不开。同时用户要求强化 skill 约束禁止写死硬编码参数（IP/主机名）。

## 根因（实测定位）

1. **跳转不执行（主因）**：`client.js` 的跳转用 `window.open(url, "_blank", "noopener")` —— 程序化弹窗，会被浏览器弹窗拦截器拦掉（尤其跨域 + noopener）；且 renderCard 的 `<a href>` 还 `event.preventDefault()` 把原生链接行为也禁了。拦截后完全无反应 = "根本没跳"。
2. **地址写死旧机（次因）**：`test-env-entry.js` Config 默认 `lanUrl: 'http://10.10.10.121'`（原机 fnOS-N2940 已下线）+ `client.js` fallback 双处写死。迁移到本机（10.10.10.4）后未改，跳转目标不可达。
3. **连带发现**：`dsh-test-start.sh` 停止逻辑只 pkill 启动脚本、杀不到直接跑的 `bin.js web` 实例（实测 PID 不变）；尾部 echo 写死旧地址；`dsh-test-instance-stop.sh` 用 kill -9（违背接管式纪律）；`test-env-entry.js` 配置的 `workspace/dsh-test-env-entry/control.sh` 文件缺失（API start/stop 静默失败）。

## 修复内容

| 文件 | 改动 |
|------|------|
| `components/git-rescue/lib/client.js` | 跳转改为原生 `<a target="_blank" rel="noopener noreferrer">` 用户手势导航（浏览器不拦截），删除 preventDefault + window.open 组合；fallback 地址 10.10.10.121 → 10.10.10.4 |
| `components/git-rescue/lib/test-env-entry.js` | Config 默认 lanUrl 'http://10.10.10.121' → 'http://10.10.10.4'（注释标注禁止硬编码旧机地址） |
| `workspace/dsh-test-start.sh` | 停止逻辑补杀 bin.js web 实例（TERM）；端口识别取 head -1；echo 地址改 hostname -I 动态输出 |
| `workspace/dsh-test-instance-stop.sh` | kill -9 改 TERM 接管式；支持端口参数精确停 |
| `workspace/dsh-test-env-entry/control.sh` | 从插件 node_modules_local 副本复制部署到 test-env-entry.js 期望路径（原缺失，API 静默失败） |
| `.dsh/skills/host-address-convention.md` | 新增第六节「禁止硬编码机器地址/IP」硬规则 + 本次反面教材 |

## 验证（实测）

- 测试实例 3083 重启后 `GET /api/dsh-test-env/status` → url 从 `10.10.10.121:3084` 变为 `10.10.10.4:3084` ✅
- `10.10.10.4:3084` HTTP 200 可达；`10.10.10.121:3084` 超时不可达 ✅
- 修复后 dsh-test-start.sh 端到端重启：PID 378024 → 379429（停止逻辑生效）✅
- control.sh 安全面验证：stop 不存在端口不误杀实例、日志留痕 ✅
- `node --check` 两个 lib 文件语法通过；`deploy-gate.sh dsh-git-rescue` 5 项全过 ✅
- 反代 3084 验证后恢复 ✅

## 遗留

- 主环境（3081）host 端 test-env-entry.js 需重启加载新默认值——已填重启申请表 RA-20260819-002 待审批
- dsh-test-env-entry 插件（node_modules_local 里的旧独立插件）与 git-rescue 内置的 test-env-entry 并存，control.sh 有双份来源，后续可考虑收敛
