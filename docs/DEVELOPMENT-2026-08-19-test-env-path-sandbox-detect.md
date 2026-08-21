# DEVELOPMENT-2026-08-19-test-env-path-sandbox-detect

## 任务背景

用户指出「真正的测试环境是插件目录下的 dsh-test-home」，并明确两个改进要求：
1. **测试环境判断改用路径**：现有 `client.js` 用端口范围（3083-3182）判断是否测试环境——测试实例端口自动分配会漂移，残留实例（如 3089 /vol1/1000/DeepSeekHarness）也可能落在范围内，端口判断不可靠
2. **沙盒环境判断写入代码**：容器内 sudo 提权失败（NoNewPrivs/CapEff/sudo.conf 三重限制）此前只记录在 skill（container-root-privilege），需固化为代码供 status/guardian 决策

## 改动内容（v1.9.0 → v1.10.0）

| 文件 | 改动 |
|------|------|
| `components/git-rescue/lib/test-env-entry.js` | 新增 `isTestHomePath(dshHome)`：DSH_HOME 含 `dsh-test-(home\|rc7\|clean)` 前缀目录 → 测试环境；`status()` 返回新增 `self: { dshHome, isTest }` 暴露当前实例路径判定 |
| `components/git-rescue/lib/client.js` | `isTestEnv` 改为优先 `status.self.isTest`（宿主端路径判定），status 未加载时兜底端口范围；头部注释同步 |
| `components/git-rescue/lib/sandbox.js` | **新增模块**：`detectSandbox()` 纯读检测——NoNewPrivs / CapEff（/proc/self/status）、容器标志（/.dockerenv + cgroup + /proc/1/comm）、sudo 可行性（NoNewPrivs/CapEff/sudo.conf 属主三重判断）、只读挂载点（/proc/mounts） |
| `components/git-rescue/lib/index.js` | `collectStatus()` 返回新增 `sandbox: await detectSandbox()`；import 接入 |
| `components/git-rescue/package.json` | 1.9.0 → 1.10.0 |

## 沙盒判断逻辑（detectSandbox）

```
isSandbox   = cgroup 含 docker/containerd/kubepods/bwrap 等 || /.dockerenv 存在 || NoNewPrivs=1 || /proc/1/comm 非系统 init
noNewPrivs  = /proc/self/status NoNewPrivs == 1（内核禁提权，sudo/setuid 永久失效）
canSudo     = !noNewPrivs && CapEff 非全零 && /etc/sudo.conf 属主 uid 0（任一不满足 → false）
readOnlyMounts = /proc/mounts 挂载选项含 ro 的列表（前 10）
```

## 验证（实测）

- 四个文件 `node --check` 语法全通过 ✅
- `detectSandbox()` 当前宿主环境实测：`{isSandbox:false, noNewPrivs:false, capEff:全零, isRoot:false, canSudo:false, readOnlyMounts:[systemd ramfs...]}` ✅
  - 注：bash 工具跑在宿主（systemd//init.scope）；DSH 插件进程跑在 bwrap 沙盒（NoNewPrivs=1），插件环境会正确判出 `isSandbox:true`
- `isTestHomePath` 逻辑：主实例路径 `/vol1/@appshare/DeepSeekHarness/.dsh` → false；`workspace/dsh-test-home` → true；`dsh-test-rc7/main-data` → true ✅
- 主实例 node_modules 同步完成（备份 .bak-110），待重启后 `/api/git-rescue/status` 出现 `sandbox` 字段

## 遗留

- 主实例 3081 需重启加载新代码（`/api/git-rescue/status` 才有 sandbox 字段 + test-env status 才有 self）——按接管式重启流程
- 测试环境实例（dsh-test-home）启动后验证 `GET /api/dsh-test-env/status` 的 `self.isTest === true`
- 端口判断兜底保留（status 加载失败时仍有 fallback），后续可完全移除
