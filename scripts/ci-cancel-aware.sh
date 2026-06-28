#!/usr/bin/env bash
# CI 取消感知命令包装器。
# 用法: scripts/ci-cancel-aware.sh <command> [args...]
# GitHub 取消 job 时会向本进程发 SIGTERM；本脚本把信号转成对整个子进程组的
# TERM→(宽限)→KILL，避免 next-server / playwright 等子进程变孤儿继续占端口。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

CHILD_PID=""
GRACE_SECS="${CI_CANCEL_GRACE_SECS:-10}"

cleanup() {
  local sig="$1"
  [ -n "$CHILD_PID" ] || return 0
  # 子进程独占进程组时，向 -PGID 发信号可命中整棵树。
  kill -TERM "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
  for _ in $(seq 1 "$GRACE_SECS"); do
    kill -0 "$CHILD_PID" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL "-$CHILD_PID" 2>/dev/null || kill -KILL "$CHILD_PID" 2>/dev/null || true
}

trap 'cleanup TERM; exit 143' TERM
trap 'cleanup INT;  exit 130' INT

# setsid 让子命令成为新进程组组长，使 kill -PGID 能命中整棵进程树。
if command -v setsid >/dev/null 2>&1; then
  setsid "$@" &
else
  "$@" &
fi
CHILD_PID=$!

set +e
wait "$CHILD_PID"
STATUS=$?
set -e
exit "$STATUS"
