---
name: dsh-plugin-main-install
description: DSH 主环境（主实例 3081）插件状态查询与安装全流程。含"搜索/盘点已装插件"的核查点（cordis.patch.yml、package.json、node_modules_local、__DSH_BOOT__、client.js、插件自注册 API）、主环境 .dsh 只读的真相（沙箱命名空间 ro vs 服务器进程命名空间 rw、mountinfo 判别、沙箱升级解锁）、注册三要素（复制源码/依赖声明/patch insert + Node 模块解析向上查找）、官方重启（cmd/main restart、runner 监督模型、detached 延迟重启保会话）、重启后验证命令。处理"主环境装插件/查插件状态/重启主实例"类任务时加载。
whenToUse: 把插件装进主环境（3081）而不是测试实例、查询当前主环境装了哪些插件/插件运行状态、需要重启主实例让插件生效、或听到"主环境 .dsh 只读装不了插件"的说法需要核实/绕行时。配合 dsh-plugin-dev（插件开发/测试实例）使用。
generatedBy: deepseek-official/deepseek-v4-flash
---

# 主环境插件安装与状态查询

> 经验来源：2026-08-18 会话（session-31ce8f5e，把 dsh-session-manager v0.3.0 装入主实例 3081 全流程真机验证）。DSH 0.1.0-rc.6、Cordis 4.0.1。
> ⚠️ **推翻 dsh-plugin-dev 的绝对说法**：dsh-plugin-dev 称"主实例 ~/.dsh 是只读（EROFS）→ 插件只能在测试实例装"——**不准确**。主环境可以装插件，只是 shell 命令沙箱把 /vol1 绑成了只读；服务器进程自己的命名空间里 /vol1 是 rw（见第二节）。

## 一、搜索/盘点插件状态（先查再装）

### 1. 静态清单（三个文件即真相）

| 文件 | 含义 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | **插件加载清单**（唯一应手改）：顶层条目 = 内置包配置覆盖；`- insert:` = 用户插件注册 |
| `~/.dsh/profiles/web/package.json` | profile 依赖（`dsh.profile.bundles` 内置 bundle + file: 本地依赖） |
| `~/.dsh/profiles/<p>/node_modules_local/` | 本地插件源码（测试实例）；主实例无此目录，用户插件源码直接放 `node_modules/` |

主实例 3081 的模块树在 **`~/.dsh/profiles/node_modules/`**（hoisted，含全部内置 `@deepseek-ai/*` 与 zod）；`profiles/web/` 本身**没有** node_modules，Node 解析从 `profiles/web/node_modules` 向上找到 `profiles/node_modules`。

### 2. 区分"内置"与"用户插件"

- **内置**：`@deepseek-ai/dsh-*`（appcenter 与 profile 的 node_modules 同款，dsh-base + dsh-web-app 两个 bundle 全家桶约 196 个包）。`settings.yaml` 里的 `llm-pi-ai` 是内置 LLM 适配器配置（dsh-base 的依赖），**不是**用户装的插件。
- **用户插件**：patch 里 `insert:` 的条目 + node_modules 里的非 @deepseek-ai 包（或 @dsh-external scope）。

### 3. 运行时验证（curl 三板斧，主/测试实例同理）

```bash
curl -s http://127.0.0.1:3081/ | grep -oE '"id":"<插件名>"'            # __DSH_BOOT__ 含插件（client 侧注册）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/plugins/<name>/client.js  # 200=client 已加载；纯服务端插件 404 属正常
curl -s http://127.0.0.1:3081/api/<plugin>/<endpoint>                # 插件自注册 API 有返回=host 侧已加载
```

提取全部 boot 插件 id：`curl -s http://127.0.0.1:3081/ | grep -oE '"id":"[^"]+"' | sort -u`
插件清单的运行时真相在 Cordis Loader（`dsh-host-plugin-inventory` 的 `list()` 每次直读 loader，无文件缓存）。

### 4. 进程与命名空间判别

```bash
ps aux | grep -E "runner.js|bin.js web" -- --host   # 找实例：runner.js(父) → dsh bin.js web(子)
ss -tlnp | grep -E ':308[0-9] '                     # 端口占用
grep -E " /vol1 |appshare" /proc/<web-pid>/mountinfo # 服务器进程命名空间里 /vol1 是 rw
grep -E " /vol1 " /proc/self/mountinfo              # 我的 shell 沙箱命名空间里 /vol1 是 ro（master:52 同一 zfs dev）
```

## 二、主环境 .dsh"只读"的真相与解锁

- 事实：`/vol1` 是 zfs `trim_b0afc535-...`（设备 0:40）。**沙箱命名空间**把 /vol1 绑成 `ro`（`touch` 报 "Read-only file system"）；**web 服务器进程命名空间**里同一设备挂成 `rw`（所以会话日志一直能写）。
- 判别：`grep " /vol1 " /proc/self/mountinfo`（ro + master:52）vs `/proc/<web-pid>/mountinfo`（rw）。
- 解锁：bash 工具对 .dsh 的写操作被拒后，用 `sandbox_permissions: danger-full-access` 重试同一命令（获得审批后 /vol1 即 rw），后续所有写 .dsh 的命令都走该模式。
- ⚠️ 别用 `dsh plugin --profile web add`：它只是 pnpm 转发器（写 profile + reconcile `dsh.profile.bundles`，**不写 cordis.patch.yml**），且要求 profile 可写。主环境安装用下面第三节的手工三要素。

## 三、安装（注册三要素 + 模块解析）

以 dsh-session-manager 为例（源码取自测试实例 `dsh-test-home/profiles/web/node_modules_local/dsh-session-manager`）：

```bash
PROFILE=/vol1/@appshare/DeepSeekHarness/.dsh/profiles/web
NODE=/vol1/@appcenter/deepseek-harness/bin/node

# 1) 源码三件套复制（lib/ + package.json + cordis.patch.yml，勿带测试脚本）
mkdir -p "$PROFILE/node_modules/dsh-session-manager"
cp -r <src>/lib <src>/package.json <src>/cordis.patch.yml "$PROFILE/node_modules/dsh-session-manager/"

# 2) package.json 注册依赖（node 读写 JSON，勿手拼）
"$NODE" -e 'const fs=require("fs");const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));j.dependencies=j.dependencies||{};
j.dependencies["<name>"]="file:./node_modules/<name>";
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$PROFILE/package.json"

# 3) cordis.patch.yml：把空数组 [] 整行替换为 block（[] 后面不能跟 block 条目，非法 YAML）
"$NODE" -e 'const fs=require("fs");const p=process.argv[1];
let c=fs.readFileSync(p,"utf8");
const block="- insert:\n    - id: <name>\n      name: <name>\n";
if (c.includes("<name>")) process.exit(0);
c=/^\s*\[\]\s*$/m.test(c)?c.replace(/^\s*\[\]\s*$/m,block):c.trimEnd()+"\n"+block;
fs.writeFileSync(p,c);' "$PROFILE/cordis.patch.yml"
```

- 依赖解析：插件 import 的 `@deepseek-ai/*`、`zod` 在主实例 `profiles/node_modules` 全量存在，无需额外安装。

### 插件自注册 vs 外部 insert（2026-08-20 rc.8 实测澄清）

**两种注册机制，别混淆（这是踩过两次的坑）：**

1. **插件自带的 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch`）→ 自动注册，无需外部 insert**
   - 当插件是 DSH **依赖树的一部分**（即在 `profiles/node_modules` 里、且被 profile 的 bundles 或依赖解析到）时，DSH 会**自动应用插件的 bundle patch**，插件自己 insert 自己
   - 实测：rc.8 只在 `cordis.patch.yml` 手动 insert 了 5 个插件，**没 insert git-rescue**，但重启后日志出现 `[git-rescue] 已启动` —— 它就是靠自注册生效的
   - 判断：看插件 package.json 有没有 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`。有 → 装进 node_modules + package.json 依赖即可，**无需外部 insert**（外部 insert 反而可能二次加载，但 DSH 按 id 去重，一般不冲突）

2. **profile 层 `cordis.patch.yml` 的 `- insert` → 显式注册（需要时才用）**
   - 用途：给插件**传 config**（如 git-push 的 workspaceRoot、session-manager 的 groupRoot）、或注册**不带 bundle patch 的插件**
   - 只有 config 需要的插件才必须外部 insert；纯自注册插件外部 insert 只为了覆盖配置

**排查步骤**：某插件装了但没生效 → 先看它的 package.json 有无 `dsh.bundle.patch`；有 → 检查它在 node_modules 的放置与依赖解析；无 → 才需要外部 insert。

- 插件自带的 `cordis.patch.yml`（`dsh.bundle.patch`）在**非 bundle 层**下是惰性文件，不会造成二次注册。
- 注册 ≠ 加载：必须重启实例才生效（HMR 只能热更已加载插件的 config，不能补注册新插件）。

## 四、重启主实例（关键：先保当前回合）

- **进程模型**：`runner.js`（ppid 1，fnOS 监督）spawn web 子进程；web 退出 → runner 以同码退出 → 外层监督拉起。**重启会杀掉当前会话的宿主进程**（agent 回合运行在 web 进程内）。
- **官方重启**：`/var/apps/deepseek-harness/cmd/main restart`（cron 用的 restart-main.sh 同款；自动推导 TRIM_APPDEST=/vol1/@appcenter/deepseek-harness、TRIM_PKGVAR=/vol1/@appdata/deepseek-harness，pid/log 写在那里）。实测输出 "✓ 重启成功"、rc=0。
- **保回合姿势（务必这样调度）**：直接原地重启会掐断本回合、丢失最终回复。用 detached 延迟重启：

```bash
setsid nohup bash -c 'sleep 30; /var/apps/deepseek-harness/cmd/main restart >> <workspace>/main-restart.log 2>&1' < /dev/null > /dev/null 2>&1 &
```

sleep 给当前回合留出把最终消息落盘的时间（会话 jsonl 持久化，重启后会话自动恢复，GUI 刷新即可继续）。
- ⚠️ **dsh CLI 没有 restart 子命令**（`dsh --help` 只有 `web` 启动和 `plugin` pnpm 转发）；直接 `dsh web` 起第二个实例会 EADDRINUSE，且绕过 runner 监督模型。判断/预热用 `dsh --profile web --dump-config`（打印组合后的配置树，不启动）。

## 五、重启后验证

```bash
curl -s http://127.0.0.1:3081/ | grep -oE '"id":"dsh-session-manager"'   # boot 含插件
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/plugins/dsh-session-manager/client.js  # 200
curl -s http://127.0.0.1:3081/api/session-manager/list | head -c 300     # API 有返回
```

## 六、坑速查

| 坑 | 处理 |
|---|---|
| 插件装了没生效，以为 insert 漏了 | 先看 package.json 有无 `dsh.bundle.patch`：有 → 自注册，检查 node_modules 放置/依赖解析即可；无 → 才需外部 insert（见三节「自注册 vs 外部 insert」） |
| 外部 insert 和插件自注册都写了 | 一般不冲突（DSH 按 id 去重）；但 config 重复定义时以 profile 层 patch 为准 |
| `touch .dsh` 报 Read-only file system | 沙箱命名空间 ro；升级 danger-full-access（服务器命名空间本来就是 rw） |
| node -e 报 `ERR_INVALID_ARG_TYPE: path undefined` | 忘传 `process.argv` 路径参数；脚本用 `process.argv[1]` 且命令尾必须带文件路径 |
| `require('js-yaml')` MODULE_NOT_FOUND（NODE_PATH 失效） | 用绝对路径 require：`require('/vol1/.../profiles/node_modules/js-yaml/index.js')` |
| patch 里 `[]` 后追加 `- insert:` | 非法 YAML；必须把 `[]` 整行替换成 block |
| 插件 client.js 加载了但 UI 不生效 | 检查 client.js 末尾 `exports.apply/inject`（dsh-plugin-dev 十节） |
| 重启把会话掐断 | 用 setsid+nohup+sleep 延迟重启，先让回合落盘 |
| runner 每次启动收紧权限 | `secureDshTree()` 把 .dsh 目录 chmod 700、文件 600（同用户可读，正常现象） |

## 七、验证状态

- **dsh-session-manager v0.3.0 → 主实例 3081** ✅ 2026-08-18 真机验证：boot 含 id、client.js 200、`/api/session-manager/list` 返回会话 JSON（含 running/autoContinue/archived 字段），侧边栏「会话管理」入口可见。安装后主实例 patch 从 `[]` 变为 `- insert: dsh-session-manager`。
- 测试实例 3083 不受影响（蓝绿独立），仍由 dsh-test-env skill 管辖。
