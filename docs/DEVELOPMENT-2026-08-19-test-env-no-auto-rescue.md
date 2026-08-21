# DEVELOPMENT-2026-08-19-test-env-no-auto-rescue

## 任务背景

测试环境（3083 / `dsh-test-home`）是插件编写/验证的沙盒，崩溃是预期内的开发事件。
此前 guardian 对主/测试环境一视同仁自动 git 回退，已发生 4 次自动救援，其中一次回退掉了
开发者刚改的 `cordis.patch.yml`（日志：`🚨 疑似插件安装事故：cordis.patch.yml 在本次崩溃前有变更`）。
约定：**测试环境不自动救援，插件编写导致的崩溃由开发者自行解决**；
同时救援前应检测**进行中活跃对话**——存在则不重启（避免打断会话），落盘重启申请。

## 交付内容（v1.11.0 功能11）

| 文件 | 改动 |
|------|------|
| `components/git-rescue/lib/test-home.js` | **新增**：`isTestHomePath` 单一真源（guardian 与插件共用；正则匹配 `dsh-test-(home|rc7|clean)` 含 `-` 变体，修复 v1.10.0 不认 `dsh-test-home-clean` 纯净环境的缺陷） |
| `components/git-rescue/lib/test-env-entry.js` | 删除本地 `isTestHomePath` 定义，改 import 公共模块 |
| `components/git-rescue/guardian/server.js` | ①测试环境检测 → 自动救援禁用（保留现场+事件+冷却，返回 `blocked:'test-env-no-rescue'`）②活跃对话检测（session-manager API 口径 running\|\|continueRunning；未装降级 zstdcat 事件流扫描仅 running；DSH down 视为无活跃）→ 拦截并落盘 `restart-request.json` ③手动 recover 前记录 10 分钟变动文件 → `pre-restart-changes-<ts>.json` ④新 API：`/api/recover-auto`、`DELETE /api/restart-request`；status 暴露 `testHome`/`restartRequest` |
| `components/git-rescue/guardian/public/{index.html,app.js,style.css}` | UI 显示测试环境模式标识 + 待处理重启申请横幅 |
| `components/git-rescue/package.json` | 1.10.0 → 1.11.0 |
| `README.md` / `components/git-rescue/README.md` / `skills/dsh-git-rescue.md` | 功能总览 + 版本记录 + guardian 机制说明 |

## 关键发现（实测）

1. **活跃对话判定口径**：装了 session-manager 用 `running || continueRunning`；未装降级扫事件流
   （`zstdcat` 读尾部，从后向前找 `turn/start` 未 `turn/end` = running）。DSH down（API 不可达）→ 视为无活跃。
2. **测试环境判定缺陷**：v1.10.0 正则 `dsh-test-(home|rc7|clean)(/|$)` 不命中 `dsh-test-home-clean`
   （纯净环境目录名）——修复为 `([\/-]|$)`。
3. ⚠️ **guardian git 上溯事故（本次最大坑）**：验证时把 guardian 的 `DSH_HOME` 指向了
   dsh-git-rescue 仓库子目录 `.verify-tmp/verify-home`（非独立 git 仓库），recover 的
   `git reset --hard` 沿目录树**上溯到 dsh-git-rescue 的 `.git`**，把整个仓库回退到上一提交，
   **抹掉了本次全部编辑**（reflog 可见 `reset: moving to 99bcfb3` + `crash-recovery` commit）。
   教训：**guardian 验证必须用独立 git 仓库**（自带 `.git` 拦截上溯）；这也反向实证了
   「测试/开发目录绝不能自动 git 回退」的必要性。

## 验证（实测通过）

- `isTestHomePath` 单测 9 例全过（含 `dsh-test-home-clean` 修复项）
- `node --check` 全部改动文件通过
- 端到端（独立 git 仓库 verify-home + 假 DSH server）：
  - 测试环境 recover → `{testEnv:true, blocked:'test-env-no-rescue'}`，启动日志标注 `[测试环境：自动救援已禁用]` ✅
  - 活跃会话（running + continueRunning ×2）→ recover 返回 `blocked:'active-conversation'`，
    `restart-request.json` 落盘（count:2, status:pending, detail 含会话标题）✅
  - 无活跃会话手动 recover → 先记 `pre-restart-changes-*.json`（捕获 10 分钟内变动文件含未提交 `plugin-dev.txt`）→ 再执行 git 回退 `84223ad` ✅
  - verify-home 独立仓库在救援后未被污染（无 crash-recovery commit，未提交改动保留）；`git-rescue/` 在 `.gitignore` 时记录文件不被 reset 清掉 ✅

## 后续可做

- `restart-request.json` 的自动处理：对话结束后由 session-manager 联动自动放行重启（当前仅人工 + `DELETE /api/restart-request`）
- 测试环境「开发者自行解决」的辅助工具：检测到测试环境崩溃时，主动提示 `git_rescue_rollback` 用法
- guardian 增加独立 git 仓库自检（`git rev-parse --show-toplevel` 校验 DSH_HOME 未被包在更大仓库内）
