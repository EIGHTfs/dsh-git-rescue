# 容器内 root 权限获取经验（2026-08-19）

## 问题
在 bwrap sandbox 容器中无法获取 root 权限执行部署任务。

## 实测
- sudo/su/pkexec 均失败（cap 全零 + sudo.conf 异常）
- /vol1/ 目录仅 root 可访问

## 正确做法
必须通过外部 SSH 以 root 执行：
\`\`\`bash
ssh root@10.10.10.4
# 或在 fnOS 终端直接 su - root
\`\`\`

## 防再犯
不要浪费时间尝试容器内提权，直接让用户在主机执行。
