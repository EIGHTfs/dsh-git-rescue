#!/bin/bash
# dsh-git-rescue guardian 开机自启脚本
# 由 /etc/rc.local 调用；幂等（已在运行则跳过）
# 守护 DSH 主环境：探活 3081，连续失败 3 次 → git 回退 → 拉起 → 自检
LOG=/vol1/@appshare/DeepSeekHarness/.dsh/git-rescue/guardian-boot.log
GUARDIAN_DIR=/vol1/@appshare/DeepSeekHarness/workspace/dsh-git-rescue/components/git-rescue

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
