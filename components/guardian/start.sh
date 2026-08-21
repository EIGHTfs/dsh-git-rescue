#!/bin/bash
# dsh-guardian 启动脚本
# 用法: ./start.sh [start|stop|restart|status]
cd "$(dirname "$0")"

PID_FILE="./guardian.pid"
LOG_FILE="./guardian.log"

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "dsh-guardian 已在运行 (PID $(cat "$PID_FILE"))"
    return 0
  fi
  nohup node server.js > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  echo "dsh-guardian 已启动 (PID $(cat "$PID_FILE"))，网页: http://127.0.0.1:${GUARDIAN_PORT:-3082}"
  echo "日志: $LOG_FILE"
}

stop() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    rm -f "$PID_FILE"
    echo "dsh-guardian 已停止"
  else
    echo "未找到 PID 文件，尝试按进程名停止"
    pkill -f "node server.js" 2>/dev/null && echo "已停止" || echo "未在运行"
  fi
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "dsh-guardian: 运行中 (PID $(cat "$PID_FILE"))"
    echo "网页: http://127.0.0.1:${GUARDIAN_PORT:-3082}"
  else
    echo "dsh-guardian: 未运行"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) status ;;
  *) echo "用法: $0 [start|stop|restart|status]"; exit 1 ;;
esac
