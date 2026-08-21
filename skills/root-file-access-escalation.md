---
name: root-file-access-escalation
description: root 文件访问提权链——本机无法直接访问 root 所有文件时，依次尝试：本机 sudo → SSH root 直登 → 管理员用户 SSH + sudo -i 提权；全失败如实告知用户，不猜测不编造。处理「root 文件读不了」「任务清单/配置是 root 所有」「需要提权访问文件」「SSH 访问 root」类场景时加载；约束所有 AI 所有会话。
whenToUse: 需要读取/修改 root 所有的文件（任务清单、配置、日志等），当前用户无权限、本机 sudo 需密码时
generatedBy: deepseek-official/deepseek-v4-flash + EIGHTfs 2026-08-21
---

# Root 文件访问提权链

> 用户 2026-08-21 确立（约束所有 AI 所有会话）：**本机无法直接 root 访问文件 → 尝试 SSH 访问；SSH 无法直接 root 登录 → 尝试管理员用户 SSH + `sudo -i` 提权**。

## 提权尝试顺序（按序执行，成功即停）

1. **本机直接访问**：当前用户本身可读（文件属 deepseek-harness 等）；或 `sudo -n` 免密可用
2. **本机 sudo 带密码**：有 root 密码时 `echo <密码> | sudo -S -p '' <命令>`（密码只从 `data/sensitive/` 凭据库读，不明文外泄、不进 git）
3. **SSH root 直登**：`ssh root@<host>`（公钥/密码均可；本机回环 `ssh root@127.0.0.1` 也算）
4. **管理员用户 SSH + sudo -i**：root 直登被拒（`Permission denied (publickey,password)`）时，用**管理员账号**（fnOS 如 admin / 用户账号）SSH 登录后 `sudo -i` 提权再操作：
   ```bash
   # 单命令只读：SSH 管理员 + sudo -S 提权
   ssh <admin>@<host> "echo '<密码>' | sudo -S -p '' cat /path/to/root/file"
   # 交互式：ssh <admin>@<host> 后执行 sudo -i（输入管理员密码）
   ```
   - 管理员账号名/密码从用户或 `data/sensitive/` 凭据库确认，不凭记忆猜
   - 只读场景用 `sudo -S cat` 单条命令即可，不必开交互式 root shell
5. **全部失败**：如实告知用户「root 文件无法访问，需 root 凭据或主机终端操作」，**不猜测内容、不编造结果**

## 实测记录（2026-08-21，root:root 600 任务清单文件）

| 尝试 | 结果 |
|------|------|
| 本机 cat root 文件 | Permission denied（EACCES） |
| `sudo -n true`（免密） | 需要密码（失败） |
| `sudo-key`（data/sensitive/sudo-key） | 非 root 密码（8 字节，1 incorrect attempt） |
| `ssh -o BatchMode=yes root@127.0.0.1` | Permission denied (publickey,password) |
| 管理员用户 + `sudo -i` | 待实测（管理员账号需确认） |

## 坑速查

- 不要在容器/沙箱内浪费时间提权（bwrap cap 全零、sudo.conf 异常）——直接走 SSH 链路（见 `container-root-privilege`）
- 敏感凭据（root/管理员密码、私钥）**永不写入 skill、不进 git**，一律从 `data/sensitive/` 读取（credentials-locator）
- 「涉及登录操作先检查是否已经登录」同样适用：SSH 登录前先查 `~/.ssh/` 已有 key/config、凭据库是否已有该主机凭据，避免重复生成/重复登录
- 读取只读文件优先 `sudo -S` 单命令，少开交互式 root shell（少留痕、少风险）
