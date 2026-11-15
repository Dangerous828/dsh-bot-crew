#!/bin/sh
# Run the real-agent → real-tool-dispatch E2E for worker isolation (#22 / task-6).
# Uses the installed DSH app bundle for real service classes and this repo's built lib for the
# Worker* modules (must run `node_modules/.bin/tsdown` first). Canaries live in a temp HOME.
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)          # backend/
DSH_NODE_MODULES=${DSH_NODE_MODULES:-/Applications/DeepSeek\ Harness.app/Contents/Resources/app/dsh/node_modules}
WBFS_BUILD=${WBFS_BUILD:-$REPO/lib}
[ -f "$WBFS_BUILD/worker-fs.js" ] || { echo "build first: (cd backend && node_modules/.bin/tsdown)" >&2; exit 2; }
DSH_NODE_MODULES="$DSH_NODE_MODULES" WBFS_BUILD="$WBFS_BUILD" \
  node "$REPO/tests/worker-runtime/real-agent-tool-dispatch.e2e.mjs"
