---
name: dsh-repo-index
description: 本机所有 DSH 插件/项目的 GitHub 源码索引（统一维护，唯一权威）：每个项目的中文名、仓库地址、可见性（公开/私有）、恢复命令、对应 skill。任何 AI 在任何会话遇到「插件文件丢失/本地副本损坏/需要重新拉取源码/确认某项目仓库地址」时加载；其他 skill 如需写源码位置一律引用本索引，不要各自复制仓库地址。
whenToUse: 需要恢复/克隆某个 dsh-* 插件源码、确认某项目在 GitHub 的仓库地址与可见性、本地插件目录丢失或损坏需要重建、写文档/skill 需要引用源码位置时。
---

# DSH 插件/项目源码索引（dsh-repo-index）

> 本索引是**唯一权威**：所有 dsh-* 插件/项目的源码位置都在这里。
> 其他 skill / README 如需写源码位置，一律写「见 dsh-repo-index」，**不要各自复制仓库地址**（副本会失同步，已踩坑）。
>
> ⚙️ 本索引由 **dsh-git-push 插件**（v1.3.0+）在推送成功后自动维护生成：仓库清单来自 git remote，
> 「对应 skill」列来自各项目 package.json dsh.skills + skills/*.md，可见性来自 GitHub API（token）。
> 权威源在 dsh-git-push 仓库 `skills/dsh-repo-index.md`，本文件为同步副本，**请勿手改**。

## 一、GitHub 仓库清单（EIGHTfs 账号下）

| 项目 | 仓库地址 | 可见性 | 恢复命令 | 对应 skill |
|------|----------|--------|----------|-----------|
| ai-work-archive | `git@github.com:EIGHTfs/ai-work-archive.git` | 私有 | git clone https://<token>@github.com/EIGHTfs/ai-work-archive.git | ai-collaboration / analyze-then-confirm / ask-with-options / bilibili-dynamic-publish / bilibili-promo / credentials-locator / dsh-backup-restore / dsh-custom-provider / dsh-plugin-dev / dsh-plugin-main-install / dsh-restart-gate / gbmd-project / git-collab-conflict / git-commits-viewer / github-pin-repos / host-address-convention / peak-hour-economy / peak-hour-pause / plugin-dev-log-rule / plugin-priority / project-skill-distill / push-channel-facts / readme-craft / session-content-search / skill-classification / skill-forge / skill-repo-sync / skill-source-rule / task-completion-report / todo-ask-confirm / token-create-approval / user-confirmation-style / user-shorthand-dict / verify-before-diagnose / versioning-rule / video-craft |
| DeepSeekHarness-NAS | `git@github.com:EIGHTfs/DeepSeekHarness-NAS.git` | 公开 | git clone git@github.com:EIGHTfs/DeepSeekHarness-NAS.git | — |
| dsh-bili-publisher | `git@github.com:EIGHTfs/dsh-bili-publisher.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-bili-publisher.git | dsh-bili-publisher |
| dsh-git-push | `git@github.com:EIGHTfs/dsh-git-push.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-git-push.git | dsh-git-push / dsh-repo-index |
| dsh-git-rescue | `git@github.com:EIGHTfs/dsh-git-rescue.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-git-rescue.git | dsh-blue-green-deploy / dsh-clean-env / dsh-deployment-overview / dsh-git-rescue / dsh-test-env / verify-before-diagnose |
| dsh-host-perf | `（无 remote）` | 未知 | — | — |
| dsh-image-preview | `git@github.com:EIGHTfs/dsh-image-preview.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-image-preview.git | dsh-image-preview |
| dsh-link-bridge | `git@github.com:EIGHTfs/dsh-link-bridge.git` | 私有 | git clone https://<token>@github.com/EIGHTfs/dsh-link-bridge.git | dsh-link-bridge |
| dsh-session-manager | `git@github.com:EIGHTfs/dsh-session-manager.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-session-manager.git | session-workspace-groups / session-archive-restorable / session-delete-self / peak-hour-economy / peak-hour-pause / analyze-then-confirm / verify-before-diagnose / skill-source-rule / push-channel-facts / token-create-approval / credentials-locator / todo-ask-confirm / plugin-dev-log-rule / ask-with-options |
| dsh-task-completion | `git@github.com:EIGHTfs/dsh-task-completion.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-task-completion.git | dsh-task-completion |
| dsh-test-home | `（无 remote）` | 未知 | — | — |
| dsh-test-sync-plugin | `git@github.com:EIGHTfs/dsh-test-sync-plugin.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-test-sync-plugin.git | — |
| gamebanana-mods-downloader | `git@github.com:EIGHTfs/gamebanana-mods-downloader.git` | 公开 | git clone git@github.com:EIGHTfs/gamebanana-mods-downloader.git | gbmd-gamebanana-api |
| dsh-workflow-audit | `git@github.com:EIGHTfs/dsh-workflow-audit.git` | 公开 | git clone git@github.com:EIGHTfs/dsh-workflow-audit.git | dsh-workflow-audit |
| git-commits-viewer | `git@github.com:EIGHTfs/git-commits-viewer.git` | 私有 | git clone https://<token>@github.com/EIGHTfs/git-commits-viewer.git | — |
| workspace | `（无 remote）` | 未知 | — | — |

> 命名模式：除特例外全部是 `git@github.com:EIGHTfs/<项目名>.git`（公开）或 `https://<token>@github.com/EIGHTfs/<项目名>.git`（私有）。
> 私有仓库 clone 需 GitHub token（本机 token 位于 `~/.dsh/git-rescue/token` 或 `dsh-test-home/git-rescue/token`）。

## 二、无 GitHub 仓库的项目（本地 only）

以下 workspace 目录**没有** git remote（未推送 GitHub），本地删除即不可恢复，注意备份：

`dsh-ai-work-archive`、`dsh-data`、`dsh-header-layout`、`dsh-header-layout-extension`、`dsh-maid-whale-webUI-main`、`dsh-model-router-v2`、`dsh-shift-router-src`、`dsh-skill-hub`、`dsh-sm-test`、`dsh-test-home-clean`、`dsh-whale-musume-main`

> ⚠️ 其中部分插件实际安装在主实例/测试实例的 node_modules（如 dsh-whale-musume 在 node_modules_local），
> 目录文件丢失时**先看 node_modules 里的部署副本**，GitHub 没有就找部署副本或本地备份。

## 三、恢复流程（插件文件丢失时）

```bash
# 1) 查本索引确认仓库地址与可见性
# 2) 公开库：
git clone git@github.com:EIGHTfs/<项目名>.git
# 3) 私有库（dsh-link-bridge 等）：
TOKEN=$(cat ~/.dsh/git-rescue/token 2>/dev/null | tr -d ' \n')
git clone https://${TOKEN}@github.com/EIGHTfs/<项目名>.git
# 4) 恢复后按 dsh-plugin-main-install 三要素装回主环境（测试实例先行 + 接管式重启）
```

## 四、维护约定

- **权威源**：dsh-git-push 仓库 `skills/dsh-repo-index.md`（唯一手改/生成入口），本 .dsh/skills 副本由插件同步
- **自动维护**：git_commit_push 推送成功后插件自动重新生成（新增/改名/删除仓库、skill 变化、可见性变化都会反映）
- **手工标注**：GitHub API 查不到的仓库可见性（无 token/网络失败/非 GitHub remote）保留手工标注或标「未知」
- **skill 引用**：其他 skill 写源码位置一律「见 dsh-repo-index」，不复制地址（防副本失同步）
- **验证可见性**：改可见性后（公开↔私有）推送任意仓库即自动刷新

<!-- auto-generated by dsh-git-push: DO NOT EDIT MANUALLY -->
