#!/usr/bin/env bash
# tailcat_nat_probe.sh — #20 跨 NAT 打洞成功率 可复跑探针
#
# 目的：在**真实跨 NAT 条件**下，对 tailcat 的 direct vs DERP 路径分别计数，
#       并自动判别「同 NAT（私网 IP 直连冒充）」vs「真跨 NAT（公网 IP 直连）」。
#
# 设计铁律（来自 docs/review/2026-11-14-issue20-weaknet-nat.md）：
#   - 「direct」不等于「打洞成功」：若 direct 的对端是 192.168./10./172.16-31 私网 IP，
#     说明两台在同一 NAT 后，是 LAN 直连，不算打洞。
#   - 只有 direct 且对端为**公网 IP** 才算一次真实 hole-punch 成功。
#   - DERP 是打洞失败时的中继兜底：「relay 成功」≠「打洞成功」。
#
# 用法：
#   # A. 本机作为 client，ping 远端已起好的 serve（由 setup 步骤起）
#   ./tailcat_nat_probe.sh --peer <tc-addr> [--count 30] [--timeout 10s]
#
#   # B. 全部走环境变量（CI/一键）
#   PEER=100.x.y.z:43510 COUNT=30 TIMEOUT=10s ./tailcat_nat_probe.sh
#
#   # --until-direct：每轮持续 ping 直到出现 direct（或超时），用于压 hole-punch 成功率
#
# 输出：
#   - 逐轮 pong 原始行（标注 direct-private / direct-public / derp）
#   - 末尾 SUMMARY：total / direct_public(真打洞) / direct_private(同NAT冒充) / derp / fail
#   - 退出码：0=至少一次 direct_public；2=无 direct_public（跨NAT不成立或打洞全失败）；1=参数/环境错
#
# 依赖：backend/tools/tailcat（或 $TAILCAT），python3 只用于汇总解析。
# 不触碰生产：默认用隔离 key（--key 默认 i20probe），不改 default.private.json。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TAILCAT="${TAILCAT:-$ROOT/backend/tools/tailcat}"

PEER="${PEER:-}"
COUNT="${COUNT:-30}"
TIMEOUT="${TIMEOUT:-10s}"
KEY="${KEY:-i20probe}"
UNTIL_DIRECT="${UNTIL_DIRECT:-1}"
VERIFY_ARGS=()
OUTDIR="${OUTDIR:-$HERE/runs}"
TS="$(date +%Y%m%d-%H%M%S)"

while [ $# -gt 0 ]; do
  case "$1" in
    --peer) PEER="$2"; shift 2;;
    --count) COUNT="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --no-until-direct) UNTIL_DIRECT=0; shift;;
    --verify-cross-nat) VERIFY_ARGS+=("--verify-cross-nat"); shift;;
    --topology-note) VERIFY_ARGS+=("--topology-note" "$2"); shift 2;;
    -h|--help) sed -n '2,45p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

[ -x "$TAILCAT" ] || { echo "ERR: tailcat not found/exec: $TAILCAT" >&2; exit 1; }
[ -n "$PEER" ] || { echo "ERR: --peer <tc-addr> required (e.g. 100.x.y.z:43510). See README." >&2; exit 1; }
mkdir -p "$OUTDIR"
RAW="$OUTDIR/probe-$TS.txt"
JSON="$OUTDIR/probe-$TS.json"

echo "# tailcat_nat_probe  ts=$TS  peer=$PEER  count=$COUNT  timeout=$TIMEOUT  key=$KEY  until_direct=$UNTIL_DIRECT" | tee "$RAW"

# 归类交给 cross_nat_classify.py（前缀/子网比对；public IP ≠ 不同 NAT）
PONGLOG="$OUTDIR/pongs-$TS.txt"; : > "$PONGLOG"
fail=0
for i in $(seq 1 "$COUNT"); do
  if [ "$UNTIL_DIRECT" = "1" ]; then
    line="$("$TAILCAT" --key="$KEY" ping --until-direct --timeout="$TIMEOUT" "$PEER" 2>&1)"
    rc=$?
  else
    line="$("$TAILCAT" --key="$KEY" ping --timeout="$TIMEOUT" "$PEER" 2>&1)"
    rc=$?
  fi
  final="$(printf '%s\n' "$line" | grep -E 'pong in' | tail -1)"
  if [ -z "$final" ]; then
    echo "[$i] rc=$rc  NO-PONG :: $(printf '%s' "$line" | tail -1)" | tee -a "$RAW"
    fail=$((fail+1)); continue
  fi
  echo "[$i] rc=$rc  $final" | tee -a "$RAW"
  printf '%s\n' "$final" >> "$PONGLOG"
done

# 用核心判别器（前缀/子网比对）归类所有 pong。
# fail-closed：不同公网IP/不同/64 只算 CANDIDATE，不自动 verified。
# 要升级为 CROSS-NAT-VERIFIED，请显式加：
#   --verify-cross-nat --topology-note "<已知双方拓扑 / IPv4 NAT 映射 / 明确跨网IPv6无NAT直连>"
echo "" | tee -a "$RAW"
echo "=== CLASSIFY (cross_nat_classify.py, fail-closed candidate) ===" | tee -a "$RAW"
if [ "${#VERIFY_ARGS[@]}" -gt 0 ]; then
  python3 "$HERE/cross_nat_classify.py" --file "$PONGLOG" "${VERIFY_ARGS[@]}" > "$JSON" 2>>"$RAW"
else
  python3 "$HERE/cross_nat_classify.py" --file "$PONGLOG" > "$JSON" 2>>"$RAW"
fi
CLS_RC=$?
cat "$JSON" | tee -a "$RAW"
echo "no_pong_fail=$fail" | tee -a "$RAW"
# classify 退出码：0=verified / 2=候选或同NAT未验收 / 3=无direct。透传（fail-closed）。
if [ "$CLS_RC" -eq 0 ]; then
  verr="CROSS-NAT-VERIFIED"
elif [ "$CLS_RC" -eq 3 ]; then
  verr="NO-DIRECT-PATH"
else
  verr="CANDIDATE-OR-SAME-NAT-NOT-VERIFIED (需 --verify-cross-nat + --topology-note 且无 same-lan/unknown 反证才升级)"
fi
exit_rc=$CLS_RC
echo "verdict=$verr  classify_rc=$CLS_RC" | tee -a "$RAW"
echo "wrote $RAW / $JSON / $PONGLOG"
exit $exit_rc
