#!/usr/bin/env bash
# messages adapter 审批/批准链路 canary（默认只读；生产写验证留 release 统一窗口人工执行）
#
# 目的：给 release 窗口用一条可复现命令，验证「真 worker 触发连接审批 → 批准后只执行一次 → 拒绝零写 → 客户端可见」。
# 但**默认绝不写生产库**：本脚本默认只做【只读】部分（读真实会话 canary + 打印 judgeCall 判定 + 列出 pending）。
# 真正写=需要显式 --write 且必须 --db 指向一个**临时/隔离** mobileq.db（脚本拒绝以生产库做写目标）。
#
# 用法（release 窗口）：
#   # 1) 只读体检（安全，可随时跑）：读真实库会话、打印读 allow/写 ask 的判定
#   ./messages-canary.sh
#   # 2) 隔离写链路演练（用临时库，不碰生产）：
#   ./messages-canary.sh --write --db /tmp/canary-$$/mobileq.db
#   # 3) 生产真写 = 不在本脚本自动做，release 时由人工在 app 里点批准/拒绝，仅用本脚本做前后只读比对
#
# 关联：backend/src/integrations/messages-mcp/{server.ts, messages-mcp}、backend/tools/mobileq
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"   # repo root
CLI="$ROOT/backend/tools/mobileq"
SERVER="$ROOT/backend/src/integrations/messages-mcp/server.ts"
PROD_DB="${MESSAGES_MCP_DB:-$HOME/.dsh/state/superagent/mobileq.db}"

WRITE=0; DB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write) WRITE=1; shift;;
    --db) DB="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

echo "== mobileq conversations (read-only, db=$PROD_DB) =="
python3 "$CLI" conversations --db "$PROD_DB"

echo "== judgeCall 判定（纯判定，不调用任何工具）=="
# 用 node 直接跑 connections.ts 的纯函数：read allow / write ask（readOnly 默认）
MESSAGES_MCP_DB="$PROD_DB" node --input-type=module -e '
import { allowedTools, connectionsOf, judgeCall } from "'"$ROOT"'/backend/src/app/connections.ts";
const cfg = connectionsOf({ readOnly: true, connections: [{ kind: "messages", server: "messages",
  readTools: ["list_channels","list_messages","get_message"], writeTools: ["send_message"] }] });
for (const t of ["list_channels","list_messages","get_message","send_message"])
  console.log(t, "=>", judgeCall(cfg, "messages", t).action);
console.log("candidate tools:", allowedTools(cfg).join(", "));
'

echo "== adapter 只读 self-check（读真实库会话，不写）=="
MESSAGES_MCP_DB="$PROD_DB" MESSAGES_MCP_CLI="$CLI" node "$SERVER" --self-check

if [ "$WRITE" -eq 1 ]; then
  if [ -z "$DB" ]; then echo "--write 必须配 --db <隔离临时库>" >&2; exit 2; fi
  # 安全闸：写目标不得等于生产库
  if [ "$(cd "$(dirname "$DB")" && pwd)/$(basename "$DB")" = "$(cd "$(dirname "$PROD_DB")" && pwd)/$(basename "$PROD_DB")" ]; then
    echo "拒绝：--write 不得以生产库为写目标" >&2; exit 3
  fi
  mkdir -p "$(dirname "$DB")"
  echo "== 隔离写链路演练（db=${DB}）=="
  python3 "$CLI" --db "$DB" inject --conversation main --sender canary --text "canary 入站" >/dev/null
  echo "before replies: $(python3 -c "import sqlite3;print(sqlite3.connect('$DB').execute('select count(*) from replies').fetchone()[0])")"
  # 模拟「批准一次」：真调 adapter send_message（本地 stdio），写一条到 replies
  printf '%s\n%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_message","arguments":{"channel":"main","to":"m1","text":"canary 回话","key":"canary-1"}}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_messages","arguments":{"channel":"main"}}}' \
  | MESSAGES_MCP_DB="$DB" MESSAGES_MCP_CLI="$CLI" node "$SERVER" | sed -n '2,3p'
  echo "after replies: $(python3 -c "import sqlite3;print(sqlite3.connect('$DB').execute('select count(*) from replies').fetchone()[0])")"
  echo "（演练结束：临时库 ${DB}，不碰生产）"
else
  echo "== 只读模式：未写任何东西。生产真写验证留 release 窗口人工点批准/拒绝，再用本脚本做前后只读比对。=="
fi
