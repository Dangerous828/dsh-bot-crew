#!/bin/sh
# 中转部署后的冒烟检查。只读：不发请求进任何隧道，不改任何状态。
#
# 用法：
#   sh relay/scripts/smoke.sh http://192.168.31.152:18800
#   CREW_RELAY_ADMIN_TOKEN=... sh relay/scripts/smoke.sh https://jarvis.kentonnie.top/crew-relay
#
# 注意别拿 relay.kentonnie.top 测：那是 AI-HUB 的 dsh-relay，/health 形状相近，
# 打过去会给出「通过」的假阳性。
#
# 它回答三个问题：进程活着吗、公开视图是否按预期不泄露、详情视图是否受令牌保护。
set -u
BASE=${1:-http://127.0.0.1:8787}
fail=0
say() { printf '%-46s %s\n' "$1" "$2"; }

# 1. 公开健康检查。应当 200 且 ok:true。
health=$(curl -s --max-time 5 "$BASE/health" 2>/dev/null)
case "$health" in
  *'"ok":true'*) say "GET /health" "ok  $health" ;;
  *) say "GET /health" "FAIL  期望 ok:true，实际：${health:-<空>}"; fail=1 ;;
esac

# 2. 公开视图不能列 instanceId（那是「谁在家、什么时候在家」的信息）。
case "$health" in
  *'"instances"'*) say "GET /health 不泄露 instanceId" "FAIL  公开视图里有 instances 字段"; fail=1 ;;
  *) say "GET /health 不泄露 instanceId" "ok" ;;
esac

# 3. 详情视图：没有令牌时必须是 401。
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/health?detail=1" 2>/dev/null)
if [ "$code" = "401" ]; then say "GET /health?detail=1 无令牌" "ok  401"
else say "GET /health?detail=1 无令牌" "FAIL  期望 401，实际 $code"; fail=1; fi

# 4. 有令牌时应当 200（只在配了令牌时检查）。
if [ -n "${CREW_RELAY_ADMIN_TOKEN:-}" ]; then
  detail=$(curl -s --max-time 5 -H "Authorization: Bearer $CREW_RELAY_ADMIN_TOKEN" "$BASE/health?detail=1" 2>/dev/null)
  case "$detail" in
    *'"instances"'*) say "GET /health?detail=1 带令牌" "ok  $detail" ;;
    *) say "GET /health?detail=1 带令牌" "FAIL  期望 instances 字段，实际：${detail:-<空>}"; fail=1 ;;
  esac
else
  say "GET /health?detail=1 带令牌" "跳过（没设 CREW_RELAY_ADMIN_TOKEN）"
fi

# 5. 不存在的实例要 404，而不是 500 或者挂住。
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/i/definitely-not-here/api/mobile/timeline" 2>/dev/null)
if [ "$code" = "404" ]; then say "GET /i/<未知实例>/..." "ok  404"
else say "GET /i/<未知实例>/..." "FAIL  期望 404，实际 $code"; fail=1; fi

# 6. 隧道端点对普通 HTTP 请求要拒绝（它不是网页）。
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/tunnel" 2>/dev/null)
case "$code" in
  4??|5??) say "GET /tunnel（非升级请求）" "ok  $code" ;;
  *) say "GET /tunnel（非升级请求）" "FAIL  期望 4xx/5xx，实际 $code"; fail=1 ;;
esac

if [ "$fail" = "0" ]; then echo "smoke: 通过"; else echo "smoke: 有检查未通过"; fi
exit "$fail"
