#!/bin/sh
# doctor.sh 的回归：输入不足要如实说「推导不出端口」，不能拿空端口去 lsof 再报两个网关没起。
#
# 旧行为（#6 记的误报）：宿主会话注入 DSH_PROFILE=desktop，而 desktop profile 没有
# dsh-superagent 段 → stateDir 读不到 → GATEWAY_PORT / LAN_PORT 为空 → 脚本打印两行
# "not listening"，把一个「检查错了 profile」说成「服务没起」，退出 1。
#
# 用法：sh scripts/test-doctor.sh
set -u
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
fail=0
check() { if [ "$1" = "0" ]; then printf 'ok   %s\n' "$2"; else printf 'FAIL %s\n' "$2"; fail=1; fi; }
contains() { grep -qF -- "$2" "$1"; }

# 一个不存在的 profile：patch 读不到，stateDir 推导必然为空。不碰真实 profile、不启停任何服务。
OUT=$(mktemp); trap 'rm -f "$OUT"' EXIT
# 构造「端口推导不出来」：用一个不存在的 stateDir，而不是靠一个假的 profile 名。
# 后者依赖「DSH_PROFILE 会盖过实际在跑的」那个旧行为 —— 那正是被修掉的 bug
# （环境变量不该让 doctor 拿错 profile 的 stateDir 去查端口）。
DSH_STATE_DIR=/nonexistent/doctor-state-dir sh scripts/doctor.sh > "$OUT" 2>&1
rc=$?

[ "$rc" -eq 1 ]; check "$?" "profile 无法推导端口时退出 1（有明确硬失败，不是静默放行）"
contains "$OUT" "cannot derive them"; check "$?" "如实说明端口推导不出，并指出该设哪个变量"
if contains "$OUT" "not listening — it starts with the service"; then
  printf 'FAIL 不再把空端口误报成「网关没起」\n'; fail=1
else
  printf 'ok   不再把空端口误报成「网关没起」\n'
fi
# 不一致提示要单独构造一次调用：上面那次用的是 DSH_STATE_DIR，没设 DSH_PROFILE。
# 这里设一个与在跑的不一样的 profile，看 doctor 是否明说「你设的与在跑的不一致」。
OUT2=$(mktemp); trap 'rm -f "$OUT" "$OUT2"' EXIT
DSH_PROFILE=doctor-no-such-profile sh scripts/doctor.sh > "$OUT2" 2>&1
if contains "$OUT2" "note: DSH_PROFILE=doctor-no-such-profile, but the running crew is"; then
  printf 'ok   显式 profile 与实际在跑的不一致时给出提示\n'
else
  # 没有带 --profile 的 node 进程时（例如 CI 里没起服务）无从比较，这条跳过不算失败。
  running=""
  for pid in $(pgrep -x node 2>/dev/null); do
    v=$(LC_ALL=C ps -p "$pid" -o args= 2>/dev/null | LC_ALL=C awk '{for(i=1;i<NF;i++) if($i=="--profile"){print $(i+1);exit}}')
    if [ -n "$v" ]; then running="$v"; break; fi
  done
  if [ -n "$running" ]; then
    printf 'FAIL 显式 profile 与实际在跑的 %s 不一致时给出提示\n' "$running"; fail=1
  else
    printf 'ok   无明确运行 profile 可比对，跳过不一致提示（不算失败）\n'
  fi
fi

# 管理面不答时，若 status 已报 bind_stale（机器换了网段、后端还绑旧地址），doctor 要把这个
# 真因说出来，别只留一句 "no answer" 让人猜。没有漂移的环境里这条跳过，不算失败。
DRIFT=$(python3 backend/scripts/dsh-superagent status 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('bind_stale') or '')" 2>/dev/null)
if [ -n "$DRIFT" ]; then
  DSH_PROFILE=superagent sh scripts/doctor.sh > "$OUT" 2>&1 || true
  contains "$OUT" "likely cause"; check "$?" "漂移导致管理面不答时指出 IP 变化这个真因"
  contains "$OUT" "$DRIFT"; check "$?" "提示里带上机器当前的新地址 $DRIFT"
else
  printf 'ok   当前无 IP 漂移，跳过 bind_stale 提示检查（不算失败）\n'
fi

[ "$fail" -eq 0 ] && echo "doctor: 通过"
exit "$fail"
