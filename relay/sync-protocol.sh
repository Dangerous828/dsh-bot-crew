#!/bin/sh
# 把宿主的协议层拷到中转。
#
# 两个进程（backend 与 relay）各自是一份部署单元：中转跑在 NAS 上，不和 backend 共用一个
# node_modules。让它们共享一个 workspace 包会带来「部署时要连带装 backend 的依赖」这种
# 更糟的耦合，所以这里就是一份拷贝 —— 而拷贝必然会漂移，所以：
#   - relay/tests/parity.spec.ts 逐字节比对这两份文件，不一致就让测试红；
#   - 改了 backend 那份之后跑一次本脚本，再跑两边测试。
#
# 用法：sh relay/sync-protocol.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE="$ROOT/backend/src/app/relay-protocol.ts"
TARGET="$ROOT/relay/src/relay-protocol.ts"

if [ ! -f "$SOURCE" ]; then
  echo "sync-protocol: 找不到 $SOURCE" >&2
  exit 1
fi
cp "$SOURCE" "$TARGET"
echo "sync-protocol: 已同步到 $TARGET"
