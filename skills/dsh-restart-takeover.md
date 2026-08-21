---
name: dsh-restart-takeover
description: DSH 插件/配置变更后的「接管式重启」方案——用独立后台脚本接管 DSH 进程重启、健康恢复轮询与插件自验证，规避「会话随 DSH 重启一起中断、验证无法继续」的困境。含独立脚本模板、端口探测、runner 机制、结果留痕与已知坑。**接管式重启前置门禁（用户 2026-08-22 确立）：会话触发接管式重启前，必须先输出救援环境守护（guardian 控制台）的局域网 IP，并检测全部关键进程（主 DSH/guardian/主反代/救援反代）存活，全部存活才允许继续重启，否则挂起**。处理 DSH 需要重启才能生效的部署（装插件/改配置）、重启会断会话的场景时加载。
whenToUse: 需要重启 DSH（装插件、改 cordis.patch.yml/package.json、升级插件）、重启会中断当前会话但还需继续验证、或要固化「重启→验证→留痕」为可复用操作时。
---

> ⭐ **先记住我**：任何会话开始前，先读用户档案 `.dsh/skills/remember-me.md`（优先级最高的 skill）：我是谁、我怎么用你、我立过的规矩。

# DSH 接管式重启方案（dsh-restart-takeover）

> 经验来源：2026-08-18 主实例部署 dsh-git-rescue（1.2.2 → 1.3.0 两次接管重启实测）。
> 核心困境：DSH 重启会中断**所有会话**（含正在执行的 Agent 回合），任何「kill → 等恢复 → 继续验证」的同步流程都会在 kill 的瞬间断掉。
> 解法：**把重启+验证交给独立后台进程（setsid + nohup）接管**，脚本自持完整流程，结果写日志文件，会话恢复后再读。

> 📦 相关源码：guardian/server.js + guardian-boot.sh 在 `dsh-git-rescue` 仓库（地址见 **dsh-repo-index**）。

## 一、什么时候需要接管重启

- 装插件 / 改 `cordis.patch.yml` / 改 profile `package.json` → 需重启 DSH 生效
- 任何「重启后还要验证」的操作（插件 API、心跳、git 仓库）
- 升级插件版本后需验证新版本是否加载

## 二、核心流程（一句话）

```
写独立重启脚本(含验证) → setsid nohup 后台启动 → 脚本: TERM runner → 轮询端口恢复
→ 等插件加载 → curl 验证 → 结果写日志文件 → 会话恢复后读日志
```

## 三、脚本模板（实测可用）

```bash
#!/bin/bash
# 独立重启+验证脚本（不依赖 DSH 进程存活）
LOG=/vol1/@appshare/DeepSeekHarness/workspace/.main-restart-verify.log
: > "$LOG"
echo "[$(date +%T)] 开始" >> "$LOG"

# 1) TERM runner（fnOS s6 会自动重拉；若用 dsh-test-instance.sh 手启则需自行再启）
RPID=$(ps -eo pid,args | grep "bin/runner.js" | grep -v grep | awk '{print $1}' | head -1)
echo "[$(date +%T)] runner PID=$RPID" >> "$LOG"
[ -n "$RPID" ] && kill "$RPID" 2>/dev/null

# 2) 轮询端口恢复（最多 150s）
UP=0
for i in $(seq 1 30); do
  sleep 5
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3081/ -m 3 2>/dev/null | grep -q 200; then
    UP=1; echo "[$(date +%T)] 3081 恢复 (第 $i 轮)" >> "$LOG"; break
  fi
done

# 3) 等插件加载 + 验证
if [ "$UP" = 1 ]; then
  sleep 8   # 给插件 apply 留时间
  echo "[$(date +%T)] --- /api/git-rescue/status ---" >> "$LOG"
  curl -s http://127.0.0.1:3081/api/git-rescue/status -m 5 >> "$LOG" 2>&1
  echo "" >> "$LOG"
else
  echo "[$(date +%T)] ❌ 未恢复" >> "$LOG"
fi
echo "[$(date +%T)] 完成" >> "$LOG"
```

启动方式（关键——必须脱离 DSH 进程组）：

```bash
setsid nohup bash /path/to/restart-script.sh > /dev/null 2>&1 < /dev/null &
```

## 四、三个关键机制（为什么能活过重启）

1. **setsid + nohup + 重定向**：脱离 DSH 的进程组/会话，DSH 被杀不影响脚本；`< /dev/null` 防脚本等 stdin。
2. **结果写文件而非靠会话返回**：会话被切断后，唯一可靠的交付通道是日志文件（如 workspace 下 `.main-restart-verify.log`）。
3. **轮询代替等待**：重启耗时不可预测（实测 15~26s），用 `for + sleep 5 + curl 200` 轮询，带超时上限。

## 五、已知坑

| 坑 | 解法 |
|----|------|
| kill 后会话同步等待会断 | 永远先 setsid 后台化，再让脚本自己 kill |
| `pkill -f` 匹配到自己 | 用精确 PID（`ps ... | grep runner.js | grep -v grep`） |
| 测试实例（3083）无自动重拉 | dsh-test-instance.sh 手启，kill 后需脚本内 `setsid bash dsh-test-instance.sh &` 重新拉起（v1.5.1 起接管脚本内置：60s 未自动恢复 → 执行 DSH_START_CMD，默认探测 dsh-test-instance.sh 自动拉起） |
| 主实例 runner（3081）由 fnOS s6 管理 | TERM runner 后 s6 自动重拉（实测 15~26s 恢复），不要手动 spawn dsh（会绕过 runner 的权限修复） |
| 手动启动实例 kill 后永远等不到 | 接管脚本 60s 轮询超时后必须**主动拉起**（DSH_START_CMD 环境变量可覆盖默认命令）；只靠 s6 自动重拉的假设对手动启动实例不成立 |
| 验证太快插件未加载 | 端口 200 ≠ 插件就绪，sleep 8~15s 再 curl 插件 API |
| 日志在 /tmp 被清 | 日志/脚本落 workspace（跨沙箱可见），别用 /tmp |

## 六、验证清单（重启后必查）

1. `ps` 确认新 PID（旧 PID 消失、新 PID 出现）
2. `curl /api/git-rescue/status` → `ok:true`
3. 心跳文件 mtime 更新、pid 指向新进程
4. 插件 API（如 `/api/git-rescue/log`）可调
5. 事件流 `events.jsonl` 出现新 `startup` 事件

## 七、会话触发接管式重启的前置门禁（2026-08-22 用户确立，硬规则）

> **规则**：任何「会话因装插件/改配置需要接管式重启」之前，必须先做两件事——
> ① **输出救援环境守护进程的 IP（guardian 网页地址，局域网可访问）** 给用户；
> ② **检测全部关键进程存活，全部存活才允许继续重启**；否则先处理未存活项，重启动作挂起。

### 7.1 先输出救援环境守护进程 IP（guardian 控制台地址）
- 实测本机局域网 IP：`hostname -I | awk '{print $1}'`（本机 = `10.10.10.4`）
- 救援环境守护 = guardian 网页控制台，地址 **`http://<本机IP>:<guardian端口>`**（guardian 端口默认 3082，`ss -tlnp | grep ':3082'` 实测确认）
- 每次会话触发重启前，把该地址**明确输出给用户**（按 host-address-convention 只给局域网地址，不发 127.0.0.1）
- 目的：让用户知道救援守护在哪，重启过程有兜底可盯

### 7.2 检测全部存活，全活才继续重启
重启动作（TERM/kill）**之前**，先检测以下关键进程/端点，**全部 HTTP 200 / 活着才允许重启**：

```bash
# 逐个探活；任一失败即挂起重启并告警
for p in 3081:主DSH 3082:guardian控制台 3080:主反代 3146:救援反代; do
  port="${p%%:*}"; name="${p#*:}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${port}/" 2>/dev/null)
  echo "$name($port): ${code:-未监听}"
done
```

- **全部存活**（都 200/活着）→ 才执行接管式重启
- **任一未存活** → **挂起重启**：先记录哪个挂了、尝试拉起或告警用户处理；全活后再重启
- 判据不只看主 DSH(3081)：guardian 守护、主反代(3080)、救援反代(3146) 都要活，保证重启任何一环不丢兜底

### 7.3 重启前门禁在脚本中的体现
接管脚本开头先输出 guardian 守护地址 + 做存活检测；全活才进入 TERM 步骤。示例：
```bash
#!/bin/bash
LANIP=$(hostname -I | awk '{print $1}')
# ① 输出救援环境守护（guardian 控制台）地址
GUARDIAN_PORT=$(ss -tlnp 2>/dev/null | grep ':3082 ' >/dev/null && echo 3082 || echo 3082)
echo "[$(date +%T)] 救援守护地址: http://${LANIP}:${GUARDIAN_PORT}" 
# ② 存活检测：全 200 才继续，否则挂起重启并告警
alive=1
for port in 3081 3082 3080 3146; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${port}/" 2>/dev/null)
  echo "[$(date +%T)] 探活 :${port} → ${code:-未监听}"
  [ "$code" = "200" ] || alive=0
done
if [ "$alive" != "1" ]; then
  echo "[$(date +%T)] ❌ 有进程未存活，挂起重启，先处理告警"; exit 1
fi
echo "[$(date +%T)] ✅ 全部存活，继续接管式重启"
# ... 全活后才 TERM runner / 轮询 / 验证
```

## 相关

- remember-me（先记住我）：用户档案，优先级最高的 skill
