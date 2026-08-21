---
name: dsh-plugin-main-install
description: DSH 主环境（3081）插件安装/升级的完整规范：注册三要素（node_modules 放置 + package.json 依赖 + cordis.patch.yml insert）、接管式重启、部署后验证清单、以及全部已踩的坑（版本 1.x、zod Config、残留引用、selfPort、备份与纯净版检出等）。处理任何「往主环境装插件/升级插件/部署插件」任务时加载；与 dsh-test-env（测试实例先行）、dsh-restart-takeover（重启）、versioning-rule（版本）、release-docs-rule（文档）配套。
whenToUse: 需要把插件装到主实例（3081）、升级主环境插件版本、注册新插件到 profile、排查主环境插件加载失败（Cannot find package / schema validate 报错）、或部署任何 dsh-* 插件到生产环境时。
---

# DSH 主环境插件安装规范（dsh-plugin-main-install）

> 经验来源：2026-08-18 主环境安装 dsh-git-rescue（1.2.2→1.5.1→1.6.0 多次）+ 测试实例验证全链路。
> 核心原则：**测试实例先行（蓝绿）→ 主环境安装 → 接管式重启 → 验证清单**。安装到主环境是生产操作，每一步都要留痕可回退。

## 一、注册三要素（缺一不可）

DSH 插件加载靠三处注册，**全部**配置好才生效：

1. **插件包放置**：源码放入主实例 profile 的 `node_modules`
   - 主实例（真实目录）：`/vol1/@appshare/DeepSeekHarness/.dsh/profiles/web/node_modules/<pkg>/`
   - 测试实例（软链方式）：`node_modules_local/<pkg>/` + `node_modules/<pkg> -> ../node_modules_local/<pkg>` 软链
2. **package.json 依赖**：`/vol1/@appshare/DeepSeekHarness/.dsh/profiles/web/package.json`
   ```json
   "dependencies": { "<pkg>": "file:./node_modules/<pkg>" }
   ```
3. **cordis.patch.yml insert**：
   ```yaml
   - insert:
       - id: <plugin-id>
         name: '<pkg>'
   ```

## 二、完整流程（含安全步骤）

```bash
# 0) 备份当前配置（可回退）
TS=$(date +%Y%m%d-%H%M%S); mkdir -p /vol1/@appshare/DeepSeekHarness/workspace/.main-install-backup-$TS
cp .dsh/profiles/web/package.json .dsh/profiles/web/cordis.patch.yml /vol1/@appshare/DeepSeekHarness/workspace/.main-install-backup-$TS/

# 1) 从 git 检出【纯净发布版】（⚠️ 绝不用开发工作区，可能混入未完成代码）
git -C <repo> archive <tag/commit> <subdir> | tar -x -C /tmp/clean-pkg
# 核对：lib 文件清单、version 字段、无未完成模块（grep flapping/probe/TODO）

# 2) 放置插件包（真实目录或软链）+ 注册依赖 + patch insert（见三要素）

# 3) 语法检查（重启前必查，防白屏）
node --check node_modules/<pkg>/lib/index.js
node -e "const p=require('./node_modules/<pkg>/package.json'); console.log(p.version)"

# 4) 重启（必须接管式——直接 kill 会断会话且无法继续验证）
#    见 dsh-restart-takeover skill：独立脚本 TERM → 轮询恢复 → 验证 → 写日志

# 5) 验证清单（见第四节）
```

## 三、已踩的坑（全部实测，安装/排查时逐条对照）

| 坑 | 现象 | 解法 |
|----|------|------|
| **版本号 0.x** | 不合规范 | 一律 1.x（versioning-rule 硬规则：0.2.0→1.2.0） |
| **Config 用普通对象** | `Cannot read properties of undefined (reading 'validate')` | 必须 zod schema：`import { z } from 'zod'; export const Config = z.object({...})`（zod 用 DSH 全局 `/vol1/@appcenter/deepseek-harness/node_modules/zod`） |
| **残留引用** | `Cannot find package '<pkg>'`（加载器找不到被删插件） | 部署前 `grep -n '<旧插件名>' package.json cordis.patch.yml`，残留全清 + 删 node_modules(_local) 目录 |
| **内部回环端口写死 DSH_PORT** | 内部 fetch 连错（测试实例连到 3081） | 用 `selfPort()`：`process.env.DSH_PORT || process.env.TEST_DSH_PORT || 3081`（测试实例只设 TEST_DSH_PORT） |
| **工作区代码混入** | 装了未完成/开发中代码 | 一律 `git archive` 纯净版；核对 lib 清单与 version |
| **重启后不验证** | 插件没加载不知道 | 重启脚本内轮询 + sleep 8~15s 再 curl 插件 API |
| **测试实例配置被覆盖** | 清理的残留又回来 | dsh-test-sync 会同步官方 bundles 但不动 node_modules_local；确认无其他会话在改测试实例（ps 查 dsh-test-instance/cordis.patch 进程） |
| **主实例 .dsh 只读误判** | 以为装不了 | 主实例进程视角 /vol1 是 rw（沙箱 ro 是 Agent 视角）；沙箱放开后可直接写 |

## 四、验证清单（重启后必查）

1. `ps` 新 PID 出现、旧 PID 消失
2. `curl /` → 200；`curl /api/<plugin>/status` → ok:true
3. 心跳/状态文件更新（如 git-rescue 的 heartbeat pid 指向新进程）
4. 事件流出现 `startup` 事件
5. 插件 API 冒烟（如 `GET /api/git-rescue/log`）
6. 若插件自带 git 仓库：`/api/<plugin>/init` 初始化 + 基线 commit

## 五、配套约定

- **测试实例先行**：改动先装测试实例（dsh-test-env）验证通过，再上主环境
- **新功能必写 README**（release-docs-rule）；版本号 X.Y.Z 且 1 开头（versioning-rule）
- **主环境插件安装后**：从 git 推送的纯净版为准，别用开发工作区
- **接管式重启**：主环境重启一律走 dsh-restart-takeover（会断会话，脚本自持验证）

## 六、常见路径速查

| 路径 | 用途 |
|------|------|
| `/vol1/@appshare/DeepSeekHarness/.dsh/profiles/web/` | 主实例 profile（package.json / cordis.patch.yml / node_modules） |
| `/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home/profiles/web/` | 测试实例 profile（node_modules_local） |
| `/vol1/@appcenter/deepseek-harness/node_modules/zod` | DSH 全局 zod（插件 Config 用） |
| `/vol1/@appdata/deepseek-harness/deepseek-harness.log` | runner 日志（重启时间线/错误） |
| `/vol1/@appshare/DeepSeekHarness/workspace/.main-install-backup-*/` | 安装前配置备份（回退用） |
