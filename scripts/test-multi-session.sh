#!/bin/sh
# S1 独立端到端验收：只起临时 mobilegw，按 /tmp/s1-contract.md §6 跑 7 组 HTTP 断言。
# 用法：sh scripts/test-multi-session.sh
set -u

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P) || exit 1
ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd -P) || exit 1
GW="$ROOT/backend/tools/mobilegw"

for tool in python3 curl mktemp env dirname date sleep cat; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'FAIL missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ -f "$GW" ] || { printf 'FAIL missing gateway: %s\n' "$GW" >&2; exit 1; }

DSH_HOME=$(mktemp -d "${TMPDIR:-/tmp}/s1-multi-session.XXXXXX") || {
  printf 'FAIL mktemp -d failed\n' >&2
  exit 1
}
MOBILEGW_STATE="$DSH_HOME/state/superagent"
TOKEN_FILE="$MOBILEGW_STATE/mobilegw.token"
GW_LOG="$DSH_HOME/mobilegw.log"
CURL_ERR="$DSH_HOME/curl.err"
JSONCHECK="$DSH_HOME/jsoncheck.py"

GW_PID=
MOBILEGW_PORT=
BASE=
TOKEN=
HTTP_STATUS=000
LAST_BODY=
FAILURES=0
HEALTH_TIMEOUT=20

RID_LEGACY=s1-legacy
TEXT_LEGACY=legacy-hello
RID_SAME=s1-same
TEXT_A=A
TEXT_B=B
RID_MAIN_ONLY=s1-main-only
TEXT_MAIN_ONLY=main-only
RID_WORK_ONLY=s1-work-only
TEXT_WORK_ONLY=work-only
RID_DEFAULT=s1-default
TEXT_DEFAULT=default-main
RID_EXPLICIT=s1-explicit
TEXT_EXPLICIT=explicit-main
RID_BAD_SPACE=s1-bad-space
RID_BAD_LONG=s1-bad-long

MID_LEGACY=
MID_A=
MID_B=
TL_MAIN_BODY=
TL_WORK_BODY=
TL_DEFAULT_BODY=
TL_EXPLICIT_MAIN_BODY=

cleanup() {
  rc=$?
  trap - 0 1 2 3 15
  if [ -n "$GW_PID" ]; then
    kill "$GW_PID" 2>/dev/null || :
    wait "$GW_PID" 2>/dev/null || :
  fi
  if [ -n "$DSH_HOME" ] && [ -d "$DSH_HOME" ]; then
    rm -rf "$DSH_HOME"
  fi
  exit "$rc"
}
trap cleanup 0 1 2 3 15

cat > "$JSONCHECK" <<'PY'
import json
import os
import sys


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def env(name):
    if name not in os.environ:
        fail('missing env %s' % name)
    return os.environ[name]


def int_env(name):
    try:
        return int(env(name))
    except ValueError:
        fail('env %s is not an int: %r' % (name, env(name)))


def load(path):
    try:
        with open(path, 'r', encoding='utf-8') as stream:
            return json.load(stream)
    except (OSError, ValueError) as error:
        fail('bad JSON body %s: %s' % (path, error))


def send_ok(data):
    rid = env('EXPECT_RID')
    required = {'ok', 'id', 'request_id'}
    if not isinstance(data, dict) or not required.issubset(data):
        fail('send response missing required fields: %r' % (data,))
    if data.get('ok') is not True or type(data.get('id')) is not int or data.get('request_id') != rid:
        fail('unexpected send response: %r' % (data,))


def withdraw_ok(data):
    rid = env('EXPECT_RID')
    mid = int_env('EXPECT_MID')
    if not isinstance(data, dict):
        fail('withdraw response is not an object: %r' % (data,))
    if data.get('ok') is not True or data.get('id') != mid or data.get('request_id') != rid:
        fail('unexpected withdraw response: %r' % (data,))


def timeline_empty(data):
    if not isinstance(data, dict) or data.get('items') != []:
        fail('timeline expected to be empty: %r' % (data,))


def exact_item(data):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        fail('timeline items missing: %r' % (data,))
    items = data['items']
    if len(items) != 1:
        fail('timeline item count %d, expected 1: %r' % (len(items), items))
    item = items[0]
    expected_keys = {'role', 'text', 'at', 'id', 'request_id', 'read_at', 'mentions'}
    if not isinstance(item, dict) or set(item) != expected_keys:
        fail('timeline item shape changed: %r' % (item,))
    rid = env('EXPECT_RID')
    text = env('EXPECT_TEXT')
    mid = int_env('EXPECT_MID')
    expected = {
        'role': 'user',
        'text': text,
        'id': 'm%d' % mid,
        'request_id': rid,
        'read_at': '',
        'mentions': [],
    }
    for key, value in expected.items():
        if item.get(key) != value:
            fail('timeline item %s=%r, expected %r' % (key, item.get(key), value))
    if not isinstance(item.get('at'), str) or not item['at']:
        fail('timeline item at is not a timestamp string: %r' % (item.get('at'),))


def capability(data):
    if not isinstance(data, dict):
        fail('timeline capability response is not an object: %r' % (data,))
    expected_session = env('EXPECT_SESSION')
    if data.get('session_id') != expected_session:
        fail('session_id=%r, expected %r' % (data.get('session_id'), expected_session))
    api = data.get('session_api')
    if type(api) is not int or api != 1:
        fail('session_api=%r, expected 1' % (api,))
    if not isinstance(data.get('items'), list):
        fail('timeline capability response has no items list: %r' % (data,))


def any_capability(data):
    """非 timeline 响应也必须带能力位：直发 send 到老网关才不会被静默按 main 落库。"""
    if not isinstance(data, dict):
        fail('capability response is not an object: %r' % (data,))
    expected_session = env('EXPECT_SESSION')
    if data.get('session_id') != expected_session:
        fail('session_id=%r, expected %r' % (data.get('session_id'), expected_session))
    api = data.get('session_api')
    if type(api) is not int or api != 1:
        fail('session_api=%r, expected 1' % (api,))


def no_capability(data):
    """老调用（不带 session_id）一个新增字段都不该有。"""
    if not isinstance(data, dict):
        fail('legacy response is not an object: %r' % (data,))
    if 'session_id' in data or 'session_api' in data:
        fail('legacy response gained capability fields: %r' % (data,))


def error_exact(data):
    expected = {'error': env('EXPECT_ERROR')}
    if data != expected:
        fail('error body=%r, expected %r' % (data, expected))


def has_error(data):
    if not isinstance(data, dict) or not isinstance(data.get('error'), str) or not data['error']:
        fail('response has no error string: %r' % (data,))


def contains_rids(data):
    rids = [rid for rid in env('EXPECT_RIDS').split(',') if rid]
    if not rids:
        fail('EXPECT_RIDS is empty')
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        fail('timeline items missing: %r' % (data,))
    for rid in rids:
        seen = 0
        for item in data['items']:
            if isinstance(item, dict) and item.get('request_id') == rid:
                seen += 1
        if seen != 1:
            fail('request_id %r appears %d times, expected once' % (rid, seen))


def equal_bodies(path_a, path_b):
    body_a = load(path_a)
    body_b = load(path_b)
    if body_a != body_b:
        fail('default and explicit main timeline bodies differ:\n%s\n%s' % (body_a, body_b))


def main():
    if len(sys.argv) < 3:
        fail('usage: jsoncheck.py CHECK BODY [BODY2]')
    check = sys.argv[1]
    first = sys.argv[2]
    if check == 'equal':
        if len(sys.argv) != 4:
            fail('equal needs two body files')
        equal_bodies(first, sys.argv[3])
        return
    data = load(first)
    if check == 'print_id':
        if not isinstance(data, dict) or type(data.get('id')) is not int:
            fail('response has no numeric id: %r' % (data,))
        print(data['id'])
        return
    checks = {
        'send_ok': send_ok,
        'withdraw_ok': withdraw_ok,
        'timeline_empty': timeline_empty,
        'exact_item': exact_item,
        'capability': capability,
        'any_capability': any_capability,
        'no_capability': no_capability,
        'error_exact': error_exact,
        'has_error': has_error,
        'contains_rids': contains_rids,
    }
    if check not in checks:
        fail('unknown check: %s' % check)
    checks[check](data)


if __name__ == '__main__':
    main()
PY
[ -s "$JSONCHECK" ] || { printf 'FAIL json helper was not written\n' >&2; exit 1; }
python3 -m py_compile "$JSONCHECK" || { printf 'FAIL json helper has Python syntax errors\n' >&2; exit 1; }

LONG_SESSION=$(python3 -c 'print("a" * 40)') || {
  printf 'FAIL long session_id generation failed\n' >&2
  exit 1
}

choose_port() {
  python3 - <<'PY'
import random
import socket
import sys

banned = {8788, 18787}
for port in random.sample(range(20000, 60000), 400):
    if port in banned:
        continue
    sock = socket.socket()
    try:
        sock.bind(('127.0.0.1', port))
    except OSError:
        continue
    finally:
        sock.close()
    print(port)
    sys.exit(0)
print('no free port', file=sys.stderr)
sys.exit(1)
PY
}

wait_health() {
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    if curl --noproxy '*' --globoff -fsS --max-time 1 "$BASE/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$GW_PID" 2>/dev/null; then
      printf '  FAIL mobilegw exited before /health was reachable\n' >&2
      [ -s "$GW_LOG" ] && cat "$GW_LOG" >&2
      return 1
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      printf '  FAIL mobilegw /health timeout after %ss\n' "$HEALTH_TIMEOUT" >&2
      [ -s "$GW_LOG" ] && cat "$GW_LOG" >&2
      return 1
    fi
    sleep 0.1
  done
}

start_gateway() {
  attempt=1
  while [ "$attempt" -le 5 ]; do
    MOBILEGW_PORT=$(choose_port) || return 1
    case "$MOBILEGW_PORT" in
      ''|*[!0-9]*)
        printf '  FAIL invalid random port: %s\n' "$MOBILEGW_PORT" >&2
        attempt=$((attempt + 1))
        continue
        ;;
    esac
    BASE="http://127.0.0.1:$MOBILEGW_PORT"
    : > "$GW_LOG"
    env "DSH_HOME=$DSH_HOME" "MOBILEGW_STATE=$MOBILEGW_STATE" \
      MOBILEGW_HOST=127.0.0.1 "MOBILEGW_PORT=$MOBILEGW_PORT" MOBILEGW_CONV=main \
      PYTHONUNBUFFERED=1 python3 "$GW" >"$GW_LOG" 2>&1 &
    GW_PID=$!
    if wait_health; then
      return 0
    fi
    printf '  gateway start attempt %s was not healthy; retrying with a fresh port\n' "$attempt" >&2
    kill "$GW_PID" 2>/dev/null || :
    wait "$GW_PID" 2>/dev/null || :
    GW_PID=
    attempt=$((attempt + 1))
  done
  return 1
}

http() {
  method=$1
  path=$2
  body=${3-}
  LAST_BODY=$(mktemp "$DSH_HOME/body.XXXXXX") || return 1
  : > "$CURL_ERR"
  if [ "$method" = GET ]; then
    HTTP_STATUS=$(curl --noproxy '*' --globoff -sS --max-time 5 \
      -o "$LAST_BODY" -w '%{http_code}' -X GET \
      -H "X-GW-Token: $TOKEN" "$BASE$path" 2>"$CURL_ERR") || HTTP_STATUS=000
  else
    HTTP_STATUS=$(curl --noproxy '*' --globoff -sS --max-time 5 \
      -o "$LAST_BODY" -w '%{http_code}' -X "$method" \
      -H "X-GW-Token: $TOKEN" -H 'Content-Type: application/json' \
      --data "$body" "$BASE$path" 2>"$CURL_ERR") || HTTP_STATUS=000
  fi
  if [ -z "$HTTP_STATUS" ] || [ "$HTTP_STATUS" = 000 ]; then
    printf '  FAIL curl %s %s\n' "$method" "$path" >&2
    [ -s "$CURL_ERR" ] && cat "$CURL_ERR" >&2
    return 1
  fi
}

expect_status() {
  expected=$1
  label=$2
  if [ "$HTTP_STATUS" = "$expected" ]; then
    return 0
  fi
  printf '  FAIL %s: HTTP %s, expected %s\n' "$label" "$HTTP_STATUS" "$expected" >&2
  if [ -s "$LAST_BODY" ]; then
    printf '  body: ' >&2
    cat "$LAST_BODY" >&2
    printf '\n' >&2
  fi
  return 1
}

record() {
  label=$1
  shift
  if "$@"; then
    return 0
  fi
  printf '  FAIL %s\n' "$label" >&2
  return 1
}

capture_id() {
  value=$(python3 "$JSONCHECK" print_id "$1") || return 1
  if [ -z "$value" ]; then
    printf '  FAIL response has no numeric id\n' >&2
    return 1
  fi
  printf '%s' "$value"
}

check_404() {
  method=$1
  path=$2
  body=$3
  label=$4
  http "$method" "$path" "$body" || return 1
  expect_status 404 "$label" || return 1
  python3 "$JSONCHECK" has_error "$LAST_BODY"
}

check_invalid() {
  method=$1
  path=$2
  body=$3
  label=$4
  http "$method" "$path" "$body" || return 1
  expect_status 400 "$label" || return 1
  env EXPECT_ERROR=invalid_session python3 "$JSONCHECK" error_exact "$LAST_BODY"
}

g1_old_call_word_for_word() {
  rc=0
  http POST /send "{\"text\":\"$TEXT_LEGACY\",\"request_id\":\"$RID_LEGACY\"}" || rc=1
  record 'legacy /send status' expect_status 200 'legacy /send' || rc=1
  record 'legacy /send body' env EXPECT_RID="$RID_LEGACY" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1
  MID_LEGACY=$(capture_id "$LAST_BODY") || rc=1

  http GET /timeline || rc=1
  record 'legacy /timeline status' expect_status 200 'legacy /timeline' || rc=1
  record 'legacy /timeline item shape' env EXPECT_RID="$RID_LEGACY" EXPECT_TEXT="$TEXT_LEGACY" EXPECT_MID="$MID_LEGACY" \
    python3 "$JSONCHECK" exact_item "$LAST_BODY" || rc=1

  http POST /withdraw "{\"request_id\":\"$RID_LEGACY\"}" || rc=1
  record 'legacy /withdraw status' expect_status 200 'legacy /withdraw' || rc=1
  record 'legacy /withdraw body' env EXPECT_RID="$RID_LEGACY" EXPECT_MID="$MID_LEGACY" \
    python3 "$JSONCHECK" withdraw_ok "$LAST_BODY" || rc=1

  http GET /timeline || rc=1
  record 'legacy cleanup timeline status' expect_status 200 'legacy cleanup timeline' || rc=1
  record 'legacy cleanup timeline empty' python3 "$JSONCHECK" timeline_empty "$LAST_BODY" || rc=1
  return "$rc"
}

g2_same_request_id_two_sessions() {
  rc=0
  http POST '/send?session_id=main' "{\"text\":\"$TEXT_A\",\"request_id\":\"$RID_SAME\"}" || rc=1
  record 'main /send status' expect_status 200 'main /send' || rc=1
  record 'main /send body' env EXPECT_RID="$RID_SAME" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1
  MID_A=$(capture_id "$LAST_BODY") || rc=1

  http POST '/send?session_id=work' "{\"text\":\"$TEXT_B\",\"request_id\":\"$RID_SAME\"}" || rc=1
  record 'work /send status' expect_status 200 'work /send' || rc=1
  record 'work /send body' env EXPECT_RID="$RID_SAME" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1
  MID_B=$(capture_id "$LAST_BODY") || rc=1

  if [ -n "$MID_A" ] && [ -n "$MID_B" ] && [ "$MID_A" != "$MID_B" ]; then
    :
  else
    printf '  FAIL same request_id produced one row only (main=%s work=%s)\n' "$MID_A" "$MID_B" >&2
    rc=1
  fi
  return "$rc"
}

g3_timelines_are_isolated() {
  rc=0
  http GET '/timeline?session_id=main' || rc=1
  TL_MAIN_BODY=$LAST_BODY
  record 'main /timeline status' expect_status 200 'main /timeline' || rc=1
  record 'main /timeline sees only A' env EXPECT_RID="$RID_SAME" EXPECT_TEXT="$TEXT_A" EXPECT_MID="$MID_A" \
    python3 "$JSONCHECK" exact_item "$TL_MAIN_BODY" || rc=1

  http GET '/timeline?session_id=work' || rc=1
  TL_WORK_BODY=$LAST_BODY
  record 'work /timeline status' expect_status 200 'work /timeline' || rc=1
  record 'work /timeline sees only B' env EXPECT_RID="$RID_SAME" EXPECT_TEXT="$TEXT_B" EXPECT_MID="$MID_B" \
    python3 "$JSONCHECK" exact_item "$TL_WORK_BODY" || rc=1
  return "$rc"
}

g4_timelines_echo_capability() {
  rc=0
  if [ -n "$TL_MAIN_BODY" ]; then
    record 'main timeline capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$TL_MAIN_BODY" || rc=1
  else
    printf '  FAIL main timeline body was not captured\n' >&2
    rc=1
  fi
  if [ -n "$TL_WORK_BODY" ]; then
    record 'work timeline capability' env EXPECT_SESSION=work python3 "$JSONCHECK" capability "$TL_WORK_BODY" || rc=1
  else
    printf '  FAIL work timeline body was not captured\n' >&2
    rc=1
  fi
  return "$rc"
}

g8_every_explicit_session_response_echoes_capability() {
  rc=0
  # 直发 send：客户端没先取 timeline 时，这一条就是唯一的能力位证据。
  http POST '/send?session_id=work' "{\"text\":\"capability-probe\",\"request_id\":\"cap-probe-1\"}" || rc=1
  record 'explicit /send status' expect_status 200 'explicit /send' || rc=1
  record 'explicit /send capability' env EXPECT_SESSION=work python3 "$JSONCHECK" any_capability "$LAST_BODY" || rc=1

  # 跨会话 claim 的 404 也是显式会话响应，同样要带能力位。
  http POST '/claim?session_id=work' '{"request_id":"no-such-row"}' || rc=1
  record 'explicit /claim 404 status' expect_status 404 'explicit /claim missing' || rc=1
  record 'explicit /claim 404 capability' env EXPECT_SESSION=work python3 "$JSONCHECK" any_capability "$LAST_BODY" || rc=1

  # 老调用不带 session_id：一个新增字段都不许有，响应逐字不变。
  http POST '/send' "{\"text\":\"legacy-probe\",\"request_id\":\"cap-probe-legacy\"}" || rc=1
  record 'legacy /send status' expect_status 200 'legacy /send' || rc=1
  record 'legacy /send has no capability fields' python3 "$JSONCHECK" no_capability "$LAST_BODY" || rc=1
  return "$rc"
}

g5_cross_session_withdraw_claim_404() {
  rc=0
  http POST '/send?session_id=main' "{\"text\":\"$TEXT_MAIN_ONLY\",\"request_id\":\"$RID_MAIN_ONLY\"}" || rc=1
  record 'main-only /send status' expect_status 200 'main-only /send' || rc=1
  record 'main-only /send body' env EXPECT_RID="$RID_MAIN_ONLY" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1

  http POST '/send?session_id=work' "{\"text\":\"$TEXT_WORK_ONLY\",\"request_id\":\"$RID_WORK_ONLY\"}" || rc=1
  record 'work-only /send status' expect_status 200 'work-only /send' || rc=1
  record 'work-only /send body' env EXPECT_RID="$RID_WORK_ONLY" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1

  check_404 POST '/withdraw?session_id=main' "{\"request_id\":\"$RID_WORK_ONLY\"}" 'main /withdraw work-only' || rc=1
  check_404 POST '/withdraw?session_id=work' "{\"request_id\":\"$RID_MAIN_ONLY\"}" 'work /withdraw main-only' || rc=1
  check_404 POST '/claim?session_id=main' "{\"request_id\":\"$RID_WORK_ONLY\"}" 'main /claim work-only' || rc=1
  check_404 POST '/claim?session_id=work' "{\"request_id\":\"$RID_MAIN_ONLY\"}" 'work /claim main-only' || rc=1
  return "$rc"
}

g6_invalid_session_id_shapes() {
  rc=0
  check_invalid GET '/timeline?session_id=Work' '' 'uppercase session_id' || rc=1
  check_invalid POST '/send?session_id=a%20b' \
    "{\"text\":\"bad space\",\"request_id\":\"$RID_BAD_SPACE\"}" 'space session_id' || rc=1
  check_invalid POST "/withdraw?session_id=$LONG_SESSION" \
    "{\"request_id\":\"$RID_BAD_LONG\"}" 'overlong session_id' || rc=1
  return "$rc"
}

g7_default_falls_back_to_main() {
  rc=0
  http POST /send "{\"text\":\"$TEXT_DEFAULT\",\"request_id\":\"$RID_DEFAULT\"}" || rc=1
  record 'default /send status' expect_status 200 'default /send' || rc=1
  record 'default /send body' env EXPECT_RID="$RID_DEFAULT" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1

  http POST '/send?session_id=main' "{\"text\":\"$TEXT_EXPLICIT\",\"request_id\":\"$RID_EXPLICIT\"}" || rc=1
  record 'explicit main /send status' expect_status 200 'explicit main /send' || rc=1
  record 'explicit main /send body' env EXPECT_RID="$RID_EXPLICIT" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1

  http GET /timeline || rc=1
  TL_DEFAULT_BODY=$LAST_BODY
  record 'default /timeline status' expect_status 200 'default /timeline' || rc=1
  record 'default /timeline capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$TL_DEFAULT_BODY" || rc=1
  record 'default /timeline sees both sends' env EXPECT_RIDS="$RID_DEFAULT,$RID_EXPLICIT" \
    python3 "$JSONCHECK" contains_rids "$TL_DEFAULT_BODY" || rc=1

  http GET '/timeline?session_id=main' || rc=1
  TL_EXPLICIT_MAIN_BODY=$LAST_BODY
  record 'explicit main /timeline status' expect_status 200 'explicit main /timeline' || rc=1
  record 'explicit main /timeline capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$TL_EXPLICIT_MAIN_BODY" || rc=1
  record 'explicit main /timeline sees both sends' env EXPECT_RIDS="$RID_DEFAULT,$RID_EXPLICIT" \
    python3 "$JSONCHECK" contains_rids "$TL_EXPLICIT_MAIN_BODY" || rc=1

  record 'default and explicit main timelines are equivalent' \
    python3 "$JSONCHECK" equal "$TL_DEFAULT_BODY" "$TL_EXPLICIT_MAIN_BODY" || rc=1
  return "$rc"
}

run_group() {
  number=$1
  title=$2
  fn=$3
  printf '%s. %s\n' "$number" "$title"
  if "$fn"; then
    printf 'PASS %s. %s\n' "$number" "$title"
  else
    printf 'FAIL %s. %s\n' "$number" "$title"
    FAILURES=$((FAILURES + 1))
  fi
}

start_gateway || {
  printf 'FAIL mobilegw fixture did not start\n' >&2
  exit 1
}
[ -s "$TOKEN_FILE" ] || {
  printf 'FAIL token file missing: %s\n' "$TOKEN_FILE" >&2
  exit 1
}
TOKEN=$(cat "$TOKEN_FILE")
[ -n "$TOKEN" ] || {
  printf 'FAIL token file empty: %s\n' "$TOKEN_FILE" >&2
  exit 1
}
printf 'fixture: DSH_HOME=%s MOBILEGW_PORT=%s\n' "$DSH_HOME" "$MOBILEGW_PORT"

run_group 1 '老调用（无 session_id）逐字兼容' g1_old_call_word_for_word
run_group 2 'main 与 work 各发同一个 request_id，各入一条' g2_same_request_id_two_sessions
run_group 3 '两个 timeline 只见各自消息，互不串' g3_timelines_are_isolated
run_group 4 '两个 timeline 都回显 session_id 与 session_api=1' g4_timelines_echo_capability
run_group 5 '跨会话 withdraw 与 claim 均为 404' g5_cross_session_withdraw_claim_404
run_group 6 '大写、含空格、超长 session_id 均为 400 invalid_session' g6_invalid_session_id_shapes
run_group 7 '不带参数与显式 main 等价' g7_default_falls_back_to_main
run_group 8 '显式会话的所有响应都回显能力位，老调用一个字段都不加' g8_every_explicit_session_response_echoes_capability

if [ "$FAILURES" -ne 0 ]; then
  printf 'FAIL %s group(s) failed\n' "$FAILURES" >&2
  exit 1
fi
printf 'PASS all 8 groups\n'
exit 0
