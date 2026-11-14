#!/bin/sh
# S2/S3 新客户端视角协议验收（唯一契约 /tmp/s2s3-contract.md §7）。
# 只起自己管理的临时 mobilegw + 一个「老网关」stub，用 curl 走一遍新客户端的 HTTP 序列。
# 用法：sh scripts/test-session-client-protocol.sh   （可在仓库根重复运行）
#
# 边界：
# - 网关层没有 /api/mobile/sessions（名单与创建在消息面，见 §7 第 1 条），脚本用 404 表达该形态，
#   网关层只验能力位、会话分片、错误码与老调用兼容。
# - 「老网关模拟」= stub 的响应缺 session_api；客户端先验能力位后停发非 main、锁 main。
#   「用现有 409 证据表达」= 后端 backend/src/app/mobile-http.ts:980-981 的 409 分支 +
#   backend/tests/mobile-http.spec.ts:828-858 的两条 409 用例，以及按该分支做的转发判定模拟。
# - 绝不读写 ~/.dsh/state/superagent/mobileq.db 与生产 mobilegw.token；trap 只清自己起的进程与临时目录。
set -u

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P) || exit 1
ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd -P) || exit 1
GW="$ROOT/backend/tools/mobilegw"
SOURCE="$ROOT/backend/src/app/mobile-http.ts"
SPEC="$ROOT/backend/tests/mobile-http.spec.ts"

for tool in python3 curl mktemp env dirname date sleep cat; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'FAIL missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ -f "$GW" ] || { printf 'FAIL missing gateway: %s\n' "$GW" >&2; exit 1; }
[ -f "$SOURCE" ] || { printf 'FAIL missing 409 evidence source: %s\n' "$SOURCE" >&2; exit 1; }
[ -f "$SPEC" ] || { printf 'FAIL missing 409 evidence spec: %s\n' "$SPEC" >&2; exit 1; }

# ---- 独立夹具：DSH_HOME 全临时，端口随机且避开 8788 / 18787 / 18799 ----
DSH_HOME=$(mktemp -d "${TMPDIR:-/tmp}/s2s3-client-protocol.XXXXXX") || {
  printf 'FAIL mktemp -d failed\n' >&2
  exit 1
}
STATE="$DSH_HOME/state/superagent"
TOKEN_FILE="$STATE/mobilegw.token"
DB_FILE="$STATE/mobileq.db"
GW_LOG="$DSH_HOME/mobilegw.log"
OLDGW_PY="$DSH_HOME/oldgw.py"
OLDGW_LOG="$DSH_HOME/oldgw.log"
OLDGW_REQUESTS="$DSH_HOME/oldgw.requests"
CURL_ERR="$DSH_HOME/curl.err"
HELPER="$DSH_HOME/helper.py"
CAP_MANIFEST="$DSH_HOME/capability-bodies.txt"
OLD_RESPONSE="$DSH_HOME/old-response.body"
: > "$CAP_MANIFEST" || { printf 'FAIL capability manifest init\n' >&2; exit 1; }

GW_PID=
OLDGW_PID=
MOBILEGW_PORT=
OLDGW_PORT=
BASE=
OLD_BASE=
TOKEN=
EXTRA_HEADER=
HTTP_STATUS=000
LAST_BODY=
FAILURES=0
CHECK_NO=0
GROUP_FAILURES=0
HEALTH_TIMEOUT=20

# 新客户端使用的会话与幂等键（固定字面值，让断言的期望值来自契约而非运行时推算）。
RID_A=s2s3-A
TEXT_A=A
RID_B=s2s3-B
TEXT_B=B
RID_SAME=s2s3-same-request-id
TEXT_SAME_MAIN=same-in-main
TEXT_SAME_WORK=same-in-work
RID_MAIN_ONLY=s2s3-main-only
RID_WORK_ONLY=s2s3-work-only
RID_DEFAULT=s2s3-default
RID_EXPLICIT=s2s3-explicit-main
RID_BODY_ONLY=s2s3-body-only
RID_HEADER_ONLY=s2s3-header-only
RID_HDR_WORK=s2s3-hdr-work
RID_HDR_SAME=s2s3-hdr-same
RID_HDR_CONFLICT=s2s3-hdr-conflict
RID_HDR_BAD=s2s3-hdr-bad
RID_HDR_LEGACY=s2s3-hdr-legacy
RID_STRAIGHT=s2s3-straight-send
RID_CLAIM_OK=s2s3-claim-ok
RID_WITHDRAW_OK=s2s3-withdraw-ok
RID_BAD_SPACE=s2s3-bad-space
RID_BAD_LONG=s2s3-bad-long
LONG_SESSION=
MID_A=
MID_B=
TL_DEFAULT_BODY=
TL_EXPLICIT_MAIN_BODY=

cleanup() {
  rc=$?
  trap - 0 1 2 3 15
  for pid in "$GW_PID" "$OLDGW_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || :
      wait "$pid" 2>/dev/null || :
    fi
  done
  if [ -n "$DSH_HOME" ] && [ -d "$DSH_HOME" ]; then
    rm -rf "$DSH_HOME"
  fi
  exit "$rc"
}
trap cleanup 0 1 2 3 15

# ---- 断言/夹具 helper（纯 Python，落在临时目录，trap 一并清掉）----
cat > "$HELPER" <<'PY'
import json
import os
import random
import socket
import sys
from urllib.parse import parse_qs, urlsplit


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def load(path):
    try:
        with open(path, 'r', encoding='utf-8') as stream:
            return json.load(stream)
    except (OSError, ValueError) as error:
        fail('bad JSON body %s: %s' % (path, error))


def capability(data, expected_session):
    if not isinstance(data, dict):
        fail('capability response is not an object: %r' % (data,))
    if data.get('session_id') != expected_session:
        fail('session_id=%r, expected %r' % (data.get('session_id'), expected_session))
    api = data.get('session_api')
    if type(api) is not int or api != 1:  # bool is an int in Python; reject it explicitly
        fail('session_api=%r, expected int 1' % (api,))


def capability_all(path):
    lines = [line.rstrip('\n') for line in open(path, encoding='utf-8') if line.strip()]
    if not lines:
        fail('capability manifest is empty')
    for line in lines:
        parts = line.split('\t')
        if len(parts) != 2:
            fail('bad manifest line: %r' % (line,))
        capability(load(parts[1]), parts[0])
    print('capability_all: %d explicit-session responses carry session_api=1' % len(lines))


def no_capability(data):
    if not isinstance(data, dict):
        fail('legacy response is not an object: %r' % (data,))
    if 'session_id' in data or 'session_api' in data:
        fail('legacy response gained capability fields: %r' % (data,))


def exact_keys(data, keys):
    if not isinstance(data, dict) or set(data) != set(keys.split(',')):
        fail('top-level keys=%r, expected %r' % (sorted(data) if isinstance(data, dict) else data, keys))


def exact_error(data, code):
    if data != {'error': code}:
        fail('error body=%r, expected {"error": %r}' % (data, code))


def has_error(data, code):
    if not isinstance(data, dict) or data.get('error') != code:
        fail('error body=%r, expected error=%r' % (data, code))


def send_ok(data, rid):
    if not isinstance(data, dict) or not {'ok', 'id', 'request_id'}.issubset(data):
        fail('send response missing required fields: %r' % (data,))
    if data.get('ok') is not True or type(data.get('id')) is not int or data.get('request_id') != rid:
        fail('unexpected send response: %r' % (data,))


def print_id(data):
    if not isinstance(data, dict) or type(data.get('id')) is not int:
        fail('response has no numeric id: %r' % (data,))
    print(data['id'])


def exact_item(data, rid, text, mid):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        fail('timeline items missing: %r' % (data,))
    items = data['items']
    if len(items) != 1:
        fail('timeline item count %d, expected 1: %r' % (len(items), items))
    item = items[0]
    expected_keys = {'role', 'text', 'at', 'id', 'request_id', 'read_at', 'mentions'}
    if not isinstance(item, dict) or set(item) != expected_keys:
        fail('timeline item shape changed: %r' % (item,))
    expected = {'role': 'user', 'text': text, 'id': 'm%d' % int(mid),
                'request_id': rid, 'read_at': '', 'mentions': []}
    for key, value in expected.items():
        if item.get(key) != value:
            fail('timeline item %s=%r, expected %r' % (key, item.get(key), value))
    if not isinstance(item.get('at'), str) or not item['at']:
        fail('timeline item at is not a timestamp string: %r' % (item.get('at'),))


def item_shapes(data):
    """老调用 timeline 的 item 形状逐字不变：七键、不多不少。"""
    if not isinstance(data, dict) or not isinstance(data.get('items'), list) or not data['items']:
        fail('item_shapes: no items in %r' % (data,))
    expected = {'role', 'text', 'at', 'id', 'request_id', 'read_at', 'mentions'}
    for item in data['items']:
        if not isinstance(item, dict) or set(item) != expected:
            fail('timeline item shape changed: %r' % (item,))


def contains_rids(data, rids):
    wanted = [rid for rid in rids.split(',') if rid]
    if not wanted or not isinstance(data, dict) or not isinstance(data.get('items'), list):
        fail('contains_rids: bad input %r' % (data,))
    for rid in wanted:
        seen = sum(1 for item in data['items'] if isinstance(item, dict) and item.get('request_id') == rid)
        if seen != 1:
            fail('request_id %r appears %d times, expected once' % (rid, seen))


def excludes(data, rids, texts):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        fail('excludes: bad input %r' % (data,))
    bad_rids = set(rid for rid in rids.split(',') if rid)
    bad_texts = set(text for text in texts.split(',') if text)
    for item in data['items']:
        if not isinstance(item, dict):
            continue
        if item.get('request_id') in bad_rids or item.get('text') in bad_texts:
            fail('other session leaked into timeline: %r' % (item,))


def equal(path_a, path_b):
    body_a, body_b = load(path_a), load(path_b)
    if body_a != body_b:
        fail('default and explicit main timeline bodies differ:\n%s\n%s' % (body_a, body_b))


def decision(status, body):
    """新客户端能力位先验：只有 200 + session_api:1 才启用会话切换。"""
    code = int(status)
    if code == 200:
        data = load(body)
        ok = isinstance(data, dict) and type(data.get('session_api')) is int and data['session_api'] == 1
        print('multi' if ok else 'lock-main')
        return
    if code in (404, 409, 000):
        if code == 409:
            data = load(body)
            if data != {'error': 'unsupported_session'}:
                fail('409 body is not unsupported_session: %r' % (data,))
        print('lock-main')
        return
    print('show-error')


def relay_verdict(session, body, want_status, want_error):
    """按 mobile-http.ts:980-981 的分支判定转发结果：显式非 main + 缺 session_api -> 409。"""
    data = load(body)
    refused = session and session != 'main' and data.get('session_api') != 1
    status = 409 if refused else 200
    error = 'unsupported_session' if refused else ''
    if str(status) != want_status or error != want_error:
        fail('relay verdict=(%s,%r), expected (%s,%r)' % (status, error, want_status, want_error))
    print('relay verdict: session=%s -> HTTP %s %s' % (session, status, error or '(pass)'))


def no_nonmain(path):
    lines = [line.strip() for line in open(path, encoding='utf-8') if line.strip()]
    bad = []
    for line in lines:
        values = parse_qs(urlsplit(line).query, keep_blank_values=True).get('session_id') or []
        if any(value != 'main' for value in values):
            bad.append(line)
    if bad:
        fail('non-main requests were sent to the old gateway: %r' % (bad,))
    print('old gateway saw %d request(s), 0 non-main' % len(lines))


def source_evidence(source_path, spec_path):
    src = open(source_path, encoding='utf-8').read().splitlines()
    spec = open(spec_path, encoding='utf-8').read().splitlines()
    guard = [i + 1 for i, line in enumerate(src) if 'data.session_api !== SESSION_API' in line]
    # 409 可能走裸 response，也可能走统一注入点 reply（能力位判据一处）；
    # 两种都算证据，否则把实现重构成 reply 之后这条就假红了。
    conflict = [i + 1 for i, line in enumerate(src)
                if ("response(409, { error: 'unsupported_session' })" in line
                    or "reply(409, { error: 'unsupported_session' })" in line)]
    # 证据必须是**成对**的：某个 session_api 守卫行，紧跟其后的几行里就有 409 unsupported_session。
    # 不能要求「文件里第一个 409 在守卫之后」—— 源码现在有两处 409（steer 内联分支 + 统一先验），
    # 位置先后会随重构变动，那种写法会把「有守卫的 409」误判成缺失。按邻近成对匹配才是
    # 真正想断言的东西：这个 409 是由能力位守卫触发的，而不是别处顺手回的。
    pairs = [(g, c) for g in guard for c in conflict if 0 < c - g <= 6]
    # 只认「409 + unsupported_session」那一对断言，别把文件里别的 409 用例当证据。
    tests_409 = [i + 1 for i, line in enumerate(spec)
                 if 'toBe(409)' in line
                 and any('unsupported_session' in spec[j]
                         for j in range(max(0, i - 2), min(len(spec), i + 3)))]
    tests_code = [i + 1 for i, line in enumerate(spec) if "error: 'unsupported_session'" in line]
    if not pairs:
        fail('409 guard/branch pair missing in %s (guards=%r, 409s=%r)' % (source_path, guard, conflict))
    if len(tests_409) < 2 or len(tests_code) < 2:
        fail('409 spec coverage missing in %s' % spec_path)
    print('evidence: mobile-http.ts:%s guard -> :%s 409; mobile-http.spec.ts:%s,%s 409 tests'
          % (pairs[0][0], pairs[0][1], tests_409[0], tests_409[1]))


def choose_port(excludes):
    banned = {8788, 18787, 18799}
    skip = set(int(value) for value in excludes if value) | banned
    for port in random.sample(range(20000, 60000), 500):
        if port in skip:
            continue
        sock = socket.socket()
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            continue
        finally:
            sock.close()
        print(port)
        return
    fail('no free port')


def assert_ports(ports):
    banned = {8788, 18787, 18799}
    values = [int(value) for value in ports if value]
    if any(value in banned for value in values):
        fail('banned port in use: %r' % (values,))
    if len(values) != len(set(values)):
        fail('fixture ports are not distinct: %r' % (values,))
    print('ports: %s (8788/18787/18799 avoided, distinct)' % ','.join(str(v) for v in values))


def assert_fixture(home, state, token, db):
    home = os.path.realpath(home)
    for path in (state, token, db):
        real = os.path.realpath(path)
        if not real.startswith(home + os.sep) or not os.path.exists(real):
            fail('fixture path escapes DSH_HOME or is missing: %s' % path)
    production = os.path.realpath(os.path.expanduser('~/.dsh/state/superagent/mobileq.db'))
    if production.startswith(home + os.sep):
        fail('production db resolves inside fixture home')
    print('fixture: isolated DSH_HOME=%s (production db untouched)' % home)


def port_closed(port):
    sock = socket.socket()
    sock.settimeout(0.2)
    try:
        return sock.connect_ex(('127.0.0.1', int(port))) != 0
    finally:
        sock.close()


def processes_gone(pids):
    for pid in [value for value in pids if value]:
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            fail('pid %s still exists (permission denied)' % pid)
        fail('pid %s is still alive' % pid)
    print('processes gone: %s' % ','.join(pids))


def main():
    argv = sys.argv[1:]
    if not argv:
        fail('usage: helper.py CHECK ...')
    check, args = argv[0], argv[1:]
    if check == 'capability':
        capability(load(args[0]), args[1])
    elif check == 'capability_all':
        capability_all(args[0])
    elif check == 'no_capability':
        no_capability(load(args[0]))
    elif check == 'exact_keys':
        exact_keys(load(args[0]), args[1])
    elif check == 'exact_error':
        exact_error(load(args[0]), args[1])
    elif check == 'has_error':
        has_error(load(args[0]), args[1])
    elif check == 'send_ok':
        send_ok(load(args[0]), args[1])
    elif check == 'print_id':
        print_id(load(args[0]))
    elif check == 'exact_item':
        exact_item(load(args[0]), args[1], args[2], args[3])
    elif check == 'item_shapes':
        item_shapes(load(args[0]))
    elif check == 'contains_rids':
        contains_rids(load(args[0]), args[1])
    elif check == 'excludes':
        excludes(load(args[0]), args[1], args[2])
    elif check == 'equal':
        equal(args[0], args[1])
    elif check == 'decision':
        decision(args[0], args[1])
    elif check == 'relay_verdict':
        relay_verdict(args[0], args[1], args[2], args[3])
    elif check == 'no_nonmain':
        no_nonmain(args[0])
    elif check == 'source_evidence':
        source_evidence(args[0], args[1])
    elif check == 'choose_port':
        choose_port(args)
    elif check == 'assert_ports':
        assert_ports(args)
    elif check == 'assert_fixture':
        assert_fixture(*args[:4])
    elif check == 'port_closed':
        sys.exit(0 if port_closed(args[0]) else 1)
    elif check == 'processes_gone':
        processes_gone(args)
    else:
        fail('unknown check: %s' % check)


if __name__ == '__main__':
    main()
PY
[ -s "$HELPER" ] || { printf 'FAIL helper was not written\n' >&2; exit 1; }
python3 -m py_compile "$HELPER" || { printf 'FAIL helper has Python syntax errors\n' >&2; exit 1; }
LONG_SESSION=$(python3 -c 'print("a" * 33)') || { printf 'FAIL long session_id generation failed\n' >&2; exit 1; }

# ---- 启动 / 等待真的 listen（轮询 + deadline，不用固定 sleep 赌）----
wait_health() {
  base=$1
  pid=$2
  log=$3
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    if curl --noproxy '*' --globoff -fsS --max-time 1 "$base/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '  FAIL gateway pid %s exited before /health was reachable\n' "$pid" >&2
      [ -s "$log" ] && cat "$log" >&2
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf '  FAIL /health timeout after %ss on %s\n' "$HEALTH_TIMEOUT" "$base" >&2
      [ -s "$log" ] && cat "$log" >&2
      return 1
    fi
    sleep 0.1
  done
}

wait_token() {
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    if [ -s "$TOKEN_FILE" ]; then
      TOKEN=$(cat "$TOKEN_FILE")
      [ -n "$TOKEN" ] && return 0
    fi
    if ! kill -0 "$GW_PID" 2>/dev/null; then
      printf '  FAIL mobilegw exited before the token appeared\n' >&2
      [ -s "$GW_LOG" ] && cat "$GW_LOG" >&2
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf '  FAIL token timeout after %ss\n' "$HEALTH_TIMEOUT" >&2
      return 1
    fi
    sleep 0.1
  done
}

start_gateway() {
  attempt=1
  while [ "$attempt" -le 5 ]; do
    MOBILEGW_PORT=$(python3 "$HELPER" choose_port "$OLDGW_PORT") || return 1
    case "$MOBILEGW_PORT" in
      ''|*[!0-9]*) attempt=$((attempt + 1)); continue ;;
    esac
    BASE="http://127.0.0.1:$MOBILEGW_PORT"
    : > "$GW_LOG"
    env "DSH_HOME=$DSH_HOME" "MOBILEGW_STATE=$STATE" \
      MOBILEGW_HOST=127.0.0.1 "MOBILEGW_PORT=$MOBILEGW_PORT" MOBILEGW_CONV=main \
      PYTHONUNBUFFERED=1 python3 "$GW" >"$GW_LOG" 2>&1 &
    GW_PID=$!
    if wait_health "$BASE" "$GW_PID" "$GW_LOG" && wait_token; then
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

# 老网关 stub：任何响应都不带 session_id / session_api，并记录收到的路径。
start_old_gateway() {
  cat > "$OLDGW_PY" <<'PY'
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

LOG = os.environ['OLDGW_REQUESTS']
PORT = int(sys.argv[1])


class H(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _record(self):
        with open(LOG, 'a', encoding='utf-8') as stream:
            stream.write(self.path + '\n')

    def _send(self, code, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._record()
        path = urlsplit(self.path).path
        if path == '/health':
            return self._send(200, {'ok': True})
        if path == '/timeline':
            # C4 形态：老网关全程 200，不回显能力位，且把非 main 静默当 main 读写。
            return self._send(200, {'items': []})
        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        self._record()
        return self._send(200, {'ok': True, 'id': 1, 'request_id': 'old-gw'})


ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
  [ -s "$OLDGW_PY" ] || { printf '  FAIL old gateway stub was not written\n' >&2; return 1; }
  python3 -m py_compile "$OLDGW_PY" || { printf '  FAIL old gateway stub has syntax errors\n' >&2; return 1; }
  : > "$OLDGW_REQUESTS"
  attempt=1
  while [ "$attempt" -le 5 ]; do
    OLDGW_PORT=$(python3 "$HELPER" choose_port "$MOBILEGW_PORT") || return 1
    case "$OLDGW_PORT" in
      ''|*[!0-9]*) attempt=$((attempt + 1)); continue ;;
    esac
    OLD_BASE="http://127.0.0.1:$OLDGW_PORT"
    : > "$OLDGW_LOG"
    env "OLDGW_REQUESTS=$OLDGW_REQUESTS" PYTHONUNBUFFERED=1 \
      python3 "$OLDGW_PY" "$OLDGW_PORT" >"$OLDGW_LOG" 2>&1 &
    OLDGW_PID=$!
    if wait_health "$OLD_BASE" "$OLDGW_PID" "$OLDGW_LOG"; then
      return 0
    fi
    printf '  old gateway start attempt %s was not healthy; retrying with a fresh port\n' "$attempt" >&2
    kill "$OLDGW_PID" 2>/dev/null || :
    wait "$OLDGW_PID" 2>/dev/null || :
    OLDGW_PID=
    attempt=$((attempt + 1))
  done
  return 1
}

# ---- HTTP 与断言输出：每条一行 PASS/FAIL ----
http_call() {
  base=$1
  method=$2
  path=$3
  body=${4-}
  extra=${EXTRA_HEADER:-}
  EXTRA_HEADER=
  LAST_BODY=$(mktemp "$DSH_HOME/body.XXXXXX") || return 1
  : > "$CURL_ERR"
  set -- curl --noproxy '*' --globoff -sS --max-time 5 \
    -o "$LAST_BODY" -w '%{http_code}' -X "$method" -H "X-GW-Token: $TOKEN"
  if [ -n "$extra" ]; then set -- "$@" -H "$extra"; fi
  if [ "$method" != GET ]; then
    set -- "$@" -H 'Content-Type: application/json' --data "$body"
  fi
  set -- "$@" "$base$path"
  HTTP_STATUS=$("$@" 2>"$CURL_ERR") || HTTP_STATUS=000
  [ -n "$HTTP_STATUS" ] && [ "$HTTP_STATUS" != 000 ] && [ -s "$LAST_BODY" ]
}

request() {
  label=$1
  method=$2
  path=$3
  body=${4-}
  CHECK_NO=$((CHECK_NO + 1))
  if http_call "$BASE" "$method" "$path" "$body"; then
    printf 'PASS [%s] %s %s -> HTTP %s\n' "$CHECK_NO" "$label" "$path" "$HTTP_STATUS"
    return 0
  fi
  printf 'FAIL [%s] %s %s (curl/status %s)\n' "$CHECK_NO" "$label" "$path" "$HTTP_STATUS" >&2
  [ -s "$CURL_ERR" ] && cat "$CURL_ERR" >&2
  FAILURES=$((FAILURES + 1))
  return 1
}

old_request() {
  label=$1
  method=$2
  path=$3
  body=${4-}
  CHECK_NO=$((CHECK_NO + 1))
  if http_call "$OLD_BASE" "$method" "$path" "$body"; then
    printf 'PASS [%s] %s %s -> HTTP %s (old gateway)\n' "$CHECK_NO" "$label" "$path" "$HTTP_STATUS"
    return 0
  fi
  printf 'FAIL [%s] %s %s (curl/status %s)\n' "$CHECK_NO" "$label" "$path" "$HTTP_STATUS" >&2
  [ -s "$CURL_ERR" ] && cat "$CURL_ERR" >&2
  FAILURES=$((FAILURES + 1))
  return 1
}

expect() {
  label=$1
  want=$2
  shift 2
  CHECK_NO=$((CHECK_NO + 1))
  if [ "$HTTP_STATUS" = "$want" ] && "$@"; then
    printf 'PASS [%s] %s (HTTP %s)\n' "$CHECK_NO" "$label" "$HTTP_STATUS"
    return 0
  fi
  printf 'FAIL [%s] %s (HTTP %s, expected %s)\n' "$CHECK_NO" "$label" "$HTTP_STATUS" "$want" >&2
  if [ -n "$LAST_BODY" ] && [ -s "$LAST_BODY" ]; then
    printf '  body: ' >&2
    cat "$LAST_BODY" >&2
    printf '\n' >&2
  fi
  FAILURES=$((FAILURES + 1))
  return 1
}

check() {
  label=$1
  shift
  CHECK_NO=$((CHECK_NO + 1))
  if "$@"; then
    printf 'PASS [%s] %s\n' "$CHECK_NO" "$label"
    return 0
  fi
  printf 'FAIL [%s] %s\n' "$CHECK_NO" "$label" >&2
  FAILURES=$((FAILURES + 1))
  return 1
}

expect_decision() {
  label=$1
  want=$2
  status=$3
  body=$4
  CHECK_NO=$((CHECK_NO + 1))
  got=$(python3 "$HELPER" decision "$status" "$body") || got=ERROR
  if [ "$got" = "$want" ]; then
    printf 'PASS [%s] %s -> %s\n' "$CHECK_NO" "$label" "$got"
    return 0
  fi
  printf 'FAIL [%s] %s -> %s, expected %s\n' "$CHECK_NO" "$label" "$got" "$want" >&2
  FAILURES=$((FAILURES + 1))
  return 1
}

cap() {
  # 登记「显式合法会话」响应，供 capability_all 汇总；非法 id 的 400 无会话上下文，不入账。
  printf '%s\t%s\n' "$1" "$LAST_BODY" >> "$CAP_MANIFEST"
}

check_invalid() {
  method=$1
  path=$2
  body=$3
  label=$4
  request "$label" "$method" "$path" "$body"
  expect "$label 400 invalid_session" 400 python3 "$HELPER" exact_error "$LAST_BODY" invalid_session
}

capture_id() {
  value=$(python3 "$HELPER" print_id "$LAST_BODY") || return 1
  [ -n "$value" ] || { printf '  FAIL response has no numeric id\n' >&2; return 1; }
  printf '%s' "$value"
}

# ---- 组 1：夹具与网关层能力位先验 ----
g1_capability_probe() {
  request 'health 真的在 listen' GET /health
  expect 'health 200 ok:true' 200 python3 "$HELPER" exact_keys "$LAST_BODY" ok
  # 契约 §7 第 1 条：网关没有 /api/mobile/sessions，名单与创建在消息面；网关层只验能力位。
  request '网关 GET /api/mobile/sessions' GET /api/mobile/sessions
  expect '网关无会话名单路由（404）' 404 python3 "$HELPER" exact_error "$LAST_BODY" 'not found'
  request '网关 POST /api/mobile/sessions' POST /api/mobile/sessions '{"id":"work"}'
  expect '网关无会话创建路由（404）' 404 python3 "$HELPER" exact_error "$LAST_BODY" 'not found'
  request '显式 main timeline' GET '/timeline?session_id=main'
  expect '显式 main timeline 带 session_api:1' 200 python3 "$HELPER" capability "$LAST_BODY" main
  cap main
  request '显式 work timeline' GET '/timeline?session_id=work'
  expect '显式 work timeline 带 session_api:1' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
}

# ---- 组 2：新客户端序列，两个会话同 request_id 各入一条、timeline 各只见自己 ----
# 网关不提供「新建会话」路由（组 1 已用 404 钉死），这里以消息面登记后的 work 为对象，
# 模拟新客户端创建会话后每个操作都带 ?session_id= 的完整序列。
g2_two_sessions_isolated() {
  request 'main 发同一 request_id' POST '/send?session_id=main' \
    "{\"text\":\"$TEXT_SAME_MAIN\",\"request_id\":\"$RID_SAME\"}"
  expect 'main /send 200 + 能力位' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_SAME"
  expect 'main /send 带 session_api:1' 200 python3 "$HELPER" capability "$LAST_BODY" main
  cap main
  MID_A=$(capture_id "$LAST_BODY") || return 1

  request 'work 发同一 request_id' POST '/send?session_id=work' \
    "{\"text\":\"$TEXT_SAME_WORK\",\"request_id\":\"$RID_SAME\"}"
  expect 'work /send 200 + 能力位' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_SAME"
  expect 'work /send 带 session_api:1' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
  MID_B=$(capture_id "$LAST_BODY") || return 1

  check '同 request_id 在两个会话各入一条（id 不同）' \
    sh -c '[ -n "$1" ] && [ -n "$2" ] && [ "$1" != "$2" ]' sh "$MID_A" "$MID_B"

  request 'main timeline' GET '/timeline?session_id=main'
  expect 'main timeline 精确一条 A' 200 python3 "$HELPER" exact_item "$LAST_BODY" "$RID_SAME" "$TEXT_SAME_MAIN" "$MID_A"
  expect 'main timeline 带能力位' 200 python3 "$HELPER" capability "$LAST_BODY" main
  cap main

  request 'work timeline' GET '/timeline?session_id=work'
  expect 'work timeline 精确一条 B' 200 python3 "$HELPER" exact_item "$LAST_BODY" "$RID_SAME" "$TEXT_SAME_WORK" "$MID_B"
  expect 'work timeline 带能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work

  request 'main timeline 复查不串' GET '/timeline?session_id=main'
  expect 'main timeline 不含 work 的消息' 200 python3 "$HELPER" excludes "$LAST_BODY" '' "$TEXT_SAME_WORK,$TEXT_B"
  request 'work timeline 复查不串' GET '/timeline?session_id=work'
  expect 'work timeline 不含 main 的消息' 200 python3 "$HELPER" excludes "$LAST_BODY" '' "$TEXT_SAME_MAIN,$TEXT_A"
}

# ---- 组 3：跨会话 withdraw / claim 404，且错误响应也带能力位 ----
g3_cross_session_404() {
  request 'main-only 消息' POST '/send?session_id=main' \
    "{\"text\":\"main-only\",\"request_id\":\"$RID_MAIN_ONLY\"}"
  expect 'main-only /send 200' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_MAIN_ONLY"
  expect 'main-only /send 带能力位' 200 python3 "$HELPER" capability "$LAST_BODY" main
  cap main
  request 'work-only 消息' POST '/send?session_id=work' \
    "{\"text\":\"work-only\",\"request_id\":\"$RID_WORK_ONLY\"}"
  expect 'work-only /send 200' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_WORK_ONLY"
  expect 'work-only /send 带能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work

  request 'main 撤回 work-only' POST '/withdraw?session_id=main' "{\"request_id\":\"$RID_WORK_ONLY\"}"
  expect 'main /withdraw work-only -> 404' 404 python3 "$HELPER" has_error "$LAST_BODY" 'no such message'
  expect '404 错误响应也带 main 能力位' 404 python3 "$HELPER" capability "$LAST_BODY" main
  cap main
  request 'work 撤回 main-only' POST '/withdraw?session_id=work' "{\"request_id\":\"$RID_MAIN_ONLY\"}"
  expect 'work /withdraw main-only -> 404' 404 python3 "$HELPER" has_error "$LAST_BODY" 'no such message'
  expect '404 错误响应也带 work 能力位' 404 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
  request 'main 插队 work-only' POST '/claim?session_id=main' "{\"request_id\":\"$RID_WORK_ONLY\"}"
  expect 'main /claim work-only -> 404' 404 python3 "$HELPER" has_error "$LAST_BODY" 'no such message'
  expect 'claim 404 错误响应也带 main 能力位' 404 python3 "$HELPER" capability "$LAST_BODY" main
  cap main
  request 'work 插队 main-only' POST '/claim?session_id=work' "{\"request_id\":\"$RID_MAIN_ONLY\"}"
  expect 'work /claim main-only -> 404' 404 python3 "$HELPER" has_error "$LAST_BODY" 'no such message'
  expect 'claim 404 错误响应也带 work 能力位' 404 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
}

# ---- 组 4：非 timeline 响应（send/withdraw/claim/200/409/400）全部带能力位 ----
# S1 堵静默串线的关键：客户端不先取 timeline 就直发 send 时，这条响应就是唯一的能力位证据。
g4_non_timeline_capability() {
  request '直发 work /send（不先取 timeline）' POST '/send?session_id=work' \
    "{\"text\":\"straight\",\"request_id\":\"$RID_STRAIGHT\"}"
  expect '直发 send 200 + 能力位' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_STRAIGHT"
  expect '直发 send 带 session_api:1' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work

  # 先造一条可插队的消息，再 claim 它。
  request '造可插队消息' POST '/send?session_id=work' \
    "{\"text\":\"claim-me\",\"request_id\":\"$RID_CLAIM_OK\"}"
  expect '可插队 /send 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
  request 'claim 成功' POST '/claim?session_id=work' "{\"request_id\":\"$RID_CLAIM_OK\"}"
  expect 'claim 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
  request 'claim 已取走 -> 409' POST '/claim?session_id=work' "{\"request_id\":\"$RID_CLAIM_OK\"}"
  expect 'claim 409 + 能力位' 409 python3 "$HELPER" capability "$LAST_BODY" work
  cap work

  request '造可撤回消息' POST '/send?session_id=work' \
    "{\"text\":\"withdraw-me\",\"request_id\":\"$RID_WITHDRAW_OK\"}"
  expect '可撤回 /send 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
  request 'withdraw 成功' POST '/withdraw?session_id=work' "{\"request_id\":\"$RID_WITHDRAW_OK\"}"
  expect 'withdraw 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work
  request 'withdraw 已撤回 -> 409' POST '/withdraw?session_id=work' "{\"request_id\":\"$RID_WITHDRAW_OK\"}"
  expect 'withdraw 409 already withdrawn' 409 python3 "$HELPER" has_error "$LAST_BODY" 'message already withdrawn'
  expect 'withdraw 409 + 能力位' 409 python3 "$HELPER" capability "$LAST_BODY" work
  cap work

  request '合法会话下非法 JSON' POST '/send?session_id=work' 'not-json'
  expect '400 错误响应也带能力位' 400 python3 "$HELPER" capability "$LAST_BODY" work
  cap work

  request '老调用 /send（无 query）' POST /send \
    "{\"text\":\"legacy\",\"request_id\":\"s2s3-legacy-cap\"}"
  expect '老调用 /send 200' 200 python3 "$HELPER" send_ok "$LAST_BODY" s2s3-legacy-cap
  expect '老调用响应逐字不变（精确三键）' 200 python3 "$HELPER" exact_keys "$LAST_BODY" ok,id,request_id
  expect '老调用响应一个能力字段都不加' 200 python3 "$HELPER" no_capability "$LAST_BODY"

  check '汇总：所有显式会话响应均带 session_api:1' python3 "$HELPER" capability_all "$CAP_MANIFEST"
}

# ---- 组 5：非法 id 400 invalid_session 与合法形状边界 ----
g5_invalid_session_id() {
  check_invalid GET '/timeline?session_id=Work' '' '大写 session_id'
  check_invalid POST '/send?session_id=a%20b' \
    "{\"text\":\"bad space\",\"request_id\":\"$RID_BAD_SPACE\"}" '含空格 session_id'
  check_invalid POST "/withdraw?session_id=$LONG_SESSION" \
    "{\"request_id\":\"$RID_BAD_LONG\"}" '超长 session_id'
  check_invalid GET '/health?session_id=Work' '' 'health 探针也不留静默放行口'
  request '尾部连字符合法' GET '/timeline?session_id=trail-'
  expect 'trail- timeline 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" trail-
  cap trail-
  request '32 位上限合法' GET "/timeline?session_id=$(python3 -c 'print("a" * 32)')"
  expect '32 位 timeline 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" "$(python3 -c 'print("a" * 32)')"
  cap "$(python3 -c 'print("a" * 32)')"
  request '非法 id 未落库：main timeline' GET '/timeline?session_id=main'
  expect 'main 不含非法 send 的消息' 200 python3 "$HELPER" excludes "$LAST_BODY" "$RID_BAD_SPACE,$RID_BAD_LONG" 'bad space,bad long'
  request '非法 id 未落库：work timeline' GET '/timeline?session_id=work'
  expect 'work 不含非法 send 的消息' 200 python3 "$HELPER" excludes "$LAST_BODY" "$RID_BAD_SPACE,$RID_BAD_LONG" 'bad space,bad long'
}

# ---- 组 6：缺省回落 main、老调用逐字不变 ----
g6_default_main() {
  request '缺省 /send' POST /send "{\"text\":\"default\",\"request_id\":\"$RID_DEFAULT\"}"
  expect '缺省 /send 200' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_DEFAULT"
  expect '缺省 /send 无能力字段' 200 python3 "$HELPER" no_capability "$LAST_BODY"
  request '显式 main /send' POST '/send?session_id=main' \
    "{\"text\":\"explicit\",\"request_id\":\"$RID_EXPLICIT\"}"
  expect '显式 main /send 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" main
  cap main

  request '缺省 timeline' GET /timeline
  TL_DEFAULT_BODY=$LAST_BODY
  expect '缺省 timeline 200 且顶层三键' 200 python3 "$HELPER" exact_keys "$LAST_BODY" items,session_id,session_api
  expect '缺省 timeline 带 session_id=main / session_api:1' 200 python3 "$HELPER" capability "$LAST_BODY" main
  expect '缺省 timeline 见到两条 send' 200 python3 "$HELPER" contains_rids "$LAST_BODY" "$RID_DEFAULT,$RID_EXPLICIT"

  request '显式 main timeline' GET '/timeline?session_id=main'
  TL_EXPLICIT_MAIN_BODY=$LAST_BODY
  expect '显式 main timeline 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" main
  cap main
  expect '显式 main timeline 见到两条 send' 200 python3 "$HELPER" contains_rids "$LAST_BODY" "$RID_DEFAULT,$RID_EXPLICIT"

  check '缺省与显式 main 的 timeline 完全相同' \
    python3 "$HELPER" equal "$TL_DEFAULT_BODY" "$TL_EXPLICIT_MAIN_BODY"
  check '老调用 timeline item 形状精确（7 键）' \
    python3 "$HELPER" item_shapes "$TL_DEFAULT_BODY"
}

# ---- 组 7：老网关模拟 —— 先验能力位、缺位即停发非 main 并锁 main、409 证据 ----
g7_old_gateway_simulation() {
  if ! start_old_gateway; then
    check '老网关 stub 正常 listen' false
    return 0
  fi
  check '老网关 stub 正常 listen' true

  old_request '老网关先验 timeline' GET '/timeline?session_id=main'
  cp "$LAST_BODY" "$OLD_RESPONSE" || check '拷贝老网关响应体' false
  expect '老网关响应全程 200（C4 形态）' 200 python3 "$HELPER" exact_keys "$LAST_BODY" items
  expect '老网关响应缺 session_api / session_id' 200 python3 "$HELPER" no_capability "$LAST_BODY"

  # 客户端决策器：先验能力位，缺位即锁 main、停发非 main、如实展示错误。
  expect_decision '缺能力位 -> 锁 main（不发非 main）' lock-main 200 "$OLD_RESPONSE"
  printf '{"error":"unsupported_session"}\n' > "$OLD_RESPONSE"
  expect_decision '409 unsupported_session -> 锁 main' lock-main 409 "$OLD_RESPONSE"
  printf '{"error":"Unknown operation"}\n' > "$OLD_RESPONSE"
  expect_decision '404（老消息面无 /sessions）-> 锁 main' lock-main 404 "$OLD_RESPONSE"
  expect_decision '网络错误 -> 锁 main 并如实说明读不到' lock-main 000 "$OLD_RESPONSE"
  expect_decision '新网关 session_api:1 -> 允许多会话' multi 200 "$TL_EXPLICIT_MAIN_BODY"

  # 「用现有 409 unsupported_session 的证据表达」：按 mobile-http.ts:980-981 的分支做转发判定。
  old_request '取一份老网关响应体' GET '/timeline?session_id=main'
  cp "$LAST_BODY" "$OLD_RESPONSE" || check '拷贝老网关响应体（判定用）' false
  check '显式 work + 老网关 -> 消息面 409 unsupported_session' \
    python3 "$HELPER" relay_verdict work "$OLD_RESPONSE" 409 unsupported_session
  check '显式 main + 老网关 -> 照常放行 200' \
    python3 "$HELPER" relay_verdict main "$OLD_RESPONSE" 200 ''
  check '显式 work + 新网关能力位 -> 放行 200' \
    python3 "$HELPER" relay_verdict work "$TL_EXPLICIT_MAIN_BODY" 200 ''
  check '源码/测试里确有 409 unsupported_session 证据' \
    python3 "$HELPER" source_evidence "$SOURCE" "$SPEC"

  # 停发非 main 的运行时证据：老网关只收到过先验请求（session_id=main），没有任何非 main 请求。
  check '老网关没收到任何非 main 请求（停发证据）' \
    python3 "$HELPER" no_nonmain "$OLDGW_REQUESTS"
}

# ---- 组 8：session_id 只走 query 或约定头 x-crew-session；body 与非约定头名不认 ----
# 注意语义：S4 起 `x-crew-session` 是**正式**会话头（组 9 正向验证）。
# 这里钉的是另外两件事：(a) body 里的 session_id 不被读；(b) `X-Session-Id` 这类
# **非约定头名**不被识别 —— 保留这条是因为它证明网关按白名单读头，而不是「见到像
# session 的头就猜」，不是说所有 header 都不认。
g8_query_only() {
  request 'body 带 session_id=work' POST /send \
    "{\"text\":\"body-only\",\"request_id\":\"$RID_BODY_ONLY\",\"session_id\":\"work\"}"
  expect 'body 形态被忽略 -> 200 且无能力字段' 200 python3 "$HELPER" no_capability "$LAST_BODY"
  EXTRA_HEADER='X-Session-Id: work'
  request '非约定头名 X-Session-Id: work（不是 x-crew-session）' POST /send \
    "{\"text\":\"header-only\",\"request_id\":\"$RID_HEADER_ONLY\"}"
  expect '非约定头名不被识别 -> 200 且无能力字段' 200 python3 "$HELPER" no_capability "$LAST_BODY"
  request 'query 显式 work（正向对照）' POST '/send?session_id=work' \
    "{\"text\":\"query-work\",\"request_id\":\"s2s3-query-work\"}"
  expect 'query 形态生效 -> 200 + 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  cap work

  request 'body/非约定头的 send 落在 main' GET '/timeline?session_id=main'
  expect 'main 见到 body/非约定头两条' 200 python3 "$HELPER" contains_rids "$LAST_BODY" "$RID_BODY_ONLY,$RID_HEADER_ONLY"
  request 'body/非约定头的 send 不在 work' GET '/timeline?session_id=work'
  expect 'work 不含 body/非约定头两条' 200 python3 "$HELPER" excludes "$LAST_BODY" "$RID_BODY_ONLY,$RID_HEADER_ONLY" 'body-only,header-only'
}

# ---- 组 9：约定头 x-crew-session 正向语义（S4 开放后的正式形态）----
# 这组存在的理由：组 8 只证明「非约定头名不认」，单看那组会让人误以为 header 一律无效。
# 这里把 S4 真正开放的能力逐条钉住：header-only 落 header 会话、query+header 同值通过、
# 冲突 400、非法 header 400、header 响应带能力位、老调用（两种载体都不带）逐字不变。
g9_session_header_positive() {
  EXTRA_HEADER='x-crew-session: work'
  request 'header-only /send（x-crew-session: work）' POST /send \
    "{\"text\":\"hdr-only\",\"request_id\":\"$RID_HDR_WORK\"}"
  expect 'header-only /send 200' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_HDR_WORK"
  expect 'header-only /send 带 work 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  expect 'header-only /send 精确五键（老三键 + 能力位两键）' 200 python3 "$HELPER" exact_keys \
    "$LAST_BODY" ok,id,request_id,session_id,session_api

  request 'header 消息确实落进 work' GET '/timeline?session_id=work'
  expect 'work timeline 见到 header-only 消息' 200 python3 "$HELPER" contains_rids "$LAST_BODY" "$RID_HDR_WORK"
  request 'header 消息没落 main' GET '/timeline?session_id=main'
  expect 'main timeline 不含 header-only 消息' 200 python3 "$HELPER" excludes "$LAST_BODY" "$RID_HDR_WORK" 'hdr-only'

  EXTRA_HEADER='x-crew-session: work'
  request 'query+header 同值' POST '/send?session_id=work' \
    "{\"text\":\"hdr-same\",\"request_id\":\"$RID_HDR_SAME\"}"
  expect 'query+header 同值 200' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_HDR_SAME"
  expect 'query+header 同值带 work 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work
  request 'query+header 同值的消息落在 work' GET '/timeline?session_id=work'
  expect 'work timeline 见到 query+header 同值消息' 200 python3 "$HELPER" contains_rids "$LAST_BODY" "$RID_HDR_SAME"

  EXTRA_HEADER='x-crew-session: ops'
  request 'query work + header ops 冲突' POST '/send?session_id=work' \
    "{\"text\":\"hdr-conflict\",\"request_id\":\"$RID_HDR_CONFLICT\"}"
  expect 'query/header 冲突 -> 400 invalid_session' 400 python3 "$HELPER" exact_error "$LAST_BODY" invalid_session
  request '冲突请求未落 work' GET '/timeline?session_id=work'
  expect 'work timeline 不含冲突请求' 200 python3 "$HELPER" excludes "$LAST_BODY" "$RID_HDR_CONFLICT" 'hdr-conflict'
  request '冲突请求未落 ops' GET '/timeline?session_id=ops'
  expect 'ops timeline 不含冲突请求' 200 python3 "$HELPER" excludes "$LAST_BODY" "$RID_HDR_CONFLICT" 'hdr-conflict'

  EXTRA_HEADER='x-crew-session: Work'
  request '非法 header 值（大写）' GET /timeline
  expect '非法 header -> 400 invalid_session' 400 python3 "$HELPER" exact_error "$LAST_BODY" invalid_session
  EXTRA_HEADER='x-crew-session: a b'
  request '非法 header 值（含空格）' POST /send \
    "{\"text\":\"hdr-bad\",\"request_id\":\"$RID_HDR_BAD\"}"
  expect '非法 header（含空格）-> 400 invalid_session' 400 python3 "$HELPER" exact_error "$LAST_BODY" invalid_session

  EXTRA_HEADER='x-crew-session: work'
  request 'header /claim 不存在的消息' POST /claim '{"request_id":"s2s3-no-such-row"}'
  expect 'header /claim 404 状态' 404 python3 "$HELPER" has_error "$LAST_BODY" 'no such message'
  expect 'header 错误响应也带 work 能力位' 404 python3 "$HELPER" capability "$LAST_BODY" work
  EXTRA_HEADER='x-crew-session: work'
  request 'header timeline' GET /timeline
  expect 'header timeline 200 + work 能力位' 200 python3 "$HELPER" capability "$LAST_BODY" work

  request '老调用 /send（无 query 无 header）' POST /send \
    "{\"text\":\"hdr-legacy\",\"request_id\":\"$RID_HDR_LEGACY\"}"
  expect '老调用 /send 200' 200 python3 "$HELPER" send_ok "$LAST_BODY" "$RID_HDR_LEGACY"
  expect '老调用 /send 逐字三键不变' 200 python3 "$HELPER" exact_keys "$LAST_BODY" ok,id,request_id
  expect '老调用 /send 一个能力字段都不加' 200 python3 "$HELPER" no_capability "$LAST_BODY"
  request '老调用 timeline（无 query 无 header）' GET /timeline
  expect '老调用 timeline 顶层三键不变' 200 python3 "$HELPER" exact_keys "$LAST_BODY" items,session_id,session_api
  expect '老调用 timeline 仍是 main' 200 python3 "$HELPER" capability "$LAST_BODY" main
  expect '老调用 timeline item 形状精确（7 键）' 200 python3 "$HELPER" item_shapes "$LAST_BODY"
}

# ---- 组 10：夹具隔离与自清理（不留残留进程/端口）----
port_released() {
  port=$1
  deadline=$(( $(date +%s) + 5 ))
  while :; do
    if python3 "$HELPER" port_closed "$port"; then return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then return 1; fi
    sleep 0.1
  done
}

g10_isolation_and_cleanup() {
  check '端口避开 8788 / 18787 / 18799 且互异' \
    python3 "$HELPER" assert_ports "$MOBILEGW_PORT" "$OLDGW_PORT"
  check '临时库/token 全在 DSH_HOME 下，生产库未被本脚本写入' \
    python3 "$HELPER" assert_fixture "$DSH_HOME" "$STATE" "$TOKEN_FILE" "$DB_FILE"

  pid1=$GW_PID
  pid2=$OLDGW_PID
  GW_PID=
  OLDGW_PID=
  for pid in "$pid1" "$pid2"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || :
    wait "$pid" 2>/dev/null || :
  done
  check '两个自建进程都已退出' python3 "$HELPER" processes_gone "$pid1" "$pid2"
  check '真网关端口已释放' port_released "$MOBILEGW_PORT"
  check '老网关端口已释放' port_released "$OLDGW_PORT"
  printf '  cleanup: trap 会在退出时删除 %s\n' "$DSH_HOME"
}

run_group() {
  number=$1
  title=$2
  fn=$3
  before=$FAILURES
  printf '\n== %s. %s ==\n' "$number" "$title"
  "$fn"
  if [ "$FAILURES" -eq "$before" ]; then
    printf 'PASS group %s. %s\n' "$number" "$title"
  else
    printf 'FAIL group %s. %s\n' "$number" "$title" >&2
    GROUP_FAILURES=$((GROUP_FAILURES + 1))
  fi
}

start_gateway || { printf 'FAIL mobilegw fixture did not start\n' >&2; exit 1; }
printf 'fixture: DSH_HOME=%s MOBILEGW_PORT=%s\n' "$DSH_HOME" "$MOBILEGW_PORT"

run_group 1 '网关层能力位先验与 /api/mobile/sessions 的 404 形态' g1_capability_probe
run_group 2 '两会话同 request_id 各入一条、timeline 各只见自己' g2_two_sessions_isolated
run_group 3 '跨会话 withdraw / claim 均 404，错误响应带能力位' g3_cross_session_404
run_group 4 '非 timeline 响应（send/withdraw/claim/200/409/400）全带能力位' g4_non_timeline_capability
run_group 5 '非法 id 400 invalid_session 与合法形状边界' g5_invalid_session_id
run_group 6 '缺省回落 main、老调用逐字不变' g6_default_main
run_group 7 '老网关模拟：先验能力位、停发非 main 锁 main、409 证据' g7_old_gateway_simulation
run_group 8 'session_id 不走 body，非约定头名 X-Session-Id 不被识别' g8_query_only
run_group 9 '约定头 x-crew-session 正向：落会话/同值/冲突 400/非法 400/能力位/老调用不变' g9_session_header_positive
run_group 10 '夹具隔离与自清理（不留进程/端口）' g10_isolation_and_cleanup

if [ "$FAILURES" -ne 0 ]; then
  printf 'FAIL %s assertion(s) across %s of 10 groups\n' "$FAILURES" "$GROUP_FAILURES" >&2
  exit 1
fi
printf 'PASS all 10 groups (%s assertions)\n' "$CHECK_NO"
exit 0
