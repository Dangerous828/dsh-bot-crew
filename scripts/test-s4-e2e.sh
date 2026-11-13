#!/bin/sh
# S4 端到端验收：独立临时 mobilegw，按 /tmp/s4-contract.md §4 跑断言组。
#
# 用法：
#   sh scripts/test-s4-e2e.sh
#   S4_REQUIRE_HEADER=1 sh scripts/test-s4-e2e.sh   # A 合入后由 lead 跑绿
#
# 边界（2026-11-13）：header 形态由 agent A 实现。网关已识别 x-crew-session 时，
# 两道只读 probe 会自动启用全部 header 断言；尚未识别时逐条打印 "SKIP (deferred)"，
# 等 A 合入后由 lead 以 S4_REQUIRE_HEADER=1 跑绿（严格模式下 deferred 直接 FAIL）。
# B 的 source-session-admission.spec.ts 与 C 的 groups.spec.ts 单测桥接组同理
# （文件不存在时 deferred；文件存在则真跑 vitest）。
#
# 输出语义（2026-11-13 修假绿）：
# - 只有**真实跑过且通过**的断言才计 PASS；deferred 一律打印 SKIP，绝不计 PASS。
# - 组级状态三态：PASS（全部真跑通过）/ PARTIAL（部分真跑、部分 SKIP）/ SKIP（全部 SKIP）。
# - 汇总行分开报「真跑了多少条」与「多少条 NOT covered」，未覆盖时汇总行不以 PASS 开头，
#   让只看退出码或 grep PASS 的 CI 也能一眼看出覆盖不全。
# - 退出码语义不变：所有真跑断言通过即 exit 0；严格模式下没有 SKIP，缺依赖即 FAIL → exit 1。
# 真机验收（issue #15 七项）不在本脚本范围。
#
# 独立性：DSH_HOME 与 MOBILEGW_STATE 都指向 mktemp 目录；端口随机且避开
# 8788 / 18787 / 18799 / 18801；trap 只清理自己起的网关进程与自己建的目录，
# 不读写生产 <stateDir>/mobileq.db、不碰生产 token、不重启也不杀任何现存服务。
set -u

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P) || exit 1
ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd -P) || exit 1
GW="$ROOT/backend/tools/mobilegw"

for tool in python3 curl mktemp env dirname date sleep cat; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'FAIL missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ -f "$GW" ] || { printf 'FAIL missing gateway: %s\n' "$GW" >&2; exit 1; }

STRICT_HEADER=${S4_REQUIRE_HEADER:-0}
case "$STRICT_HEADER" in
  0|1) : ;;
  *) printf 'FAIL S4_REQUIRE_HEADER must be 0 or 1\n' >&2; exit 1 ;;
esac

DSH_HOME=$(mktemp -d "${TMPDIR:-/tmp}/s4-e2e.XXXXXX") || {
  printf 'FAIL mktemp -d failed\n' >&2
  exit 1
}
MOBILEGW_STATE="$DSH_HOME/state/superagent"
TOKEN_FILE="$MOBILEGW_STATE/mobilegw.token"
DB="$MOBILEGW_STATE/mobileq.db"
GW_LOG="$DSH_HOME/mobilegw.log"
CURL_ERR="$DSH_HOME/curl.err"
UNIT_LOG="$DSH_HOME/unit.log"
JSONCHECK="$DSH_HOME/s4check.py"
DBCHECK="$DSH_HOME/dbcheck.py"
UNIT_RUNNER="$DSH_HOME/run_unit.py"

GW_PID=
MOBILEGW_PORT=
BASE=
TOKEN=
HTTP_STATUS=000
LAST_BODY=
FAILURES=0
DEFERRED=0
CHECKS=0
TOTAL_GROUPS=0
PASS_GROUPS=0
PARTIAL_GROUPS=0
SKIP_GROUPS=0
HEADER_SUPPORTED=0
HEALTH_TIMEOUT=20

RID_LEGACY=s4-legacy
TEXT_LEGACY=legacy-hello
RID_DEFAULT=s4-default
TEXT_DEFAULT=default-main
RID_EXPLICIT=s4-explicit
TEXT_EXPLICIT=explicit-main
RID_WORK=s4-work
TEXT_WORK=work-query
RID_MAIN=s4-main
TEXT_MAIN=main-query
RID_QUERY_ERR=s4-query-bad
RID_HEADER=s4-header
TEXT_HEADER=header-only
RID_HEADER_SAME=s4-header-same
TEXT_HEADER_SAME=header-and-query
RID_CONFLICT=s4-conflict
RID_HEADER_BAD=s4-header-cap
RID_UNREG=s4-unreg
TEXT_UNREG=unregistered-session
SESS_WORK=work
SESS_UNREG=s4-unreg
LONG_SESSION=$(python3 -c 'print("a" * 40)') || {
  printf 'FAIL long session_id generation failed\n' >&2
  exit 1
}

MID_LEGACY=
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


def load(path):
    try:
        with open(path, 'r', encoding='utf-8') as stream:
            return json.load(stream)
    except (OSError, ValueError) as error:
        fail('bad JSON body %s: %s' % (path, error))


def send_ok(data):
    rid = env('EXPECT_RID')
    if not isinstance(data, dict) or set(data) != {'ok', 'id', 'request_id'}:
        fail('legacy /send shape changed: %r' % (data,))
    if data.get('ok') is not True or type(data.get('id')) is not int or data.get('request_id') != rid:
        fail('unexpected /send response: %r' % (data,))


def withdraw_ok(data):
    rid = env('EXPECT_RID')
    try:
        mid = int(env('EXPECT_MID'))
    except ValueError:
        fail('EXPECT_MID is not an int')
    if not isinstance(data, dict) or set(data) != {'ok', 'id', 'request_id'}:
        fail('legacy /withdraw shape changed: %r' % (data,))
    if data.get('ok') is not True or data.get('id') != mid or data.get('request_id') != rid:
        fail('unexpected /withdraw response: %r' % (data,))


def legacy_timeline(data):
    if not isinstance(data, dict) or set(data) != {'items', 'session_id', 'session_api'}:
        fail('legacy /timeline shape changed: %r' % (data,))
    if data.get('session_id') != 'main':
        fail('legacy /timeline session_id=%r, expected main' % (data.get('session_id'),))
    if type(data.get('session_api')) is not int or data['session_api'] != 1:
        fail('legacy /timeline session_api=%r, expected 1' % (data.get('session_api'),))
    if not isinstance(data.get('items'), list):
        fail('legacy /timeline items is not a list')


def exact_item(data):
    rid = env('EXPECT_RID')
    text = env('EXPECT_TEXT')
    mid = int(env('EXPECT_MID'))
    items = data.get('items') if isinstance(data, dict) else None
    if not isinstance(items, list):
        fail('timeline items missing')
    matched = [item for item in items if isinstance(item, dict) and item.get('request_id') == rid]
    if len(matched) != 1:
        fail('request_id %r appears %d times, expected once' % (rid, len(matched)))
    item = matched[0]
    expected_keys = {'role', 'text', 'at', 'id', 'request_id', 'read_at', 'mentions'}
    if set(item) != expected_keys:
        fail('timeline item shape changed: %r' % (item,))
    expected = {'role': 'user', 'text': text, 'id': 'm%d' % mid, 'request_id': rid,
                'read_at': '', 'mentions': []}
    for key, value in expected.items():
        if item.get(key) != value:
            fail('timeline item %s=%r, expected %r' % (key, item.get(key), value))
    if not isinstance(item.get('at'), str) or not item['at']:
        fail('timeline item at is not a timestamp')


def contains(data):
    rid = env('EXPECT_RID')
    text = env('EXPECT_TEXT')
    items = data.get('items') if isinstance(data, dict) else None
    if not isinstance(items, list):
        fail('timeline items missing')
    matched = [item for item in items if isinstance(item, dict) and item.get('request_id') == rid]
    if len(matched) != 1:
        fail('request_id %r appears %d times, expected once' % (rid, len(matched)))
    item = matched[0]
    if item.get('text') != text or item.get('read_at') != '' or item.get('role') != 'user':
        fail('unexpected timeline item: %r' % (item,))


def excludes(data):
    rid = env('EXPECT_RID')
    items = data.get('items') if isinstance(data, dict) else None
    if not isinstance(items, list):
        fail('timeline items missing')
    for item in items:
        if isinstance(item, dict) and item.get('request_id') == rid:
            fail('request_id %r leaked into another session: %r' % (rid, item))


def capability(data):
    expected = env('EXPECT_SESSION')
    if not isinstance(data, dict):
        fail('capability response is not an object: %r' % (data,))
    if data.get('session_id') != expected:
        fail('session_id=%r, expected %r' % (data.get('session_id'), expected))
    api = data.get('session_api')
    if type(api) is not int or api != 1:
        fail('session_api=%r, expected 1' % (api,))


def no_capability(data):
    if not isinstance(data, dict):
        fail('legacy response is not an object: %r' % (data,))
    if 'session_id' in data or 'session_api' in data:
        fail('legacy response gained capability fields: %r' % (data,))


def error_exact(data):
    expected = {'error': env('EXPECT_ERROR')}
    if data != expected:
        fail('error body=%r, expected %r' % (data, expected))


def timeline_empty(data):
    if not isinstance(data, dict) or data.get('items') != []:
        fail('timeline expected to be empty: %r' % (data,))


def no_groups_state(data):
    if not isinstance(data, dict):
        fail('timeline response is not an object: %r' % (data,))
    for key in ('groups', 'groups_state', 'groups_reason'):
        if key in data:
            fail('gateway timeline grew a groups field: %s' % key)


def print_id(data):
    if not isinstance(data, dict) or type(data.get('id')) is not int:
        fail('response has no numeric id: %r' % (data,))
    print(data['id'])


def equal(path_a, path_b):
    if load(path_a) != load(path_b):
        fail('default and explicit main timelines differ')


def main():
    if len(sys.argv) < 3:
        fail('usage: s4check.py CHECK BODY [BODY2]')
    check, first = sys.argv[1], sys.argv[2]
    if check == 'equal':
        if len(sys.argv) != 4:
            fail('equal needs two body files')
        equal(first, sys.argv[3])
        return
    data = load(first)
    checks = {
        'send_ok': send_ok,
        'withdraw_ok': withdraw_ok,
        'legacy_timeline': legacy_timeline,
        'exact_item': exact_item,
        'contains': contains,
        'excludes': excludes,
        'capability': capability,
        'no_capability': no_capability,
        'error_exact': error_exact,
        'timeline_empty': timeline_empty,
        'no_groups_state': no_groups_state,
        'print_id': print_id,
    }
    if check not in checks:
        fail('unknown check: %s' % check)
    checks[check](data)


if __name__ == '__main__':
    main()
PY

cat > "$DBCHECK" <<'PY'
import sqlite3
import sys


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def main():
    if len(sys.argv) != 5:
        fail('usage: dbcheck.py DB CHECK RID SESSION')
    db, check, rid, session = sys.argv[1:5]
    connection = sqlite3.connect(db, timeout=10)
    try:
        rows = connection.execute(
            'SELECT conversation, request_id, read_at, withdrawn_at FROM messages WHERE request_id=?',
            (rid,)).fetchall()
        if check == 'queued':
            if len(rows) != 1:
                fail('%d rows for %r, expected 1' % (len(rows), rid))
            conversation, _, read_at, withdrawn_at = rows[0]
            if conversation != session:
                fail('message landed in %r, expected %r' % (conversation, session))
            if read_at not in (None, ''):
                fail('message was pulled (read_at=%r)' % (read_at,))
            if withdrawn_at not in (None, ''):
                fail('message was withdrawn: %r' % (withdrawn_at,))
        elif check == 'unconsumed':
            if len(rows) != 1:
                fail('%d rows for %r, expected 1' % (len(rows), rid))
            if rows[0][2] not in (None, ''):
                fail('read_at=%r; a Source already pulled this message' % (rows[0][2],))
        elif check == 'no_reply':
            count = connection.execute(
                'SELECT COUNT(*) FROM replies WHERE conversation=?', (session,)).fetchone()[0]
            if count:
                fail('%d replies in %r, no-dispatch evidence lost' % (count, session))
        elif check == 'not_in_main':
            count = connection.execute(
                "SELECT COUNT(*) FROM messages WHERE request_id=? AND conversation='main'",
                (rid,)).fetchone()[0]
            if count:
                fail('request_id %r leaked into main' % rid)
        else:
            fail('unknown check: %s' % check)
    finally:
        connection.close()


if __name__ == '__main__':
    main()
PY

cat > "$UNIT_RUNNER" <<'PY'
import os
import subprocess
import sys


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def main():
    if len(sys.argv) != 3:
        fail('usage: run_unit.py BACKEND_DIR SPEC')
    root, spec = sys.argv[1], sys.argv[2]
    command = [os.path.join(root, 'node_modules', '.bin', 'vitest'), 'run', 'tests/' + spec]
    try:
        done = subprocess.run(command, cwd=root, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=180)
    except subprocess.TimeoutExpired:
        fail('vitest timed out after 180s: %s' % spec)
    except OSError as error:
        fail('vitest could not start: %s' % error)
    output = done.stdout.decode('utf-8', 'replace')
    if done.returncode != 0:
        print(output[-4000:], file=sys.stderr)
        fail('vitest exit %d: %s' % (done.returncode, spec))
    print('vitest %s: PASS' % spec)


if __name__ == '__main__':
    main()
PY

for helper in "$JSONCHECK" "$DBCHECK" "$UNIT_RUNNER"; do
  [ -s "$helper" ] || { printf 'FAIL helper was not written: %s\n' "$helper" >&2; exit 1; }
  python3 -m py_compile "$helper" || { printf 'FAIL helper has Python syntax errors: %s\n' "$helper" >&2; exit 1; }
done

choose_port() {
  python3 - <<'PY'
import random
import socket
import sys

banned = {8788, 18787, 18799, 18801}
for port in random.sample(range(20000, 60000), 500):
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
    if [ "$(date +%s)" -ge "$deadline" ]; then
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

# http METHOD PATH [BODY] [EXTRA_HEADER]
http() {
  method=$1
  path=$2
  body=${3-}
  header=${4-}
  LAST_BODY=$(mktemp "$DSH_HOME/body.XXXXXX") || return 1
  : > "$CURL_ERR"
  if [ "$method" = GET ]; then
    if [ -n "$header" ]; then
      HTTP_STATUS=$(curl --noproxy '*' --globoff -sS --max-time 5 \
        -o "$LAST_BODY" -w '%{http_code}' -X GET \
        -H "X-GW-Token: $TOKEN" -H "$header" "$BASE$path" 2>"$CURL_ERR") || HTTP_STATUS=000
    else
      HTTP_STATUS=$(curl --noproxy '*' --globoff -sS --max-time 5 \
        -o "$LAST_BODY" -w '%{http_code}' -X GET \
        -H "X-GW-Token: $TOKEN" "$BASE$path" 2>"$CURL_ERR") || HTTP_STATUS=000
    fi
  else
    if [ -n "$header" ]; then
      HTTP_STATUS=$(curl --noproxy '*' --globoff -sS --max-time 5 \
        -o "$LAST_BODY" -w '%{http_code}' -X "$method" \
        -H "X-GW-Token: $TOKEN" -H 'Content-Type: application/json' -H "$header" \
        --data "$body" "$BASE$path" 2>"$CURL_ERR") || HTTP_STATUS=000
    else
      HTTP_STATUS=$(curl --noproxy '*' --globoff -sS --max-time 5 \
        -o "$LAST_BODY" -w '%{http_code}' -X "$method" \
        -H "X-GW-Token: $TOKEN" -H 'Content-Type: application/json' \
        --data "$body" "$BASE$path" 2>"$CURL_ERR") || HTTP_STATUS=000
    fi
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
  CHECKS=$((CHECKS + 1))
  if "$@"; then
    return 0
  fi
  printf '  FAIL %s\n' "$label" >&2
  return 1
}

# defer 与 defer_unit 是同一套语义：依赖未就位 -> 这条断言**没有被验证**。
# 非严格模式打印 SKIP（不是 PASS），只累加 DEFERRED；严格模式一律 FAIL，
# 绝不允许严格模式下出现 deferred（否则 S4_REQUIRE_HEADER=1 就失去了兜底意义）。
defer() {
  label=$1
  if [ "$STRICT_HEADER" = 1 ]; then
    printf '  FAIL %s (S4_REQUIRE_HEADER=1 但 x-crew-session 未被识别)\n' "$label" >&2
    return 1
  fi
  printf '  SKIP (deferred, NOT covered) %s — 等 A 合入后由 lead 以 S4_REQUIRE_HEADER=1 跑绿\n' "$label"
  DEFERRED=$((DEFERRED + 1))
  return 0
}

defer_unit() {
  label=$1
  if [ "$STRICT_HEADER" = 1 ]; then
    printf '  FAIL %s (S4_REQUIRE_HEADER=1 但单测文件不存在)\n' "$label" >&2
    return 1
  fi
  printf '  SKIP (deferred, NOT covered) %s — 等 B/C 单测文件合入后由 lead 跑绿\n' "$label"
  DEFERRED=$((DEFERRED + 1))
  return 0
}

unit() {
  spec=$1
  label=$2
  if [ ! -f "$ROOT/backend/tests/$spec" ]; then
    defer_unit "$label"
    return $?
  fi
  if ! command -v node >/dev/null 2>&1 || [ ! -x "$ROOT/backend/node_modules/.bin/vitest" ]; then
    printf '  FAIL %s (node / vitest 不可用)\n' "$label" >&2
    return 1
  fi
  CHECKS=$((CHECKS + 1))
  if python3 "$UNIT_RUNNER" "$ROOT/backend" "$spec" >"$UNIT_LOG" 2>&1; then
    printf '  PASS %s\n' "$label"
    return 0
  fi
  printf '  FAIL %s\n' "$label" >&2
  [ -s "$UNIT_LOG" ] && cat "$UNIT_LOG" >&2
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

check_invalid_query() {
  method=$1
  path=$2
  body=$3
  label=$4
  # 这里不用 record()（要断言状态码 + 错误体两件事），所以自己记两条断言数。
  CHECKS=$((CHECKS + 2))
  http "$method" "$path" "$body" || return 1
  expect_status 400 "$label" || return 1
  env EXPECT_ERROR=invalid_session python3 "$JSONCHECK" error_exact "$LAST_BODY"
}

probe_header() {
  # 两道只读探测，都不写队列：/health 看 _send 是否把能力位扩到 header，
  # /timeline 看 session_of 是否真的按 header 选会话（防止「只回显不分片」的假阳性）。
  health_ok=0
  timeline_ok=0
  http GET /health '' 'x-crew-session: s4-hdrprobe' || return 1
  if env EXPECT_SESSION=s4-hdrprobe python3 "$JSONCHECK" capability "$LAST_BODY" >/dev/null 2>&1; then
    health_ok=1
  fi
  http GET /timeline '' 'x-crew-session: s4-hdrprobe' || return 1
  if env EXPECT_SESSION=s4-hdrprobe python3 "$JSONCHECK" capability "$LAST_BODY" >/dev/null 2>&1; then
    timeline_ok=1
  fi
  if [ "$health_ok" = 1 ] && [ "$timeline_ok" = 1 ]; then
    HEADER_SUPPORTED=1
  else
    HEADER_SUPPORTED=0
  fi
  if [ "$HEADER_SUPPORTED" = 1 ]; then
    printf '  header capability probe: supported (/health + /timeline 均回显 s4-hdrprobe)\n'
  else
    printf '  header capability probe: not supported (health=%s timeline=%s; header 断言组 deferred)\n' "$health_ok" "$timeline_ok"
    if [ "$STRICT_HEADER" = 1 ]; then
      printf '  FAIL S4_REQUIRE_HEADER=1 但网关未识别 x-crew-session\n' >&2
      return 1
    fi
  fi
  return 0
}

g1_legacy_word_for_word() {
  rc=0
  http POST /send "{\"text\":\"$TEXT_LEGACY\",\"request_id\":\"$RID_LEGACY\"}" || rc=1
  record 'legacy /send status' expect_status 200 'legacy /send' || rc=1
  record 'legacy /send body 逐字不变' env EXPECT_RID="$RID_LEGACY" python3 "$JSONCHECK" send_ok "$LAST_BODY" || rc=1
  record 'legacy /send 无能力位字段' python3 "$JSONCHECK" no_capability "$LAST_BODY" || rc=1
  MID_LEGACY=$(capture_id "$LAST_BODY") || rc=1

  http GET /timeline || rc=1
  record 'legacy /timeline status' expect_status 200 'legacy /timeline' || rc=1
  record 'legacy /timeline 形状逐字不变' python3 "$JSONCHECK" legacy_timeline "$LAST_BODY" || rc=1
  record 'legacy /timeline 无新增群组状态' python3 "$JSONCHECK" no_groups_state "$LAST_BODY" || rc=1
  record 'legacy /timeline item 逐字不变' env EXPECT_RID="$RID_LEGACY" EXPECT_TEXT="$TEXT_LEGACY" EXPECT_MID="$MID_LEGACY" \
    python3 "$JSONCHECK" exact_item "$LAST_BODY" || rc=1

  http POST /withdraw "{\"request_id\":\"$RID_LEGACY\"}" || rc=1
  record 'legacy /withdraw status' expect_status 200 'legacy /withdraw' || rc=1
  record 'legacy /withdraw body' env EXPECT_RID="$RID_LEGACY" EXPECT_MID="$MID_LEGACY" \
    python3 "$JSONCHECK" withdraw_ok "$LAST_BODY" || rc=1

  http GET /timeline || rc=1
  record 'legacy cleanup timeline empty' python3 "$JSONCHECK" timeline_empty "$LAST_BODY" || rc=1

  http POST /send "{\"text\":\"$TEXT_DEFAULT\",\"request_id\":\"$RID_DEFAULT\"}" || rc=1
  record 'default /send status' expect_status 200 'default /send' || rc=1
  record 'default /send 无能力位字段' python3 "$JSONCHECK" no_capability "$LAST_BODY" || rc=1

  http POST '/send?session_id=main' "{\"text\":\"$TEXT_EXPLICIT\",\"request_id\":\"$RID_EXPLICIT\"}" || rc=1
  record 'explicit main /send status' expect_status 200 'explicit main /send' || rc=1
  record 'explicit main /send capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1

  http GET /timeline || rc=1
  TL_DEFAULT_BODY=$LAST_BODY
  record 'default /timeline capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$TL_DEFAULT_BODY" || rc=1

  http GET '/timeline?session_id=main' || rc=1
  TL_EXPLICIT_MAIN_BODY=$LAST_BODY
  record 'explicit main /timeline capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$TL_EXPLICIT_MAIN_BODY" || rc=1
  record 'default 与显式 main 时间线等价' python3 "$JSONCHECK" equal "$TL_DEFAULT_BODY" "$TL_EXPLICIT_MAIN_BODY" || rc=1
  return "$rc"
}

g2_query_form_and_isolation() {
  rc=0
  http POST "/send?session_id=$SESS_WORK" "{\"text\":\"$TEXT_WORK\",\"request_id\":\"$RID_WORK\"}" || rc=1
  record 'query /send status' expect_status 200 'query /send' || rc=1
  record 'query /send capability' env EXPECT_SESSION="$SESS_WORK" python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1

  http POST '/send?session_id=main' "{\"text\":\"$TEXT_MAIN\",\"request_id\":\"$RID_MAIN\"}" || rc=1
  record 'main /send status' expect_status 200 'main /send' || rc=1
  record 'main /send capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1

  http GET "/timeline?session_id=$SESS_WORK" || rc=1
  record 'work /timeline status' expect_status 200 'work /timeline' || rc=1
  record 'work /timeline 读回 query 消息' env EXPECT_RID="$RID_WORK" EXPECT_TEXT="$TEXT_WORK" \
    python3 "$JSONCHECK" contains "$LAST_BODY" || rc=1
  record 'work /timeline 不见 main 消息' env EXPECT_RID="$RID_MAIN" python3 "$JSONCHECK" excludes "$LAST_BODY" || rc=1

  http GET '/timeline?session_id=main' || rc=1
  record 'main /timeline capability' env EXPECT_SESSION=main python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1
  record 'main /timeline 不见 work 消息' env EXPECT_RID="$RID_WORK" python3 "$JSONCHECK" excludes "$LAST_BODY" || rc=1

  http POST "/claim?session_id=$SESS_WORK" '{"request_id":"s4-no-such-row"}' || rc=1
  record 'explicit /claim 404 status' expect_status 404 'explicit /claim missing' || rc=1
  record 'explicit /claim 错误响应也带能力位' env EXPECT_SESSION="$SESS_WORK" \
    python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1
  return "$rc"
}

g3_invalid_query_400() {
  rc=0
  check_invalid_query GET '/timeline?session_id=Work' '' '大写 session_id' || rc=1
  check_invalid_query POST '/send?session_id=a%20b' \
    "{\"text\":\"bad space\",\"request_id\":\"$RID_QUERY_ERR\"}" '含空格 session_id' || rc=1
  check_invalid_query POST "/withdraw?session_id=$LONG_SESSION" \
    "{\"request_id\":\"$RID_QUERY_ERR\"}" '超长 session_id' || rc=1
  return "$rc"
}

g4_header_form_conflict_and_capability() {
  rc=0
  if [ "$HEADER_SUPPORTED" != 1 ]; then
    defer 'header-only /send 落在 header 指定会话' || rc=1
    defer 'query 与 header 同值按 query 落库' || rc=1
    defer 'query 与 header 冲突 → 400 invalid_session 且不落库' || rc=1
    defer '非法 header 值 → 400 invalid_session' || rc=1
    defer 'header 请求的所有响应都带能力位' || rc=1
    defer 'header 错误响应也带能力位' || rc=1
    defer '老调用（两种载体都不带）逐字不变' || rc=1
    return "$rc"
  fi

  http POST /send "{\"text\":\"$TEXT_HEADER\",\"request_id\":\"$RID_HEADER\"}" "x-crew-session: $SESS_WORK" || rc=1
  record 'header-only /send status' expect_status 200 'header-only /send' || rc=1
  record 'header-only /send capability' env EXPECT_SESSION="$SESS_WORK" \
    python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1
  http GET "/timeline?session_id=$SESS_WORK" || rc=1
  record 'header 消息落在 header 指定会话' env EXPECT_RID="$RID_HEADER" EXPECT_TEXT="$TEXT_HEADER" \
    python3 "$JSONCHECK" contains "$LAST_BODY" || rc=1

  http POST "/send?session_id=$SESS_WORK" \
    "{\"text\":\"$TEXT_HEADER_SAME\",\"request_id\":\"$RID_HEADER_SAME\"}" \
    "x-crew-session: $SESS_WORK" || rc=1
  record 'query+header 同值 status' expect_status 200 'query+header same' || rc=1
  record 'query+header 同值 capability' env EXPECT_SESSION="$SESS_WORK" \
    python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1

  http POST "/send?session_id=$SESS_WORK" "{\"text\":\"conflict\",\"request_id\":\"$RID_CONFLICT\"}" \
    'x-crew-session: ops' || rc=1
  record 'query/header 冲突 400' expect_status 400 'query/header conflict' || rc=1
  record 'query/header 冲突错误体' env EXPECT_ERROR=invalid_session \
    python3 "$JSONCHECK" error_exact "$LAST_BODY" || rc=1
  http GET "/timeline?session_id=$SESS_WORK" || rc=1
  record '冲突请求未落 work' env EXPECT_RID="$RID_CONFLICT" python3 "$JSONCHECK" excludes "$LAST_BODY" || rc=1
  http GET '/timeline?session_id=ops' || rc=1
  record '冲突请求未落 ops' env EXPECT_RID="$RID_CONFLICT" python3 "$JSONCHECK" excludes "$LAST_BODY" || rc=1

  http GET /timeline '' 'x-crew-session: Work' || rc=1
  record '非法 header 400' expect_status 400 'illegal header' || rc=1
  record '非法 header 错误体' env EXPECT_ERROR=invalid_session \
    python3 "$JSONCHECK" error_exact "$LAST_BODY" || rc=1

  http POST /send "{\"text\":\"header-cap\",\"request_id\":\"$RID_HEADER_BAD\"}" \
    "x-crew-session: $SESS_WORK" || rc=1
  record 'header /send 响应带能力位' env EXPECT_SESSION="$SESS_WORK" \
    python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1
  http POST /claim '{"request_id":"s4-no-such-row"}' "x-crew-session: $SESS_WORK" || rc=1
  record 'header /claim 404 status' expect_status 404 'header /claim missing' || rc=1
  record 'header 错误响应带能力位' env EXPECT_SESSION="$SESS_WORK" \
    python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1

  http POST /send '{"text":"legacy-after-header","request_id":"s4-legacy-after-header"}' || rc=1
  record '老调用 /send 无能力位字段' python3 "$JSONCHECK" no_capability "$LAST_BODY" || rc=1
  return "$rc"
}

g5_unregistered_session_transport_evidence() {
  rc=0
  http POST "/send?session_id=$SESS_UNREG" "{\"text\":\"$TEXT_UNREG\",\"request_id\":\"$RID_UNREG\"}" || rc=1
  record '未登记 /send status' expect_status 200 'unregistered /send' || rc=1
  record '未登记 /send capability' env EXPECT_SESSION="$SESS_UNREG" \
    python3 "$JSONCHECK" capability "$LAST_BODY" || rc=1

  record '断言 1 落队列：mobileq.db 有该 conversation 的行' \
    python3 "$DBCHECK" "$DB" queued "$RID_UNREG" "$SESS_UNREG" || rc=1

  http GET "/timeline?session_id=$SESS_UNREG" || rc=1
  record '断言 2 可读：timeline 读回该消息，不凭空消失' \
    env EXPECT_RID="$RID_UNREG" EXPECT_TEXT="$TEXT_UNREG" python3 "$JSONCHECK" contains "$LAST_BODY" || rc=1

  http GET /timeline || rc=1
  record '未登记消息不串进 main' env EXPECT_RID="$RID_UNREG" \
    python3 "$JSONCHECK" excludes "$LAST_BODY" || rc=1
  record '断言 3 不派单证据：read_at 为空、未被 Source 拉走' \
    python3 "$DBCHECK" "$DB" unconsumed "$RID_UNREG" "$SESS_UNREG" || rc=1
  record '断言 3 不派单证据：该会话无回复行（无 Ticket 回写）' \
    python3 "$DBCHECK" "$DB" no_reply "$RID_UNREG" "$SESS_UNREG" || rc=1
  record '未登记消息没有落进 main 列' \
    python3 "$DBCHECK" "$DB" not_in_main "$RID_UNREG" "$SESS_UNREG" || rc=1
  printf '  NOTE scope() 的 conversation_not_listed 可观测记录与断言 4 注册即生效由下一组单测桥接覆盖\n'
  return "$rc"
}

g6_scope_admission_unit_bridge() {
  unit 'source-session-admission.spec.ts' \
    '断言 3/4：scope() 的 conversation_not_listed 可观测记录与注册即生效'
}

g7_groups_readonly_projection() {
  rc=0
  unit 'groups.spec.ts' '群组三态 live/empty/unavailable 与 groups[] 结构' || rc=1
  http POST /groups '{}' || rc=1
  record '网关没有群组写路由（只读）' expect_status 404 'POST /groups' || rc=1
  http GET /timeline || rc=1
  record '网关 timeline 零新增群组持久化状态' python3 "$JSONCHECK" no_groups_state "$LAST_BODY" || rc=1
  printf '  NOTE groups 只读字段在 GET /api/mobile/timeline 由 lead 合入后验；unavailable 态由 C 单测覆盖\n'
  return "$rc"
}

run_group() {
  number=$1
  title=$2
  fn=$3
  printf '%s. %s\n' "$number" "$title"
  TOTAL_GROUPS=$((TOTAL_GROUPS + 1))
  before_deferred=$DEFERRED
  before_checks=$CHECKS
  if "$fn"; then
    skipped=$((DEFERRED - before_deferred))
    ran=$((CHECKS - before_checks))
    if [ "$skipped" -gt 0 ] && [ "$ran" -eq 0 ]; then
      printf 'SKIP %s. %s (%s assertions NOT covered)\n' "$number" "$title" "$skipped"
      SKIP_GROUPS=$((SKIP_GROUPS + 1))
    elif [ "$skipped" -gt 0 ]; then
      printf 'PARTIAL %s. %s (%s ran PASS, %s assertions NOT covered)\n' \
        "$number" "$title" "$ran" "$skipped"
      PARTIAL_GROUPS=$((PARTIAL_GROUPS + 1))
    else
      printf 'PASS %s. %s (%s assertions)\n' "$number" "$title" "$ran"
      PASS_GROUPS=$((PASS_GROUPS + 1))
    fi
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
printf 'fixture: DSH_HOME=%s MOBILEGW_PORT=%s (production db/token untouched)\n' "$DSH_HOME" "$MOBILEGW_PORT"
probe_header || {
  printf 'FAIL header capability probe failed\n' >&2
  exit 1
}

run_group 1 '老调用逐字不变；缺省与显式 main 等价' g1_legacy_word_for_word
run_group 2 'query 形态、按会话隔离、显式请求所有响应带能力位' g2_query_form_and_isolation
run_group 3 '非法 query session_id 一律 400 invalid_session' g3_invalid_query_400
run_group 4 'header 形态 / query 优先 / 冲突 400 / 非法 400 / header 响应能力位' g4_header_form_conflict_and_capability
run_group 5 '未登记会话四条断言中 curl 可表达的证据（落队列 / 可读 / 不派单）' g5_unregistered_session_transport_evidence
run_group 6 'B 单测桥接：scope() 可观测记录与注册即生效' g6_scope_admission_unit_bridge
run_group 7 '群组只读投影：三态单测桥接、只读、零新增 Ticket 账' g7_groups_readonly_projection

if [ "$FAILURES" -ne 0 ]; then
  printf 'FAIL %s group(s) failed\n' "$FAILURES" >&2
  if [ "$DEFERRED" -ne 0 ]; then
    printf 'NOTE 另有 %s assertion(s) NOT covered (deferred) — 修好失败项也不代表本次运行完整覆盖\n' \
      "$DEFERRED" >&2
  fi
  exit 1
fi
if [ "$DEFERRED" -ne 0 ]; then
  printf 'INCOMPLETE all %s groups ran: %s PASS, %s PARTIAL, %s SKIP; %s assertions ran PASS, %s assertions NOT covered\n' \
    "$TOTAL_GROUPS" "$PASS_GROUPS" "$PARTIAL_GROUPS" "$SKIP_GROUPS" "$CHECKS" "$DEFERRED"
  printf 'INCOMPLETE 依赖未合入的断言未被验证：header 组请以 S4_REQUIRE_HEADER=1 跑绿，B/C 单测需先合入对应 spec\n'
  printf 'INCOMPLETE 退出码 0 只代表「已真跑的 %s 条断言全通过」，不代表 7 组全覆盖\n' "$CHECKS"
  exit 0
fi
printf 'PASS all %s groups (%s assertions, 0 deferred)\n' "$TOTAL_GROUPS" "$CHECKS"
exit 0
