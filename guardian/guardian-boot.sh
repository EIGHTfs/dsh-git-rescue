#!/bin/bash
# dsh-git-rescue guardian 开机自启脚本（③）
# 由 /etc/rc.local 调用（或 .dsh/rescue/rescue-start.sh）；幂等（已在运行则跳过）
# 守护 DSH 主环境：探活 3081，连续失败 3 次 → 专项工具 → git 回退 → 拉起 → 自检
# 2.0.0 起：启动命令在 .dsh 目录这一层（git 仓库根），见 lib/boot-startup.js
# 2026-08-20 修复：GUARDIAN_DIR 不再硬编码旧版 workspace 路径，改为从本脚本
#   位置推导（guardian/ 的上级 = 插件根），保证开机自启拉起当前安装的新代码。
LOG=/vol1/@appshare/DeepSeekHarness/.dsh/git-rescue/guardian-boot.log
GUARDIAN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 已运行则跳过
if pgrep -f "guardian/server.js" > /dev/null 2>&1; then
  echo "$(date +%T) guardian 已在运行，跳过" >> "$LOG"
  exit 0
fi

cd "$GUARDIAN_DIR" || exit 1
echo "$(date +%T) 启动 guardian（开机自启）" >> "$LOG"
DSH_PORT=3081 \
DSH_HOME=/vol1/@appshare/DeepSeekHarness/.dsh \
GUARDIAN_PORT=3082 \
GUARDIAN_INTERVAL_MS=10000 \
GUARDIAN_FAIL_THRESHOLD=3 \
setsid nohup node guardian/server.js >> "$LOG" 2>&1 < /dev/null &
sleep 3
pgrep -f "guardian/server.js" > /dev/null 2>&1 && echo "$(date +%T) ✅ guardian 已启动" >> "$LOG" || echo "$(date +%T) ❌ guardian 启动失败" >> "$LOG"
