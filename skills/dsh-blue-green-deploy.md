# DSH 蓝绿部署同步方案

> ⚠️ **已被 `dsh-test-env` skill 取代**（2025-08-18）：本文档的"只读 node_modules / 依赖问题待解决"等限制已过时，node_modules 解析机制已修复。涉及测试环境时加载 `dsh-test-env`，信息冲突以 `dsh-test-env` 为准。
>
> 处理 DSH 双实例部署、插件同步、热开发测试场景时加载。

## 一、场景背景

DSH 插件开发时经常需要重启测试效果，但重启会导致当前会话中断。本方案通过启动第二个 DSH 实例（测试实例），实现：
- 主实例继续运行，不影响当前工作
- 测试实例独立运行，可随意重启/崩溃
- 插件变更可通过脚本同步到测试实例

## 二、部署环境

- **主实例**: 端口 3081，反代 3080，访问 http://10.10.10.121:3080
- **测试实例**: 端口 3083-3182 自动分配，反代自动找空闲端口
- **数据隔离**: 测试实例 DSH_HOME = `/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home`

## 三、生成的文件

| 文件 | 用途 |
|---|---|
| `dsh-test-instance.sh` | 测试实例启动脚本（自动找端口） |
| `dsh-test-proxy.sh` | 反代脚本（自动检测测试实例端口） |
| `dsh-test-start.sh` | 一键启动脚本 |
| `dsh-test-instance-stop.sh` | 停止脚本（`--also-kill-proxy` 同时停反代） |
| `dsh-sync-plugins.sh` | 插件同步脚本 |
| `find-free-port.sh` | 端口查找工具 |
| `dsh-test-sync-plugin/` | 插件源码（基础框架，依赖问题待解决） |
| `dsh-test-home/` | 测试实例独立数据目录 |

## 四、使用方法

```bash
# 启动
cd /vol1/@appshare/DeepSeekHarness/workspace && ./dsh-test-start.sh

# 停止
./dsh-test-instance-stop.sh --also-kill-proxy

# 同步插件
./dsh-sync-plugins.sh
```

## 五、访问地址

| 实例 | 地址 |
|---|---|
| 主实例 | http://10.10.10.121:3080 |
| 测试实例 | http://10.10.10.121:3084（反代） |

## 六、插件同步流程

由于 DSH 插件系统依赖链复杂且 `.dsh` 目录在只读文件系统上，采用以下方案：

1. 在测试实例的 `cordis.patch.yml` 中手动添加插件配置
2. 运行 `./dsh-sync-plugins.sh` 自动同步插件列表
3. 重启测试实例使变更生效

## 七、已知限制

1. **插件依赖问题**: 插件需要 `@deepseek-ai/cordis` 等依赖，但 node_modules 是只读 symlink
2. **只读文件系统**: `.dsh` 目录在 ZFS readonly 挂载点上，无法直接安装插件
3. **解决方案**: 使用外部同步脚本手动管理插件配置

## 八、后续优化方向

1. 将插件部署到可写目录（如 `/tmp` 或用户 home）
2. 实现真正的 cordis 插件，监听插件安装事件
3. 添加 Web UI 按钮触发同步
