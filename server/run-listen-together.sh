#!/usr/bin/env bash
# 一起听 WebSocket 后端 - 常驻自重启守护脚本
# 用法：bash server/run-listen-together.sh
# 功能：
#   - 后台启动 listen-together.cjs
#   - 进程异常退出时自动重启（指数退避，最多 30s）
#   - 启动失败计数超过阈值时退避等待
#   - 日志写到 logs/listen-together.daemon.log

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/listen-together.daemon.log"
PID_FILE="$LOG_DIR/listen-together.pid"
STOP_FLAG="$LOG_DIR/listen-together.stop"

mkdir -p "$LOG_DIR"

# 如果已有运行中的实例，先不重复启动
if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[$(date -Iseconds)] Already running with pid=$old_pid" >> "$LOG_FILE"
    exit 0
  fi
fi

# 写当前 daemon 进程 PID
echo $$ > "$PID_FILE"

log() {
  echo "[$(date -Iseconds)] [daemon] $*" >> "$LOG_FILE"
}

log "Starting listen-together daemon"

fail_count=0
max_backoff=30

while true; do
  # 检查停止信号
  if [ -f "$STOP_FLAG" ]; then
    log "Stop flag detected, exiting"
    rm -f "$STOP_FLAG"
    rm -f "$PID_FILE"
    exit 0
  fi

  start_time=$(date +%s)
  log "Starting server (fail_count=$fail_count)..."

  # 启动后端服务，输出重定向到日志
  node server/listen-together.cjs >> "$LOG_FILE" 2>&1
  exit_code=$?

  end_time=$(date +%s)
  run_duration=$((end_time - start_time))

  # 判断是不是正常退出
  if [ -f "$STOP_FLAG" ]; then
    log "Server stopped by stop flag"
    rm -f "$STOP_FLAG"
    rm -f "$PID_FILE"
    exit 0
  fi

  fail_count=$((fail_count + 1))

  # 如果运行时间 > 60s，认为是稳定运行后崩溃，重置失败计数
  if [ "$run_duration" -gt 60 ]; then
    fail_count=1
  fi

  # 计算退避时间（指数退避，有上限）
  backoff=$(( 1 * (2 ** (fail_count - 1)) ))
  if [ "$backoff" -gt "$max_backoff" ]; then
    backoff=$max_backoff
  fi

  log "Server exited with code=$exit_code, ran=${run_duration}s, restarting in ${backoff}s (fail_count=$fail_count)"

  sleep "$backoff"
done
