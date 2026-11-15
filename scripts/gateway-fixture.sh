#!/bin/sh
# 可复用网关台架：一次 start 拿到「自己的端口 + 自己的状态目录 + 自己的 pid」，一次 stop 只回收那一个。
#
#   sh scripts/gateway-fixture.sh start --home DIR [--port N] [--print-port]
#   sh scripts/gateway-fixture.sh stop  --home DIR
#   sh scripts/gateway-fixture.sh status --home DIR
#
# 为什么要有它（2026-11-14 事故）：三个测试脚本各自手写启动命令，其中一个只给了 DSH_HOME 没给
# MOBILEGW_PORT，网关落回缺省 8788 撞上 launchd 托管的生产网关，拿到 Errno 48；随后用
# `pkill -f backend/tools/mobilegw` 去「清理端口」，pattern 是路径子串，把生产那份一起带走了两次。
#
# 三条硬规矩，都写在这里而不是写在调用方的注释里：
# 1. 端口必须显式给。没给就从空闲端口里挑一个，绝不回落到任何缺省值；选中的端口落到
#    <home>/gateway.port，下一次 start 复用它，重启不会换端口。
# 2. 8788（生产端口）一律拒绝。给出来也拒绝 —— 那不是「这次碰巧一样」，是「你在动别人的队伍」。
# 3. 只回收自己记录的 pid，且回收前核对启动时刻。端口被陌生人占着就报错退出，绝不替对方做决定：
#    这里没有 pkill，没有 killall，没有 fuser，也没有按端口找 pid 再杀。
#
# 台架自己也有隔离：DSH_HOME / MOBILEGW_STATE 都在 --home 下，凭据由网关自己生成，不读生产那份。
set -u

PRODUCTION_PORT=8788
PRODUCTION_STATE="$HOME/.dsh/state/superagent"

usage() {
  cat <<'EOF'
用法: gateway-fixture.sh start|stop|status --home DIR [--port N] [--print-port]

  --home DIR      台架自己的目录：状态、凭据、日志、pid 都在这下面（必填，且不许是生产状态目录）
  --port N        显式指定端口；不给就挑一个空闲端口并记在 DIR/gateway.port 里复用
  --print-port    start 成功后把端口单独打印在最后一行，方便 $(...)

环境变量 MOBILEGW_PORT 会被当作显式端口（与 --port 同义）。生产端口 8788 一律拒绝。
stop 只结束本台架记录的那个 pid，且 pid 的启动时刻对不上就不动它。
EOF
}

die() { printf 'gateway-fixture: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

ACTION=
HOME_DIR=
PORT=
PRINT_PORT=0

while [ $# -gt 0 ]; do
  case "$1" in
    start|stop|status) ACTION=$1; shift ;;
    --home) HOME_DIR=${2:-}; shift 2 ;;
    --home=*) HOME_DIR=${1#--home=}; shift ;;
    --port) PORT=${2:-}; shift 2 ;;
    --port=*) PORT=${1#--port=}; shift ;;
    --print-port) PRINT_PORT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数 $1（--help 看用法）" ;;
  esac
done

[ -n "$ACTION" ] || { usage >&2; exit 2; }
[ -n "$HOME_DIR" ] || die "--home 必填：台架必须有自己的一份状态目录"

# 相对路径落成绝对路径，pid 记录里存的是真路径，换个 cwd 来 stop 也能对上。
case "$HOME_DIR" in
  /*) ;;
  *) HOME_DIR=$(cd "$(dirname "$HOME_DIR")" 2>/dev/null && pwd)/$(basename "$HOME_DIR") || die "无法解析 --home $HOME_DIR" ;;
esac
HOME_DIR=${HOME_DIR%/}

STATE_DIR="$HOME_DIR/state/superagent"
GW_LOG="$HOME_DIR/mobilegw.log"
PID_FILE="$HOME_DIR/gateway.pid"
META_FILE="$HOME_DIR/gateway.pid.meta"
PORT_FILE="$HOME_DIR/gateway.port"
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P) || exit 1
GW="$SCRIPT_DIR/../backend/tools/mobilegw"

[ -f "$GW" ] || die "找不到网关: $GW"

# 台架的状态目录不许就是生产那一份：同一个目录意味着同一个队列、同一支凭据。
if [ "$(cd "$HOME_DIR" 2>/dev/null && pwd -P)" = "$(cd "$PRODUCTION_STATE" 2>/dev/null && pwd -P)" ]; then
  die "refusing: $HOME_DIR is the production state directory; a bench needs its own"
fi

port_free() {
  python3 - "$1" <<'PY'
import socket, sys
port = int(sys.argv[1])
sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(('127.0.0.1', port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
raise SystemExit(0)
PY
}

pick_port() {
  python3 - <<'PY'
import random, socket
banned = {8788, 18787, 18799}
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
    raise SystemExit(0)
print('no free port', file=__import__('sys').stderr)
raise SystemExit(1)
PY
}

# pid 的启动时刻（epoch 秒）。对不上就说明这个 pid 已经是别人的新进程了。
pid_started_at() {
  ps -p "$1" -o lstart= 2>/dev/null | python3 -c '
import sys, time, datetime
text = sys.stdin.read().strip()
if not text:
    raise SystemExit(1)
print(int(time.mktime(datetime.datetime.strptime(" ".join(text.split()), "%a %b %d %H:%M:%S %Y").timetuple())))
' 2>/dev/null
}

own_pid() {
  # 打印本台架记录的 pid，但只在「它确实还是当初那个进程」时。
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null)
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  recorded=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["started_at"])' "$META_FILE" 2>/dev/null) || return 1
  actual=$(pid_started_at "$pid") || return 1
  # lstart 只有秒级精度，容 2 秒误差。
  delta=$(( actual - recorded ))
  [ "$delta" -ge -2 ] && [ "$delta" -le 2 ] || return 1
  printf '%s\n' "$pid"
}

case "$ACTION" in
  start)
    [ -n "$PORT" ] || PORT=${MOBILEGW_PORT:-}
    if [ -z "$PORT" ] && [ -f "$PORT_FILE" ]; then
      PORT=$(cat "$PORT_FILE" 2>/dev/null)
      case "$PORT" in ''|*[!0-9]*) PORT= ;; esac
    fi
    [ -n "$PORT" ] || PORT=$(pick_port) || die "挑不到空闲端口"
    case "$PORT" in *[!0-9]*) die "端口不是数字: $PORT" ;; esac
    if [ "$PORT" -eq "$PRODUCTION_PORT" ]; then
      die "refusing: $PRODUCTION_PORT is the production gateway's port; a bench must use its own"
    fi
    if ! port_free "$PORT"; then
      die "port $PORT is in use by another process; nothing was killed — pick another port"
    fi

    if pid=$(own_pid); then
      die "this bench is already running as pid $pid on port $(cat "$PORT_FILE" 2>/dev/null)"
    fi

    mkdir -p "$STATE_DIR" || die "建不出状态目录 $STATE_DIR"
    printf '%s\n' "$PORT" > "$PORT_FILE" || die "写不进 $PORT_FILE"
    : > "$GW_LOG" || die "写不进 $GW_LOG"

    # 端口与状态目录成对给出；网关自己会在没给端口或撞生产组合时以退出码 2 停下。
    DSH_HOME="$HOME_DIR" MOBILEGW_STATE="$STATE_DIR" MOBILEGW_HOST=127.0.0.1 \
      MOBILEGW_PORT="$PORT" PYTHONUNBUFFERED=1 \
      nohup python3 "$GW" >> "$GW_LOG" 2>&1 &
    pid=$!
    printf '%s\n' "$pid" > "$PID_FILE"

    # 等它真的开始服务：起不来就把自己这一份收掉，并如实报错。
    waited=0
    while [ "$waited" -lt 100 ]; do
      if ! kill -0 "$pid" 2>/dev/null; then
        printf 'gateway-fixture: 网关启动即退出，日志尾部：\n' >&2
        tail -5 "$GW_LOG" >&2 2>/dev/null
        rm -f "$PID_FILE" "$META_FILE"
        exit 1
      fi
      if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        break
      fi
      waited=$((waited + 1))
      sleep 0.1
    done
    if [ "$waited" -ge 100 ]; then
      printf 'gateway-fixture: 网关 /health 超时\n' >&2
      kill "$pid" 2>/dev/null || :
      wait "$pid" 2>/dev/null || :
      rm -f "$PID_FILE" "$META_FILE"
      exit 1
    fi

    started_at=$(pid_started_at "$pid") || started_at=$(date +%s)
    printf '{"pid": %s, "started_at": %s, "port": %s, "home": "%s"}\n' \
      "$pid" "$started_at" "$PORT" "$HOME_DIR" > "$META_FILE"

    say "fixture: home=$HOME_DIR port=$PORT pid=$pid"
    [ "$PRINT_PORT" = "1" ] && say "$PORT"
    exit 0
    ;;

  stop)
    if pid=$(own_pid); then
      kill "$pid" 2>/dev/null || :
      waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 100 ]; do
        waited=$((waited + 1))
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        say "fixture: pid $pid 没在 10s 内退出（未强杀，留给人工看）" >&2
        exit 1
      fi
      rm -f "$PID_FILE" "$META_FILE"
      say "fixture: stopped pid $pid"
      exit 0
    fi
    if [ -f "$PID_FILE" ]; then
      say "fixture: 记录里的 pid 不是本台架当初那个进程（pid 可能已被系统回收），不动它" >&2
      exit 1
    fi
    say "fixture: 没有在跑的台架"
    exit 0
    ;;

  status)
    if pid=$(own_pid); then
      say "running pid=$pid port=$(cat "$PORT_FILE" 2>/dev/null) home=$HOME_DIR"
      exit 0
    fi
    say "not running home=$HOME_DIR"
    exit 1
    ;;
esac
