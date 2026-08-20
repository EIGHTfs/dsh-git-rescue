# 工作留痕：容器内 root 权限获取尝试（2026-08-19）

## 任务背景
用户要求在 fnOS 主机（/vol1/1000/DeepSeekHarness）重新部署 rc.7 纯净环境。需要 root 权限执行。

## 关键发现（实测）
1. 容器 cap 全零：`CapEff: 0000000000000000`
2. sudo 失败：`/etc/sudo.conf` 属主 uid 65534（非 root）
3. su setuid：存在但密码认证失败
4. pkexec：未正确配置（"must be setuid root"）
5. /vol1/ 目录仅 root 可访问（`d---------`）

## 结论
容器内无法提权，必须通过外部 SSH 以 root 执行。

## 交付物
- 部署命令清单（已输出给用户）
- 经验 skill：`skills/container-root-privilege.md`

## 后续
用户选择 B 方案（SSH 执行），待用户在 fnOS 终端执行部署命令。
