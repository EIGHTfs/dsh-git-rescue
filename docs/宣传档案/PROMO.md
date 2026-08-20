# 🛟 dsh-git-rescue 宣传素材

> 三版宣传语 + 简易说明，供插件商店、社区论坛、Discussions 发帖使用。

## 仓库

**https://github.com/EIGHTfs/dsh-git-rescue**

## 简易说明（"是不是只要提供 token 就行了"）

> **是。** 唯一的必填配置就是 GitHub token（用于远端备份推送）。本地 git 版本管理和崩溃自动回退开箱即用，token 不填也只是跳过远端备份，不影响救援功能。token 只存本地（权限 600），绝不写入任何提交。

## 一句话版（聊天/群里甩）

> DSH 备份救援插件 **dsh-git-rescue** 🛟 —— 把 `.dsh` 配置和会话纳入 git 版本管理，harness 崩溃自动回退、5 秒自愈，还能远端备份。**配置只填一个 GitHub token**，其他全自动。实测：故意把 DSH 搞崩也能自己爬起来。👉 https://github.com/EIGHTfs/dsh-git-rescue

## 卡片版（插件商店 / 论坛帖开头）

> **🛟 dsh-git-rescue —— DSH 的 git 版本管理 + 崩溃自动救援插件**
>
> 你的 DSH 配置和会话，从此有了 git 保险：
> - **自动版本管理**：`.dsh` 配置 + sessions 纳入 git，启动/定时/事件自动 commit，改坏了一键回退
> - **崩溃自动救援**：独立 guardian 进程探活，harness 挂了自动 git 回退 → 拉起 → 健康自检，**实测 5 秒自愈**
> - **远端备份**：push 到你的 GitHub 私有仓库，机器坏了也能找回
> - **配置就一步**：填一个 **GitHub token** 即可，其余开箱即用
> - **敢自证**：全部能力经过"故意破坏测试"（篡改配置/删文件/kill 进程/破坏启动文件），测试实例实测通过
>
> 👉 https://github.com/EIGHTfs/dsh-git-rescue

## 完整版（官方 Discussions 发帖稿）

> **🛟 分享一个 DSH 备份救援插件：dsh-git-rescue（git 版本管理 + 崩溃自动回退）**
>
> 用了 DSH 一阵子，改配置、装插件总担心改崩了白屏、会话丢了找不回。所以写了个插件：**把 `.dsh`（配置、profiles、sessions、skills）纳入 git 版本管理**，并配一个**独立守护进程**——DSH 崩了它照样活着，检测到崩溃就自动 git 回退到上一个好状态，再拉起 DSH 完成健康自检。
>
> **配置有多简单？——填一个 GitHub token 就够了。**
> - token 只用于 push 到你的**私有备份仓库**（按设备指纹自动命名，多台设备不冲突）
> - 本地版本管理 / 崩溃自动回退 **零配置**，装上就能用
> - 没有 token 也完全不影响本地功能，只是跳过远端备份
>
> **主要能力：**
> | 能力 | 说明 |
> |---|---|
> | 自动 commit | 启动/定时/事件触发，`chore(guard): <原因>` 规范留痕 |
> | 崩溃检测 | 心跳文件 + 启动自检，检出"上次异常退出"自动留证 commit |
> | guardian 救援 | 独立进程探活 → 坏点标记 → git 回退 → 拉起 → 自检（实测 5 秒自愈） |
> | 远端备份 | token 推送私有仓库，敏感文件（凭据/token）零泄漏 |
> | 故意破坏测试 | 5 类破坏场景全过：篡改配置/删文件/kill 进程/破坏启动配置 |
>
> 技术细节：git 环境自动检测（含 `git-remote-https` 缺失环境的 REST API 降级）、坏点标记防回退死循环、设备指纹命名备份仓。
>
> 👉 仓库（含完整 README 和实测记录）：https://github.com/EIGHTfs/dsh-git-rescue
>
> 欢迎试用反馈，一起把 DSH 的备份救援做完善 🙌

---

*宣传素材整理于 2026-08-18。实测数据来源：`docs/crash-records-test-env.md`（2 次崩溃检出 + 1 次 guardian 自动救援 5 秒自愈）。*
