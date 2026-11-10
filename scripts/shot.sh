#!/bin/sh
# 截一张 crew 窗口。窗口一直开着，这里只抓图。
#
# 用法：scripts/shot.sh [输出路径]
#
# 三条规矩：
#   1. 不抢前台 —— SCScreenshotManager.captureImage 按窗口 ID 单张抓
#   2. 不挪窗口、不重启进程 —— 窗口待在它该在的地方
#   3. 窗口被挡住也行，不必可见
#
# 进程没开时**不会自动去开**：开窗口是人的事，脚本只管抓。
set -e
OUT=${1:-/tmp/desktop-window.png}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# 进程名不写死：`go run .` 跑出来是临时二进制，名字每次都不一样，
# 编译到 /tmp 试版时又是一串别的名字。只要窗口标题对得上就够了，这件事交给
# shot-window.swift 按标题找窗口；这里只挡「一个 crew 都没起」这种明显的情况。
if ! pgrep -f 'crew-(desktop|new|old)' >/dev/null && ! pgrep -f "$(basename "$(pwd)")/desktop$" >/dev/null; then
  echo "没找到 crew 窗口进程。先手动开一个再截（本脚本不会替你开）。" >&2
  exit 1
fi

swift "$ROOT/scripts/shot-window.swift" "$OUT"
