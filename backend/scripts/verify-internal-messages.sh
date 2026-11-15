#!/usr/bin/env bash
# verify-internal-messages.sh —— 内部消息 MCP 的**机械验收**（task-11）。
#
# 目的：把「live 写验收必须 ticket-bound 且指隔离 DB」变成可复跑、可核对的机械流程，
# 杜绝 release §7 的事故（顶层 headless 会话无 ticket、guard 未介入、canary 误写进真库）。
#
# 本脚本做四件**机械可核**的事：
#   1) 造一个**本任务独占**的临时 canary mobileq.db（不是生产库副本、不同 dev/inode）；
#   2) 用真实 `dsh --profile superagent --dump-config --patch <overlay>` 解析出**最终 resolved 的
#      MESSAGES_MCP_DB 值**（宿主会注入给 MCP 子进程的真实值），realpath 后断言 == canary 且
#      dev/inode 与生产库**不同**——证明写落隔离 DB、不是生产；
#   3) 跑 ticket-bound 真审批验收 spec（真 Runtime + 真 ticket + 真 guardConnection + 真 adapter 子进程，
#      store=canary）：读放行 / 写未批准 DB 零新增 / 批准同一次 +1 / 再调重问 +0 / 拒后 +0；
#   4) 前后对生产库做**只读计数**，断言生产 replies/messages 计数一字不变（生产未被触碰）。
#
# 本脚本**不**重启生产、不写生产、不写运行 App bundle、不读凭据值（figma token 等一概不打印）。
#
# 退出码：0 全绿；非 0 任一机械断言失败。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/.." && pwd)"
PROD_DB="${PROD_DB:-$HOME/.dsh/state/superagent/mobileq.db}"
CLI_BIN="${DSH_CLI:-$(command -v dsh || echo /Users/cpuser/.nvm/versions/node/v24.11.1/bin/dsh)}"
MESSAGES_MCP_ENTRY="$BACKEND/src/integrations/messages-mcp/messages-mcp"
MOBILEQ_CLI="$BACKEND/tools/mobileq"
fail() { echo "✗ FAIL: $*" >&2; exit 1; }
ok()   { echo "✓ $*"; }

echo "== 0. 前置 =="
[ -x "$MOBILEQ_CLI" ] || fail "mobileq CLI 不可执行: $MOBILEQ_CLI"
[ -f "$CLI_BIN" ] || command -v "$CLI_BIN" >/dev/null || fail "找不到 dsh CLI: $CLI_BIN"

# 只读统计函数（python3 单连接同 snapshot 读全三值，只读，绝无写）。
# 严格：文件不存在 / 只读连接失败 / 表缺失 / SQL 错 → 直接非 0 退出（绝不把错库/缺表静默当空库）。
ro_counts() { # $1 = db path ; prints "replies messages maxreply"
  python3 - "$1" <<'PY'
import sqlite3, sys, os
p = sys.argv[1]
if not os.path.isfile(p):
    sys.stderr.write('ro_counts: DB file not found: %s (refuse to treat as empty)\n' % p); sys.exit(3)
try:
    c = sqlite3.connect('file:%s?mode=ro' % p, uri=True)
except sqlite3.Error as e:
    sys.stderr.write('ro_counts: cannot open %s read-only: %s\n' % (p, e)); sys.exit(3)
try:
    # One read transaction -> one consistent snapshot of all three values.
    c.execute('BEGIN')
    r = c.execute('SELECT count(*) FROM replies').fetchone()[0]
    m = c.execute('SELECT count(*) FROM messages').fetchone()[0]
    mx = c.execute('SELECT COALESCE(max(id),0) FROM replies').fetchone()[0]
    c.execute('COMMIT')
except sqlite3.Error as e:
    # Missing table / corrupt / wrong DB must surface, never be masked as a legit empty DB.
    sys.stderr.write('ro_counts: schema/SQL error on %s: %s (refuse to mask)\n' % (p, e)); sys.exit(3)
print(r, m, mx)
PY
}
file_id() { stat -f '%d:%i' "$1"; }  # dev:inode on macOS

echo "== 1. 造独占临时 canary DB =="
CANARY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/internal-msg-verify.XXXXXX")"
CANARY_DB="$CANARY_DIR/canary-mobileq.db"
trap 'rm -rf "$CANARY_DIR"' EXIT
# mobileq 首次连接会建表结构；再注入一条真实入站消息作为父消息。
python3 "$MOBILEQ_CLI" --db "$CANARY_DB" inject --conversation main --sender owner --text 'verify: 预热父消息' >/dev/null
PARENT="$(python3 -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print(c.execute('SELECT max(id) FROM messages').fetchone()[0])" "$CANARY_DB")"
[ -n "$PARENT" ] || fail "canary DB 未成功建出父消息"
echo "canary DB: $CANARY_DB (parent m$PARENT)"
ok "canary 独占目录 $CANARY_DIR"

echo "== 2. 解析最终 resolved MCP env → 核 DB 是本任务独占 canary 且 dev/inode 异于生产 =="
CANARY_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$CANARY_DB")"
OVERLAY="$(mktemp "${TMPDIR:-/tmp}/mcp-verify-overlay.XXXXXX.yml")"; cp /dev/null "$OVERLAY"
trap 'rm -rf "$CANARY_DIR"; rm -f "$OVERLAY"' EXIT
cat > "$OVERLAY" <<YAML
- insert:
    - id: mcp-messages-verify
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: messages
        command: $MESSAGES_MCP_ENTRY
        args: []
        env:
          MESSAGES_MCP_DB: $CANARY_DB
          MESSAGES_MCP_CLI: $MOBILEQ_CLI
        toolCallTimeoutMs: 60000
YAML
DUMP="$("$CLI_BIN" --profile superagent --dump-config --patch "$OVERLAY" 2>/dev/null)"
[ -n "$DUMP" ] || fail "dsh --dump-config 无输出"
DUMP_FILE="$CANARY_DIR/dump.yml"; printf '%s\n' "$DUMP" > "$DUMP_FILE"
# 从 dump 里只取 mcp-messages-verify 段的 MESSAGES_MCP_DB（YAML folded >- 展开为单值）。
RESOLVED_DB="$(python3 - "$DUMP_FILE" <<'PY'
import sys, re
text = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'- id: mcp-messages-verify\b(.*?)(?=\n- id: |\Z)', text, re.S)
if not m:
    print(''); sys.exit(0)
blk = m.group(1)
mm = re.search(r'MESSAGES_MCP_DB:\s*>-?\s*\n\s*(\S+)', blk) or re.search(r'MESSAGES_MCP_DB:\s*(\S+)', blk)
print(mm.group(1) if mm else '')
PY
)"
[ -n "$RESOLVED_DB" ] || fail "dump 里没解析到 mcp-messages-verify 的 MESSAGES_MCP_DB"
RESOLVED_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$RESOLVED_DB")"
echo "resolved MESSAGES_MCP_DB = $RESOLVED_DB"
echo "  realpath               = $RESOLVED_REAL"
[ "$RESOLVED_REAL" = "$CANARY_REAL" ] || fail "resolved DB realpath ($RESOLVED_REAL) != canary ($CANARY_REAL) — 写不会落隔离库"
ok "resolved DB realpath 命中本任务独占 canary"

PROD_ID="$(file_id "$PROD_DB")"; CANARY_ID="$(file_id "$CANARY_DB")"
echo "prod dev:inode=$PROD_ID  canary dev:inode=$CANARY_ID"
[ "$PROD_ID" != "$CANARY_ID" ] || fail "canary dev/inode 与生产相同——不是独立文件"
ok "canary dev/inode 与生产库不同（独立文件，非生产副本）"

echo "== 3. 生产库前后只读快照（证明全程未被触碰）=="
SNAP_P_B=$(ro_counts "$PROD_DB"); P_REP_B=$(echo "$SNAP_P_B" | awk '{print $1}'); P_MSG_B=$(echo "$SNAP_P_B" | awk '{print $2}'); P_MAX_B=$(echo "$SNAP_P_B" | awk '{print $3}')
echo "prod before: replies=$P_REP_B messages=$P_MSG_B maxreply=$P_MAX_B"

echo "== 4. ticket-bound 真审批验收（真 Runtime + 真 ticket + 真 guard + 真 adapter，store=canary）=="
SNAP_C_B=$(ro_counts "$CANARY_DB"); C_REP_B=$(echo "$SNAP_C_B" | awk '{print $1}'); C_MSG_B=$(echo "$SNAP_C_B" | awk '{print $2}')
echo "canary before spec: replies=$C_REP_B messages=$C_MSG_B"
# 让验收 spec 的「批准写」直接落**本脚本这份 canary**（同一文件），好机械核 +1。
# 4a) 组件集成 spec（批准写落本脚本 canary，用于机械核 +1）
( cd "$BACKEND" && MESSAGES_ACCEPT_DB="$CANARY_DB" "./node_modules/.bin/vitest" run tests/integrations/internal-messages-live-acceptance.spec.ts ) \
  || fail "组件集成 spec 未全绿"
# 4b) **真执行器会话** spec：真 DSH AgentLoop + 真 dsh-mcp-client stdio + 真 tools.guard + 真公开批准/拒绝入口。
#     它用自己 mkdtemp 的隔离 canary（不动本脚本这份、也不动生产）；证明真 MCP stdio 被真派发链 call。
( cd "$BACKEND" && "./node_modules/.bin/vitest" run tests/integrations/internal-messages-live-worker.spec.ts ) \
  || fail "真执行器 worker spec 未全绿"
SNAP_C_A=$(ro_counts "$CANARY_DB"); C_REP_A=$(echo "$SNAP_C_A" | awk '{print $1}'); C_MSG_A=$(echo "$SNAP_C_A" | awk '{print $2}')
echo "canary after  spec: replies=$C_REP_A messages=$C_MSG_A"
# 验收 spec 覆盖：批准一次 +1、拒后 +0、再调 +0；这里机械核「canary 净 +1（批准的那一条）、messages 不变」。
[ "$C_REP_A" -eq $((C_REP_B + 1)) ] || fail "canary replies 应净 +1（批准一次），实际 $C_REP_B→$C_REP_A"
# 验收场景会先注入一条**真实父消息**（+1 message）再批准写 replies（+1 reply）；除此之外 messages 不得因写而多。
# 关键断言：replies 只来自批准写（+1），messages 只多了那一条 seed（+1，不是写 reply 触发的 Trigger）。
[ "$C_MSG_A" -eq $((C_MSG_B + 1)) ] || fail "canary messages 应只因 seed 父消息 +1，实际 $C_MSG_B→$C_MSG_A"
seed_msg=$(python3 -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print(c.execute(\"SELECT count(*) FROM messages WHERE text LIKE '用户：%'\").fetchone()[0])" "$CANARY_DB")
[ "$seed_msg" -ge 1 ] || fail "canary 里找不到验收 seed 的父消息（messages 的 +1 必须来自真实 seed，不是写路径）"
ok "canary replies 净 +1（批准写）、messages 只多 seed 父消息 +1（写 reply 不产 Trigger）"

echo "== 5. 生产库后置只读快照：须一字不变 =="
SNAP_P_A=$(ro_counts "$PROD_DB"); P_REP_A=$(echo "$SNAP_P_A" | awk '{print $1}'); P_MSG_A=$(echo "$SNAP_P_A" | awk '{print $2}'); P_MAX_A=$(echo "$SNAP_P_A" | awk '{print $3}')
echo "prod after : replies=$P_REP_A messages=$P_MSG_A maxreply=$P_MAX_A"
if [ "$P_REP_A" -ne "$P_REP_B" ] || [ "$P_MSG_A" -ne "$P_MSG_B" ] || [ "$P_MAX_A" -ne "$P_MAX_B" ]; then
  echo "✗ 验收窗口不静默：生产库计数在窗口内变化 replies $P_REP_B→$P_REP_A / messages $P_MSG_B→$P_MSG_A / max $P_MAX_B→$P_MAX_A" >&2
  echo "  可能原因：真实用户/其它进程并发改库 —— 无法归因为测试误写，请择窗口重测。" >&2
  exit 1
fi
ok "生产库 replies/messages/maxreply 全程未变（只读核，无写入）"

echo
echo "ALL GREEN — 机械验收通过："
echo "  · resolved MCP env → 独占 canary（dev/inode 异于生产）"
echo "  · 真 ticket + guardConnection：读放行 / 写未批准零写 / 批准同一次 +1 / 再调重问 +0 / 拒后 +0"
echo "  · 生产库双库前后只读计数一字不变"
