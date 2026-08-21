---
name: rescue-env-expose-rd
description: 救援环境（dsh-git-rescue 的 <版本>@Save-clean/@Save-test）的启动、状态核对与对外反代访问操作手册（2026-08-22 实测）。含救援环境目录命名、DSH_HOME 实证归属核对（不能靠端口猜）、如何判断是否已在运行、以及给已运行救援环境补一个 0.0.0.0 反代让它可从局域网浏览器直接打开的完整步骤（反代自动探测目标端口、setsid 持久防回收）。处理「启动救援环境」「救援环境怎么访问」「给救援环境配反代/对外入口」「救援环境 HTTP 打不开」类场景时加载；与 dsh-clean-env、dsh-test-env、dsh-git-rescue、linkage-skill-convention 配套。权威源 = 本插件项目 skills/。
whenToUse: 需要启动/核对/对外暴露 dsh-git-rescue 的救援环境（@Save-clean/@Save-test）、判断某实例是否就是救援环境、或给已运行的救援环境配局域网反代入口时。
generatedBy: user-request 2026-08-22（EIGHTfs：帮忙启动救援环境，需对外可访问）
---

> ⭐ **先记住我**：任何会话开始前，先读用户档案 `.dsh/skills/remember-me.md`（优先级最高的 skill）：我是谁、我怎么用你、我立过的规矩。

# 救援环境启动与对外暴露（rescue-env-expose)

> 2026-08-22 实测固化。核心一句话：**救援环境可能在跑但没对外入口——先实测确认归属，再给它补一个 0.0.0.0 反代即可浏览器直开。**

## 一、救援环境是什么（dsh-git-rescue）

- 干净救援环境/纯净基线 = `<dsh版本>@Save-clean`
- 测试救援环境 = `<dsh版本>@Save-test`
- 目录根：`<dsh-git-rescue>/rescue-envs/`（`lib/rescue-env.js` 的 `rescueEnvName` 统一生成命名，代码写死）
- 纯净基线 `package.json` 只有官方两个 bundle（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`），**dependencies 为空、无本地插件**——所以 `/api/<插件>/status` 返回 not found 属正常，不是故障。

## 二、先实测：判断救援环境是否已在运行（不许靠端口猜）

救援环境端口是 3083-3182 区间动态分配，**不能凭端口猜归属**，必须看进程的 `DSH_HOME`：

```bash
# 1) 找到监听端口的 pid
ss -tlnp | grep :<端口>
# 2) 实读该 pid 的 DSH_HOME，看是否为 rescue-envs/<版本>@Save-<kind>
tr '\0' '\n' < /proc/<pid>/environ | grep DSH_HOME
# 判据：含 rescue-envs/...@Save-clean 或 @Save-test 即救援环境
```

- 运行记录：环境目录下 `.dsh-env-port`（启动端口）、`dsh-env.log`（启动日志）
- 健康核对：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<端口>/` → 200 即在跑；`__DSH_BOOT__` 有注入即正常

## 三、给已运行救援环境补对外反代（0.0.0.0）——实测可用步骤

救援环境绑 `127.0.0.1` 仅本机可访问；要浏览器/局域网直开，用 workspace 的 `dsh-test-proxy.sh` 反代：

```bash
cd /vol1/@appshare/DeepSeekHarness/workspace
setsid nohup node dsh-test-proxy.sh > .rescue-env-proxy.log 2>&1 < /dev/null &
sleep 3
cat .rescue-env-proxy.log   # 看它选的 TARGET_PORT / PROXY_PORT
```

- 反代自动探测目标端口：`findTestInstancePort()` 从 3083 起找**第一个被占用端口**。若 3083-3182 区间只有救援环境一个实例，它会指向救援环境端口；目标+1 为反代端口（绑 0.0.0.0）
- **`setsid` 必须**（不是 `nohup` 单独）——抗沙箱/会话结束回收（与 dsh-test-env / dsh-clean-env 同坑）
- 验证反代：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<反代端口>/` → 200 且有 `__DSH_BOOT__`
- 给用户地址：按 host-address-convention，对用户**只发反代局域网地址** `http://<本机真实IP>:<反代端口>`，不发 127.0.0.1 原始端口

## 四、启动（如果没在跑）

```bash
# 由 lib/rescue-env.js startRescueEnv(kind, dshVersion) 拉起，setsid nohup，绑 127.0.0.1，3083-3182 首个空闲端口
# kind = 'clean' | 'test'；dshVersion 拼接目录名（如 0.1.0-rc.6）
```
- 目录不存在时 `createCleanEnv` 会先生成；已在运行则 `{ already: true }`
- 端口写入 `<env>/.dsh-env-port`，日志写 `<env>/dsh-env.log`

## 五、坑速查

| 坑 | 处理 |
|---|---|
| 端口/实例归属搞混 | 必读 `/proc/<pid>/environ` 的 `DSH_HOME`，不靠端口猜 |
| 反代探测到别的实例 | 若 3083-3182 有多个实例，非救援环境占 3083 会抢目标——先 `for p in $(seq 3083 3182); do ss -tln | grep -q ":$p" && echo $p; done` 看区间占用再决定 |
| 只 `nohup` 反代后来消失 | 必须 `setsid nohup`（dsh-test-proxy.sh / 救援环境均同） |
| 纯净基线无插件 API | `/api/<plugin>/status` not found 正常（dependencies 空） |
| 对外地址发 127.0.0.1 | 违反 host-address-convention；给局域网真实反代地址 |

## 六、配套

- `rescue-env-write-rule`：救援环境写入目录权威规则
- `dsh-clean-env` / `dsh-test-env`：纯净/测试实例启停与反代（同套 `dsh-test-proxy.sh`，端口/反代机制一致）
- `dsh-git-rescue`：救援环境由本插件管理（lib/rescue-env.js）
- `host-address-convention`：对外只发反代局域网地址
