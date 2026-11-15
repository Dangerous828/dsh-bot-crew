#!/usr/bin/env bash
# cross_nat_preflight.sh — #20 第二网络出口可用性 只读预检
#
# 干一件事：如实回答「现在有没有一台与 Mac 不同 NAT 出口的对端可用来做跨 NAT 打洞测试」。
# 逐项只用只读探测（nc/ping/ssh -o BatchMode），不改任何系统网络/路由/防火墙，不强连 hostkey。
#
# 候选（canonical 家庭主机清单）：
#   win-laptop  : TP-Link 192.168.0.0/24 出口（唯一现成的第二 NAT 出口）
#                 - LAN 192.168.0.109:22（跨网段，从小米网常态不通）
#                 - EasyTier 10.10.10.1:22
#                 - 公网 IPv6 win.kentonnie.top:22
#   win-desktop : 小米 192.168.31.0/24 出口 = **与 Mac 同 NAT**，不能当跨 NAT peer
#   mi-desktop  : 小米网段，同 NAT
#   NAS         : 小米网段，同 NAT
#   手机 PEDM00 : 需蜂窝可用（mobile_data=1 且 IN_SERVICE 且 rmnet 全局地址），
#                 否则 WiFi 下也是同 NAT（且是同一 WiFi 出口）
#
# 退出码：0=至少一条「不同网络出口的 peer 可达」=only a CANDIDATE (不等于跨NAT已打洞，仍须拓扑/NAT映射+direct实证)；1=全部不可达（条件不具备）。
# 注意：0 只表示「有异网候选可收证」，不代表 cross-NAT verified。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUTDIR="${OUTDIR:-$HERE/runs}"; mkdir -p "$OUTDIR"
TS="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUTDIR/preflight-$TS.txt"
exec > >(tee "$REPORT") 2>&1

echo "# cross_nat_preflight  ts=$TS"
echo "# Mac 当前地址（判断是否在小米网）:"
ifconfig 2>/dev/null | grep 'inet ' | sed 's/^/  /'
DEFGW="$(route -n get default 2>/dev/null | awk '/gateway/{print $2}')"
echo "# Mac 默认网关: ${DEFGW:-?}"
echo ""

probe22() { # host [extra nc args]
  local h="$1"; shift
  nc -z -G 5 -w 5 "$@" "$h" 22 >/dev/null 2>&1 && { echo "  [OK]   $h:22"; return 0; } || { echo "  [FAIL] $h:22"; return 1; }
}

echo "## win-laptop（唯一现成第二 NAT 出口）"
LP_OK=0
probe22 192.168.0.109 && LP_OK=1
probe22 10.10.10.1   && LP_OK=1
# 公网 IPv6：先解析，再直连字面量（macOS nc 对域名 IPv6 解析弱）
echo "  -- 公网 IPv6 win.kentonnie.top --"
python3 - <<'PY' && LP_OK=1
import socket, sys
try:
    ip = socket.getaddrinfo('win.kentonnie.top', 22, socket.AF_INET6)[0][4][0]
except Exception:
    print("  [FAIL] win.kentonnie.top: 无 IPv6 AAAA 解析"); sys.exit(1)
print(f"  resolved IPv6: {ip}")
s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM); s.settimeout(5)
try:
    s.connect((ip, 22, 0, 0)); print(f"  [OK]   [{ip}]:22"); sys.exit(0)
except Exception as e:
    print(f"  [FAIL] [{ip}]:22 ({e.__class__.__name__})"); sys.exit(1)
PY

echo ""
echo "## EasyTier peer 表（看 win-laptop 10.10.10.1 是否在网）"
if [ -x "$HOME/bin/easytier-cli" ]; then
  "$HOME/bin/easytier-cli" peer 2>/dev/null | sed 's/^/  /'
  if "$HOME/bin/easytier-cli" peer 2>/dev/null | grep -q '10.10.10.1/'; then
    echo "  -> win-laptop 10.10.10.1 在 mesh 中"; LP_OK=1
  else
    echo "  -> win-laptop 10.10.10.1 不在 mesh（离线/未接入）"
  fi
else
  echo "  (easytier-cli 不存在，跳过)"
fi

echo ""
echo "## 对照（同 NAT，不可用于跨 NAT，仅确认身份）"
probe22 192.168.31.175 || true   # win-desktop 有线，小米网
probe22 192.168.31.183 || true   # mi-desktop，小米网
nc -z -G 3 -w 3 10.10.10.2 22 >/dev/null 2>&1 && echo "  [OK]   NAS EasyTier 10.10.10.2:22 (同NAT)" || echo "  [--]   NAS 10.10.10.2:22 关闭(正常, 同NAT)"

echo ""
echo "## 手机蜂窝（若 adb 在线则只读快照；不 toggle、不读 SIM 号码）"
if command -v adb >/dev/null 2>&1 && adb devices 2>/dev/null | grep -q '55c86317\s*device'; then
  S=55c86317
  MD="$(adb -s $S shell settings get global mobile_data 2>/dev/null | tr -d '\r')"
  REG="$(adb -s $S shell dumpsys telephony.registry 2>/dev/null | grep -m1 -oE 'mDataRegState=[0-9]+\([A-Z_]+\)')"
  MIP="$(adb -s $S shell ip -4 -o addr 2>/dev/null | grep -E 'rmnet|ccmni')"
  echo "  mobile_data=$MD  |  $REG  |  移动口IPv4: ${MIP:-无}"
  if [ "$MD" = "1" ] && printf '%s' "$REG" | grep -q 'IN_SERVICE' && [ -n "$MIP" ]; then
    echo "  -> 蜂窝已启用可用（可能作为异网出口，前提是关 WiFi 后默认网络切 CELLULAR）"; LP_OK=1
  else
    echo "  -> 蜂窝不可用（数据关/未注册/无IPv4），手机不能当异网出口"
  fi
else
  echo "  (手机 adb 不在线或 serial 不符，未读)"
fi

echo ""
if [ "$LP_OK" -eq 1 ]; then
  echo "=== VERDICT: FOREIGN-NETWORK-PEER-CANDIDATE-AVAILABLE  (仅候选：不同网络出口可达) ==="
  echo "注意: 可达/不同公网IP/不同/64 只算候选, 不证明不同NAT已打洞(原生全局IPv6直连通常无NAT)."
  echo "下一步: 在远端起 serve 后 ./tailcat_nat_probe.sh --peer <tc-addr> --count 30 ；"
  echo "        收证后仍须 已知双方拓扑/IPv4 NAT映射 或 明确跨网IPv6(标非NAT) + direct路径实证 才满足原条款。"
  echo "        满足则加 --verify-cross-nat --topology-note \"<拓扑证据>\" 才可能升级 CROSS-NAT-VERIFIED。"
  exit 0
else
  echo "=== VERDICT: NO-FOREIGN-NAT-PEER  (第二网络出口不具备，#20 第1项维持 OPEN) ==="
  exit 1
fi
