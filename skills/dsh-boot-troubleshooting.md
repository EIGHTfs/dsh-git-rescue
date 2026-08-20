---
name: dsh-boot-troubleshooting
description: 【dsh-git-rescue 插件 skill（2026-08-20 从通用目录迁入）】DSH 启动失败/无限重启/白屏/插件加载失败的系统化排查与修复清单。覆盖「系统卷只读导致 s6 无限重启」「profiles/node_modules 软链冲突」「client 插件导出错误 invalid plugin」「CIFS/SMB 挂载不支持软链」「读历史会话日志定位报错（zstd 拼接帧）」等实测场景与对应修复。处理任何「DSH 起不来/重启失败/重启后进不去/无限重启/Failed to load plugins」时加载。
whenToUse: DSH 启动失败、无限重启、重启没报错但进不去、浏览器白屏、Read-only file system、exists and is not a symlink、invalid plugin、Failed to load plugins、需要读历史会话日志定位报错时。
---

# DSH 启动失败排查与修复（dsh-boot-troubleshooting）

> 经验来源：2026-08-19 原机（10.10.10.121）dsh-host-perf 插件事故 + 无限重启实战排查。
> 核心原则：**先系统、后引导、再插件**——"无限重启"大概率是系统盘只读，不是插件问题。

## 一、排查顺序（从下往上，别倒着查）

### 1. 系统层（最常见，却最容易漏）
```bash
mount | grep -E '/vol1|appdata'
df -h /vol1/@appdata/deepseek-harness
dmesg | tail -60          # 找 I/O error / EXT4-fs error / Remounting filesystem read-only
```
- 现象：`/var/apps/deepseek-harness/cmd/main` 写 `deepseek-harness.log` / `deepseek-harness.pid` 报 `Read-only file system` → fnOS 的 s6 守护进程判定启动失败 → 自动重拉 → **无限重启**。
- 修复：先备份/查盘（磁盘 I/O 错误或 RAID 降级时，`remount rw` 会被内核立刻再切回 ro），确认卷健康后再 `mount -o remount,rw /vol1`，最后启动 DSH。

### 2. 引导层（软链冲突）
- 现象：`dsh: .../profiles/node_modules/@deepseek-ai/dsh exists and is not a symlink`。
- 原因：旧环境用 pnpm 装出的**真实目录**树，新版 DSH 引导要求这里是**软链**（指向 app 安装目录的依赖闭包，当前正常实例是 ~229 软链 + 少量真实目录）。
- 修复：`mv profiles/node_modules profiles/node_modules.hoisted-bak-<date>`（可回退），重启让引导自建软链。

### 3. 插件层（导出/注册/依赖）
- `invalid plugin, expect function or object with an "apply" method, received object` → client 插件 `exports.apply/inject` 写在了 `window.__ModuleLoader__.load({factory})` **外面**，改到 factory 内部并 `return module.exports`。
- `Failed to load plugins`（浏览器白屏，dsh-client-web 的 boot 界面）→ 同上，是**客户端** cordis 加载失败，不是服务端。
- `Cannot find package xxx` → 残留引用或删插件没清干净，`grep -rn '<旧插件名>' package.json cordis.patch.yml` 清残留。

## 二、关键报错速查表

| 报错 | 层 | 根因 | 修复 |
|---|---|---|---|
| `Read-only file system`（写 log/pid 失败） | 系统 | /vol1 卷被切只读 | 本地查盘 + remount rw |
| `exists and is not a symlink` | 引导 | 旧 pnpm 真实目录冲突 | 改名 hoisted-bak |
| `ENOTSUP ... symlink`（CIFS/SMB 挂载） | 引导 | 挂载不支持软链 | 拷到本地盘再跑，别在挂载路径直接起 |
| `invalid plugin ... received object` | 插件 | client exports 在 factory 外 | 移进 factory 内 + return module.exports |
| `Failed to load plugins`（白屏） | 客户端 | 同上（客户端 cordis） | 同上 |
| `Cannot find package` | 依赖 | 残留引用/缺包 | grep 清残留 |

> ⚠️ **`.dsh` 权限 600/700 是正常设计，不是故障**（2026-08-21 用户确认）：dsh-git-rescue 代码级把 `.dsh` 目录设为 700、敏感/状态文件（heartbeat、plugin-registry.json、rescue-scores、config.json、token、admin-password 等）设为 600——仅 owner 可读写是安全要求。排查启动失败/权限问题时，看到 600/700 属预期，**不要当 bug 修**；真正异常是「应该 600 却变 644/777」或「owner 不是运行用户」。

## 二b、官方机制速查（源码实证，2026-08-21 通读官方包）

> 完整设计理解见开发者文档 `DSH官方设计理解-权限专题-20260821.md`。以下为排查直接可用的官方行为。

| 官方机制 | 源码行为 | 排查含义 |
|---|---|---|
| **软链回退** `healProfilesModuleFallback` | `$DSH_HOME/profiles/node_modules/` 一包一软链指向安装闭包；幂等（对就留/错就重建）；**真实目录直接抛 `exists and is not a symlink`**；Windows junction | 软链冲突 = 旧 hoisted 树残留 → 改名 `hoisted-bak-<ts>` 让引导自建；CIFS 不支持软链（ENOTSUP）→ 拷本地盘 |
| **配置写原子化重试** | tmp+rename 仅重试 EACCES/EBUSY/EPERM（10 次 50ms）；**EROFS 立即失败不重试** | 只读卷启动失败是**立即暴露**的（写配置那步就炸），日志看 EROFS/Read-only 即系统层 |
| **patch 损坏** | profile/home 的 `cordis.patch.yml` 解析失败、空文件、非数组 → **引导失败**；必须 `[]` 禁用层 | 手写坏 YAML patch 会导致启动失败（即使 DSH 有容错的场景是"合法 YAML 引用缺失插件"） |
| **workspace unit header** | `dsh-storage-json` parse 阶段 header 缺失/非本域 → `missing or foreign unit header` → loader `failed to apply loader entry workspace` → 启动失败 | 崩溃日志该错 = workspace.json 损坏；文件缺失时 bootstrap 可从会话持久层重建（删除自愈） |
| **credentials owner-only** | 读前校验 `(mode & 0o077) !== 0` → **抛错拒绝**（"run chmod 600"），不自动收紧 | 文件 644/777 时 DSH 拒绝启动（含 runner chmod -R 777 事故场景）→ chmod 600 修复 |
| **`$DSH_WORKSPACE` env 不存在** | workspace 根 = runner 内部变量 + storage-json 配置 root（非 env） | 插件/脚本别依赖 `$DSH_WORKSPACE`；本机约定值 `/vol1/@appshare/DeepSeekHarness/workspace` 需显式传 |
| **多进程无锁写** | storage 写入无跨进程锁 | 多实例同时写 workspace 有竞态；备份/恢复避开运行中实例写窗口 |

## 三、读历史会话日志定位报错（方法）

- 会话文件 `~/.dsh/sessions/--<编码路径>--/<session-id>/session.jsonl.zstd` 是**拼接的 zstd 帧**（append 日志）：`node:zlib` 的 `zstdDecompressSync` 只解第一帧（只有 header 一行）。
- 完整解压用 CLI：`zstd -dc <file>`（自动处理拼接帧）。
- 关键事件类型：`user/message`、`assistant/message`（正文在 `data.content[].text`）、`session/title`、`tool-result`（命令输出/报错）。
- 判断机器是否"起过来"：看 `.dsh/git-rescue/events.jsonl`（`startup` 事件）和 `heartbeat`——若长期没有新 `startup` 事件，说明进程卡在插件加载之前的引导阶段（往往是系统层问题）。

## 四、插件安装/重启的硬规则（配合其它 skill）

1. 带浏览器半边的插件，client 导出必须在 `__ModuleLoader__.load({factory})` 的 factory 内赋值并 `return module.exports`（对照 `dsh-session-manager/lib/client.js` 的正确写法）。
2. 安装三要素：node_modules 放置 + package.json 依赖 + cordis.patch.yml insert（见 `dsh-plugin-main-install`）。
3. 主环境重启一律接管式（setsid 脚本 → TERM runner → 轮询 → 验证 → 留痕），见 `dsh-restart-takeover`。
4. 装前 `node --check`，装后 curl 插件 API 验证；失败回滚，不许留半装状态。

## 五、本次事故复盘（2026-08-19）

- 现象链：装 dsh-host-perf → 重启失败（invalid plugin received object）→ 改两个文件 → "没报错进不去" → 手动启动也失败 → **无限重启**。
- 真凶（最后一层）：原机 `/vol1/@appdata/deepseek-harness` 被切只读，runner 写不进 log/pid → s6 无限重拉。
- 之前误判：只修了插件 client.js（必要但非致命）；真正卡启动的是**系统卷只读 + 旧 hoisted 树软链冲突**。
- 教训：**报"重启没报错但进不去 / 无限重启"，先查 `mount / df / dmesg`，再查插件**。

## 六、AGNES-LESSON 落地（2026-08-19 教训已进插件）

- **guardian 已增加「插件安装事故识别」（v1.7.1）**：救援时 diff 检查 `cordis.patch.yml / package.json / cordis.yml`，有变更即标注「🚨 疑似插件安装事故」，回退将恢复事故前插件配置。
- **主环境 guardian 已常驻**：3082 端口、10s 间隔、3 次阈值、探活 `/api/git-rescue/status`；开机自启脚本 `guardian/guardian-boot.sh`（经 /etc/rc.local，需 root 写入）。
- **验证过的救援闭环**：注入坏插件配置 → kill → guardian 检出 → 事故提示 → git 回退 → 拉起 → 救援成功（测试实例实测）。
- ⚠️ 未完成：/etc/rc.local 写入需 root（sudo 密码），开机自启待用户协助执行一次；执行后测试重启确认 guardian 自愈。

## 七、热重载后插件域 closed（2026-08-20 实测，插件开发必读）

### 现象
- 插件 API 全部报 `domain '<name>' is closed`（如 session-manager 的 `list / value-analysis / search` 一起挂），但 `group/list` 等不读域的 API 正常。
- 例：`{"ok":false,"error":{"code":"internal","message":"domain 'dsh_session_manager' is closed"}}`。

### 根因（插件热重载/HMR 生命周期 bug）
- 插件用**模块级缓存**保存 storageDomain 的 open promise（如 `let domainPromise = null; pluginDomain(ctx){ if (domainPromise===null) domainPromise = ctx.get("storageDomain").open(spec).then(d => { ctx.effect(() => () => d.close(), ...); return d; }) }`）。
- DSH 启用 HMR（patch `- id: hmr / disabled: false`）后插件会**热重载**：旧 apply 的 disposer 把域 close 了（close 是幂等终态，一关就永久 closed），但模块级 `domainPromise` 缓存还在 → 新 apply 复用已关闭的域 → 所有读写报 closed。

### 修复（三选一，推荐①）
1. **apply() 开头重置缓存**：`export async function apply(ctx, config={}) { domainPromise = null; ... }`（每次 apply 重新 open；apply 内部局部变量如 pushDomainPromise 天然重置无需处理）。
2. 域改为「按需 open 不缓存」：每次请求都 `ctx.get("storageDomain").open(spec)`（有 open 缓存则无副作用，但浪费）。
3. 禁用该插件域的 close disposer（不推荐，会泄漏域）。

### 判定顺序（遇到 closed 先查这个）
- 查插件是否启用了 HMR/是否经历过 reload（日志看插件是否二次 apply）；
- 查模块级 `domainPromise` 缓存是否有 apply 重置；
- 别先怀疑文件权限/属主（root 进程能读一切，常见误判——本次实测主进程 root 但照样 closed，真凶是缓存未重置）。

## 八、纯 host 插件报 client.js failed to load（2026-08-20 实测根因+修复）

### 现象
- 主实例启动正常（3081=200），host API 全通，但浏览器控制台报：
  `Failed to load plugins / failed to import loader entry xxx (dsh-git-rescue): client-modules: bundle script /plugins/dsh-git-rescue/client.js?rev=xxx failed to load`
- boot 的 `__DSH_BOOT__` 里有该插件 client 条目（`"url":"/plugins/<id>/client.js"`），但插件目录无 client.js → 404

### 根因（代码级证据）
- `dsh-client-modules` 遍历 loader entries（`for entry of loader.entries()`），对声明了 **`dsh.runtime: "host"`** 的插件**无差别生成 client 条目**（即使该插件没有 client 半边）
- 有 `runtime: "host"` → boot 生成 client 条目 → 无 client.js 文件 → 404 → "failed to load"
- 无 `runtime` 字段（如 dsh-git-push）→ 不生成 client 条目 → 无报错

### 修复（实测有效）
- **移除插件 package.json 的 `dsh.runtime: "host"` 字段**（纯 host 插件不需要显式声明，缺省即 host）
- 改两处：主环境运行版 `~/.dsh/profiles/web/node_modules/<pkg>/package.json` + 权威源 `workspace/<pkg>/components/*/package.json`
- 重启主实例 → boot 里该插件 client 条目消失 → 报错消除，host 功能无损

### 判定
- 报这个错 → 先看插件 package.json 有无 `dsh.runtime: "host"`；有 → 移除即可
- 纯 host 插件清单：dsh-git-rescue（1.13.0 前有 runtime:host）、dsh-host-perf 等——**所有纯 host 插件都不要写 runtime:host**（避免生成无意义的 client 条目）
