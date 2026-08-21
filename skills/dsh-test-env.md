---
name: dsh-test-env
description: DeepSeek Harness (DSH) 双实例测试环境（蓝绿部署）的结构、启停方法、node_modules 解析机制与已知坑。含主实例/测试实例/反代端口、dsh-test-* 脚本、插件加载与验证命令，以及**测试与主环境会话数据默认完全隔离**的硬性约定。处理测试实例启动失败、插件加载、插件热开发、双实例调试、测试与主环境数据隔离时加载。
whenToUse: 用户提到"测试实例"、"测试环境"、"dsh-test"、"蓝绿部署"、"第二个实例"、"插件加载失败/起不来"、需要重启/停止测试实例、验证测试环境状态，或在本 NAS 上调试 DSH 插件时。
---

# DSH 双实例测试环境（dsh-test-env）

> 处理 DSH 测试实例 / 插件热开发 / 双实例调试时加载。本 skill 是 `dsh-blue-green-deploy` 的权威更新版，信息冲突时以本文件为准。

## 数据隔离约定（硬性，用户 2026-08-18 明确）

> **测试环境与主环境的会话数据默认完全隔离**，所有 AI 所有会话一律遵守。

- **独立 DSH_HOME = 独立数据**：主环境 `~/.dsh`，测试环境 `workspace/dsh-sm-test`、`workspace/dsh-test-home` 等。会话日志（`sessions/`）、存储域（`storages/`：workspace 注册表/归档集/插件域）、skills（`skills/`）都在各自目录下，互不读写
- **插件只动自己环境的会话**：自动续跑/自动重命名/会话修复/扫描等操作，主实例上的插件只扫 `~/.dsh/sessions`，测试实例只碰自己的 `sessions/`——不会跨环境
- **禁止自动互通**：测试环境会话/状态不得自动同步进主环境，主环境数据也不得被测试操作污染（除非用户显式要求导入/导出/备份恢复——那是 `dsh-backup-restore` / `dsh-session-transfer` 的显式流程）
- **测试残留要清理**：在测试环境造的损坏会话/脏数据（测试 session 目录、storage 域状态）用完即删，不留到主环境或长期占用
- **例外——代码共享、数据隔离**：插件代码副本（node_modules）可以手动同步到各环境；数据永远各管各的

## 一、架构总览

DSH 插件开发时重启测试实例会中断会话，因此启动**第二份完全隔离的 dsh web 实例**做插件测试：

```
┌─ 主实例（生产/会话）────────────────────────────┐
│  dsh web  127.0.0.1:3081   DSH_HOME=~/.dsh      │
│  反代 0.0.0.0:3080 → 3081（局域网 3080 访问）     │
└──────────────────────────────────────────────────┘
┌─ 测试实例（插件热开发，随意重启/崩溃）─────────────┐
│  dsh web  127.0.0.1:3083-3182（自动分配）         │
│  DSH_HOME=workspace/dsh-test-home（完全隔离）     │
│  反代 0.0.0.0:3084 → 测试实例（局域网 3084 访问）  │
└──────────────────────────────────────────────────┘
```

- 测试实例绑定 `127.0.0.1`，反代绑 `0.0.0.0`，局域网固定走 **3084**（proxy 端口 = 测试端口 +1，即 3084）
- 反代会改写 host/origin/referer/sec-fetch-site 头做同源欺骗，并注入 `crypto.randomUUID` polyfill

## 二、文件清单（workspace 根目录）

| 文件/目录 | 用途 |
|---|---|
| `dsh-test-instance.sh` | 启动测试实例：自动找 3083-3182 空闲端口，`exec env DSH_HOME=... bin.js web --host 127.0.0.1`；从主实例同步 cordis.yml/settings.yaml/pnpm-workspace.yaml（**不覆盖** cordis.patch.yml 和 package.json） |
| `dsh-test-proxy.sh` | 反代 3084 → 测试实例，注入 polyfill |
| `dsh-test-start.sh` | 一键启停流程（先 pkill 旧进程再拉起两者） |
| `dsh-test-instance-stop.sh` | 停止测试实例；`--also-kill-proxy` 同时停反代 |
| `dsh-sync-plugins.sh` | 插件同步脚本 |
| `find-free-port.cjs/.sh` | 空闲端口查找工具 |
| `dsh-test-sync-plugin/` | 蓝绿同步插件源码（`@deepseek-ai/dsh-test-sync`） |
| `dsh-test-home/` | 测试实例独立数据目录（profiles/sessions/storages/skills/settings.yaml） |
| `dsh-clean-env.sh` | **纯测试环境（初始、不含本地插件）**快速生成/启停：`create\|start\|stop\|status`，默认目录 `dsh-test-home-clean`，与 dsh-test-home 完全隔离 |

## 三、使用方法

```bash
cd /vol1/@appshare/DeepSeekHarness/workspace

# 启动（一键）
./dsh-test-start.sh
# ⚠️ 该脚本只等 4 秒就 grep 端口，而实例完整启动要 8-12 秒，
#    常误报"无法找到测试实例端口"退出码 1 —— 实例其实已在后台正常起来，
#    用下面的验证命令确认即可，不要重复启动。

# 停止
./dsh-test-instance-stop.sh --also-kill-proxy

# 验证
ss -tlnp | grep -E ':308[0-9] '          # 主 3080/3081、测试 308x、反代 3084
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3084/   # 应为 200
```

访问地址：

| 实例 | 地址 |
|---|---|
| 主实例 | http://10.10.10.121:3080 |
| 测试实例（反代） | http://10.10.10.121:3084 |

### 纯测试环境（无插件，基线）

不需要 whale-musume/test-sync 等本地插件、只要干净初始状态时用 `dsh-clean-env.sh`（生成 4 个 profile 文件即可，纯环境无需 node_modules，与主实例结构一致）。**完整说明、生成结构、坑位与脚本源码见 `dsh-clean-env` skill**：

```bash
cd /vol1/@appshare/DeepSeekHarness/workspace
./dsh-clean-env.sh start     # 自动生成(如缺) + 启动，打印端口；就绪后自检 HTTP 200
./dsh-clean-env.sh status    # 查看运行状态
./dsh-clean-env.sh stop      # 停止（按 .dsh-env-port 记录精准 kill）
./dsh-clean-env.sh create --force   # 目录已存在时重建（先停旧实例）
```

- 环境目录默认 `dsh-test-home-clean`（可用第二参数指定任意名字，多个纯环境并存）
- 启动用 `setsid`（抗沙箱回收）；端口取 3083-3182 第一个空闲，记录在 `.dsh-env-port`
- 反代 3084 指向 3083-3182 第一个被占端口：纯环境若占 3083，3084 即指向它（局域网可达）

## 四、node_modules 解析机制（核心坑，必读）

测试实例 profile：`dsh-test-home/profiles/web/`，通过 `cordis.patch.yml` 的 `insert` 加载本地插件，`package.json` 用 `file:` 依赖声明：

```yaml
# cordis.patch.yml（节选）
- id: test-sync
  name: '@deepseek-ai/dsh-test-sync'
- insert:
    - id: dsh-whale-musume
      name: dsh-whale-musume
```

```json
// package.json dependencies
"@deepseek-ai/dsh-test-sync": "file:../../../dsh-test-sync-plugin",
"dsh-whale-musume": "file:./node_modules_local/dsh-whale-musume"
```

**历史故障（2025-08-18 修复）**：`profiles/web/node_modules` 曾是 → 全局安装 `/vol1/@appcenter/deepseek-harness/node_modules` 的软链，`file:` 依赖从未被链接进去 → 测试实例启动即崩：

```
Error: dsh: plugin tree failed to load: Cannot find package 'dsh-whale-musume'
imported from .../dsh-test-home/profiles/web/  (ERR_MODULE_NOT_FOUND)
```

**当前修复方案**：`node_modules` 是工作区内的**真实目录**：
1. 镜像全局 node_modules 的全部条目（255 个，scoped 目录如 `@deepseek-ai` 建真实目录、包逐个软链）
2. 补本地插件链接：
   - `node_modules/dsh-whale-musume -> ../node_modules_local/dsh-whale-musume`
   - `node_modules/@deepseek-ai/dsh-test-sync -> ../../node_modules_local/@deepseek-ai/dsh-test-sync`

**维护规则（其他 AI 新增本地插件时必须遵守）**：
- 插件源码放 `node_modules_local/`（或 workspace 下的独立目录），并在 `profiles/web/node_modules/` 里补软链，否则测试实例起不来
- 插件依赖全局 node_modules 里都有：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-typert-protocol`、`chokidar` 4.0.3、`js-yaml` 4.3.1
- `dsh-whale-musume` 无运行时依赖
- 改动 cordis.patch.yml / package.json 后需重启测试实例

## 五、验证插件加载

```bash
# 首页 boot entries 应含插件
curl -s http://127.0.0.1:3083/ | grep -o 'whale[^"]*'

# 有 client bundle 的插件 → 200（scoped 包路径含 @ 符号）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3083/plugins/dsh-whale-musume/client.js       # 200
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3083/plugins/@dsh-external/dsh-client-ui-skin-maid-whale-webui/client.js  # 200

# 纯服务端插件（如 dsh-test-sync）没有 client.js，404 属正常，不要误判
```

## 六、已知坑与注意事项

1. **`dsh-test-start.sh` 4 秒超时误报**：实例启动 8-12 秒，脚本可能退出码 1，用 `ss`/`curl` 确认实际状态
2. **主实例 profile 是空的**：`~/.dsh/profiles/web/cordis.patch.yml` 为 `[]`，不加载任何本地插件；本地插件只属于测试实例
3. **配置同步方向**：`dsh-test-instance.sh` 只从主实例同步 cordis.yml / settings.yaml / pnpm-workspace.yaml；测试实例的 patch 和 package.json 是定制的，不会被覆盖
4. **测试实例日志**：直接跑 `bash dsh-test-instance.sh` 可看到完整启动日志（前台阻塞），后台跑时用 `job_output` 收
5. **端口占用**：测试实例找 3083-3182 第一个空闲端口；测试端口 +1 是反代端口（3084）
6. **settings.yaml**：测试实例的 provider 配置（llm-pi-ai 免费端点等）与主实例相同，测试时不烧主实例额度
7. **沙箱回收进程（实测）**：AI 会话的 bash 拉起的后台进程可能被执行环境在命令结束时回收——`nohup` 不保证存活（测试实例/反代都可能消失），`setsid bash dsh-test-instance.sh &` 更可靠。若 3084 返回 502 或 308x 无监听，说明实例已死：`setsid bash dsh-test-instance.sh > /tmp/dsh-test-instance.log 2>&1 < /dev/null &`，然后 `node dsh-test-proxy.sh &` 即可恢复

## 七、第三方插件安装流程（实测范例）

以安装 B站热门的**鲸鱼娘桌宠** + **鲸鱼女仆皮肤**为例（2025-08-18 实测通过）：

### 下载（GitHub zip，非 git clone）

```bash
cd /vol1/@appshare/DeepSeekHarness/workspace
# ⚠️ /tmp 跨命令被清，直接下载到 workspace；⚠️ 60s 超时被 kill，加 --max-time 120
curl -sL --max-time 120 https://github.com/Sutera-Diffusus/dsh-whale-musume/archive/refs/heads/main.zip -o dsh-whale-musume-main.zip
curl -sL --max-time 120 https://github.com/yunxiiQwQ/dsh-maid-whale-webUI/archive/refs/heads/main.zip -o dsh-maid-whale-main.zip
unzip -q dsh-whale-musume-main.zip
unzip -q dsh-maid-whale-main.zip
# ⚠️ maid-whale 插件在子目录 maid-whale-webui/，不是仓库根
```

### 安装到 node_modules_local（四要素缺一不可）

```bash
DSH_TEST_HOME="/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home"
PLUGIN_SRC="/vol1/@appshare/DeepSeekHarness/workspace/dsh-whale-musume-main"
PLUGIN_DIR="${DSH_TEST_HOME}/profiles/web/node_modules_local/dsh-whale-musume"

# 1. 复制核心文件
mkdir -p "${PLUGIN_DIR}"
cp -r "${PLUGIN_SRC}/lib" "${PLUGIN_SRC}/assets" "${PLUGIN_SRC}/package.json" "${PLUGIN_SRC}/cordis.patch.yml" "${PLUGIN_DIR}/"

# 2. package.json 加 file: 依赖
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('${DSH_TEST_HOME}/profiles/web/package.json'));
p.dependencies['dsh-whale-musume']='file:./node_modules_local/dsh-whale-musume';
fs.writeFileSync('${DSH_TEST_HOME}/profiles/web/package.json',JSON.stringify(p,null,2));
"

# 3. cordis.patch.yml 追加 insert
cat >> "${DSH_TEST_HOME}/profiles/web/cordis.patch.yml" << 'EOF'
- insert:
    - id: dsh-whale-musume
      name: dsh-whale-musume
EOF

# 4. 补 node_modules 软链（scoped 包需先 mkdir -p 父目录）
mkdir -p "${DSH_TEST_HOME}/profiles/web/node_modules/@dsh-external"
ln -sfn "${DSH_TEST_HOME}/profiles/web/node_modules_local/dsh-whale-musume" \
        "${DSH_TEST_HOME}/profiles/web/node_modules/dsh-whale-musume"
ln -sfn "${DSH_TEST_HOME}/profiles/web/node_modules_local/dsh-client-ui-skin-maid-whale-webui" \
        "${DSH_TEST_HOME}/profiles/web/node_modules/@dsh-external/dsh-client-ui-skin-maid-whale-webui"
```

### 验证加载

```bash
# __DSH_BOOT__ 中可见插件名
curl -s http://127.0.0.1:3083/ | grep -o 'whale[^"]*\|skin[^"]*'
# → whale-musume / whale-musume/client.js?rev=... / skin-maid-whale-webui / skin-maid-whale-webui/client.js?rev=...

# client.js 端点 → 200（scoped 包路径含 @ 符号）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3083/plugins/dsh-whale-musume/client.js                      # 200
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3083/plugins/@dsh-external/dsh-client-ui-skin-maid-whale-webui/client.js  # 200
```

### 当前已验证的第三方插件清单

| 插件 | 来源 | 类型 | 验证状态 |
|------|------|------|----------|
| dsh-whale-musume | Sutera-Diffusus/dsh-whale-musume | 桌宠（host+client） | ✅ 已加载，client.js 200 |
| dsh-client-ui-skin-maid-whale-webui | yunxiiQwQ/dsh-maid-whale-webUI（子目录） | 皮肤（client bundle） | ✅ 已加载，client.js 200 |
| @deepseek-ai/dsh-test-sync | 自研 | 纯服务端 | ✅ 已加载 |
| dsh-git-rescue | EIGHTfs/dsh-git-rescue | 纯服务端 | ✅ 已加载 |

## 八、当前状态快照（2025-08-18）

- 主实例 3080/3081 运行中
- 测试实例 3083 + 反代 3084 运行中
- 测试实例已加载：`dsh-whale-musume`（桌宠）、`dsh-client-ui-skin-maid-whale-webui`（鲸鱼女仆皮肤）、`dsh-test-sync`、`dsh-git-rescue` 等
- 访问 http://10.10.10.121:3084 可见鲸鱼娘桌宠 + 鲸鱼女仆主题皮肤
- 常用停启：`./dsh-test-instance-stop.sh --also-kill-proxy` / `./dsh-test-start.sh`
