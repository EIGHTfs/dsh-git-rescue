# 工作留痕：profile 还原点 zip（unzip 手动覆盖小功能）（2026-08-21）

## 任务背景
用户要求：「unzip 作为 git 救援的小功能，profile 变化提交 git 时打包，手动覆盖，压缩包文件名后缀标注什么插件导致的」。

历史脉络：旧快照恢复插件（undo 类）「备份变化的文件但作者水平不够，恢复没有全自动恢复还改了文件名都不方便手动覆盖恢复」。本版修正三件事：
1. **zip 内保留原始相对路径**（根目录 = .dsh）→ 手动 `unzip -o` 覆盖即恢复，不依赖 git
2. **提交 git 时自动打包**（commitAll 集成，随提交点留存）
3. **文件名后缀标注触发插件**（从 cordis.patch.yml 的 diff 推断；推断不到回退 config）

## 关键设计（实测确认）

### 1. 插件推断（inferPluginFromDiff）
- 依据：`git diff HEAD -- profiles/*/cordis.patch.yml` 的**新增行**（`+` 开头）
- 匹配顺序：`name: 'dsh-xxx'` → `id: xxx` → 块上方 `# dsh-xxx：…` 注释
- 过滤：仅接受 `dsh-` 前缀 / `@` 作用域 / 含 `/` 的包名（排除 web/main 等非插件 id）
- 实测样例：新增 `- insert: - id: test-plugin / name: dsh-test-plugin` → 推断 `dsh-test-plugin`

### 2. 变更收集（collectChangedProfileFiles）
- `git status --porcelain` 解析——**坑**：`runGit()` 会 `trim()` 输出，首行 ` M xxx` 的前导空格丢失，
  固定 `slice(3)` 会解析成 `rofiles/...`。改用正则 `^[ MADRCU?!]{1,2}\s+(.+)$` 稳健解析
- 白名单复用 `restoreProfileOnly` 的配置类路径（profiles/、settings.yaml、skills/、.anonymous-user-id、.gitignore），
  数据目录（sessions/storages/git-rescue）天然被 .gitignore 排除不入 diff

### 3. 文件名与存放
- 文件名：`profile-restore-<YYYYMMDD-HHmmss>-<插件|config>.zip`
- 存放：`.dsh/git-rescue/restore-points/`（`git-rescue/` 已在 .gitignore → zip 不入库、不占远端备份）
- zip 内：`manifest.json`（时间/原因/插件/文件清单）+ 变更文件（原始相对路径）
- 恢复：`unzipStore` → 逐文件写回 .dsh（跳过 manifest、拒绝绝对路径/`..` 穿越）

### 4. 集成
- `commitAll()`：提交前调用 `buildRestorePoint`，失败不阻断提交（git 仍是主通道）；返回 `out.restorePoint`
- API：`/api/git-rescue/restore-points`（GET 列表）/ `build` / `restore` / `remove`（POST，文件名白名单校验）
- Agent 工具：`git_rescue_restorepoints` / `git_rescue_restorepoint_build` / `git_rescue_restorepoint_restore`

## 测试
- T19 新增 24 断言：打包 ok / 文件名后缀标注插件 / 原始相对路径 / manifest / 手动覆盖恢复（含 manifest 不落盘）/
  列表+删除 / 仅配置变化回退 config / 无变更 empty / 非法文件名拒绝 / sanitize 清洗
- 全套 **122 通过 0 失败**（此前 99）

## 版本
2.4.0 → 2.5.0（新子功能 Z+1，遵循 versioning-rule：Z = 新增子功能数量，全新子功能计入）
