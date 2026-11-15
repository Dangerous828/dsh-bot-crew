#!/usr/bin/env python3
"""cross_nat_classify.py — #20 打洞路径归类器（**fail-closed 候选分类，不是验收器**）

═══════════════════════════════════════════════════════════════════════
判据铁律（lead 2026-11-14 校准，最高优先）：
═══════════════════════════════════════════════════════════════════════
1. **不同公网 IP / 不同 IPv6 /64 最多证明「different-network 候选」，
   不能单独证明「不同 NAT 已打洞」。**
   - 原生全局 IPv6 直连通常**压根没有 NAT**（端到端点对点），也就谈不上「打洞」。
   - 不同公网 IPv4 只能说明「看起来不是同一个出口」，但无法排除中间有对称 NAT / CGNAT / 双层 NAT，
     也无法确认打洞（UDP hole punch）真的发生，而不是走了公网可路由直连。
2. **同 /64（或同 /24 私网）可作「排除同 LAN」的证据**：direct 落在本机前缀内 → 确证同 LAN，不是跨网。
3. **不同 /64 不能当「必为不同 NAT」。** 只能归为 **candidate（候选）**，需额外拓扑证据才可升级。
4. 因此本工具**默认 fail-closed**：
   - 不同前缀 → 标 `different_network_candidate`，**不自动判成功**。
   - 要通过原条款，必须在**已知双方拓扑 / IPv4 NAT 映射**，或**明确跨网且确认是 IPv6 无 NAT 直连（须标非-NAT）**的前提下，
     显式传 `--verify-cross-nat` 并同步给出 `--topology-note`，才允许 verdict 升级为 `CROSS-NAT-VERIFIED`；
     否则即使全是 foreign 候选，verdict 仍是 `CANDIDATE-ONLY-NOT-VERIFIED`。
═══════════════════════════════════════════════════════════════════════

输入：
  - 一行一个 tailcat ping 的 pong：`pong in X ms via <addr>:port` 或 `... via DERP(tok)`
  - stdin 或 --file <path>
  - Mac 本机地址自动从 ifconfig 取（--mac-ip 可覆盖，逗号分隔）

输出 JSON：
  {derp, direct, direct_same_nat(确证同LAN/排除跨网), different_network_candidate(仅候选),
   direct_unknown, total, nopong, candidate_verified(bool), verdict, sample, ...}

退出码（fail-closed）：
  0 = 仅当 --verify-cross-nat + --topology-note 提供，且直连全部落在 different-network 候选（无 same-nat 反证）
      → verdict CROSS-NAT-VERIFIED
  2 = 有 direct 但未满足验收前提（候选 / 同 LAN / 无拓扑证明）→ CANDIDATE-ONLY / SAME-NAT，NOT verified
  3 = 无 direct 路径（全 derp / 无 pong）
"""
import sys, re, json, subprocess, ipaddress, argparse

def mac_addrs():
    try:
        out = subprocess.check_output(["ifconfig"], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return [], []
    v4, v6 = [], []
    for line in out.splitlines():
        m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', line)
        if m:
            v4.append(m.group(1))
        m6 = re.search(r'inet6 ([0-9a-fA-F:]+)', line)
        if m6 and 'fe80' not in m6.group(1) and m6.group(1) != '::1':
            v6.append(m6.group(1))
    return v4, v6

def parse_peer_addr(pong):
    if 'via DERP' in pong:
        return None
    m = re.search(r'via (\[[0-9a-fA-F:]+\]|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)', pong)
    if not m:
        return None
    return m.group(1).strip('[]')

def classify_addr(addr, mac_v4, mac_v6):
    """返回 'same-lan' | 'different-network-candidate' | 'unknown'
    - same-lan：确证与本机同子网/前缀（排除跨网）
    - different-network-candidate：不在本机任一前缀内（**仅候选，非 verified**）
    - unknown：无法解析 / 无法判断
    """
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return 'unknown'
    if ip.is_loopback or ip.is_link_local:
        return 'same-lan'
    if ip.version == 4:
        for m in mac_v4:
            try:
                mac_ip = ipaddress.ip_address(m)
            except ValueError:
                continue
            if mac_ip.is_loopback:
                continue
            if ip in ipaddress.ip_network(f"{m}/24", strict=False):
                return 'same-lan'
        # 私网但不在本机 /24：非标准家庭直连，保守 fail-closed 归候选（绝不判 verified）
        if ip.is_private:
            return 'different-network-candidate'
        return 'different-network-candidate'  # 公网 IPv4：仅候选（可能是公网直连而非打洞）
    else:  # IPv6
        for m in mac_v6:
            try:
                if ip in ipaddress.ip_network(f"{m}/64", strict=False):
                    return 'same-lan'
            except ValueError:
                continue
        # 不同 /64：仅候选。全局 IPv6 p2p 直连**往往无 NAT**，不能据此说「跨 NAT 已打洞」。
        return 'different-network-candidate'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--mac-ip", default="")
    ap.add_argument("--verify-cross-nat", action="store_true",
                    help="显式声明已具备跨 NAT 验收前提（已知双方拓扑/IPv4 NAT 映射，或明确跨网 IPv6 无 NAT 直连）。"
                         "缺省 fail-closed，仅做候选分类。")
    ap.add_argument("--topology-note", default="",
                    help="与 --verify-cross-nat 配套的拓扑证据说明（已知双方拓扑 / NAT 映射 / IPv6 无 NAT 直连标注）。")
    args = ap.parse_args()

    lines = open(args.file).read().splitlines() if args.file else sys.stdin.read().splitlines()
    if args.mac_ip:
        mv4 = [x for x in args.mac_ip.split(',') if '.' in x]
        mv6 = [x for x in args.mac_ip.split(',') if ':' in x]
    else:
        mv4, mv6 = mac_addrs()

    r = dict(derp=0, direct=0, direct_same_nat=0, different_network_candidate=0,
             direct_unknown=0, total=0, nopong=0, sample=[],
             candidate_verified=False, verify_requested=bool(args.verify_cross_nat),
             topology_note=args.topology_note)
    for ln in lines:
        ln = ln.strip()
        if not ln or ln.startswith('#'):
            continue
        if 'pong in' not in ln:
            r['nopong'] += 1
            continue
        r['total'] += 1
        if 'via DERP' in ln:
            r['derp'] += 1
            continue
        addr = parse_peer_addr(ln)
        if not addr:
            r['nopong'] += 1
            continue
        r['direct'] += 1
        cls = classify_addr(addr, mv4, mv6)
        if cls == 'same-lan':
            r['direct_same_nat'] += 1; tag = 'same-lan(排除跨网)'
        elif cls == 'different-network-candidate':
            r['different_network_candidate'] += 1; tag = 'different-network-CANDIDATE(非verified)'
        else:
            r['direct_unknown'] += 1; tag = 'unknown'
        if len(r['sample']) < 5:
            r['sample'].append(f"{tag}: {ln}")

    # ---- fail-closed 判据 ----
    # 升级为 verified 的必要条件（全部满足）：
    #   a) 显式 --verify-cross-nat 且给了 topology-note（人工已确认双方拓扑/NAT 映射 或 IPv6 无 NAT 直连）
    #   b) 至少一次 direct
    #   c) 没有 same-lan 反证（出现 any direct 落在本机前缀 = 至少部分是 LAN，不能算纯跨网）
    #   d) 直连全部是 different-network 候选（没有 unknown）
    can_verify = (args.verify_cross_nat and args.topology_note.strip()
                  and r['direct'] > 0 and r['direct_same_nat'] == 0 and r['direct_unknown'] == 0)
    if can_verify:
        rc = 0; verdict = 'CROSS-NAT-VERIFIED'
        r['candidate_verified'] = True
    elif r['direct'] > 0:
        rc = 2
        if r['direct_same_nat'] > 0 and r['different_network_candidate'] == 0:
            verdict = 'SAME-NAT-ONLY-NOT-CROSS-NAT'
        else:
            verdict = 'CANDIDATE-ONLY-NOT-VERIFIED'
    else:
        rc = 3; verdict = 'NO-DIRECT-PATH'
    r['verdict'] = verdict
    r['mac_v4'] = mv4; r['mac_v6'] = mv6
    r['note'] = ('candidate_verified 需 --verify-cross-nat + --topology-note 且无 same-lan/unknown 反证；'
                 '不同公网IP/不同/64 只算候选，不单独证明跨NAT已打洞（原生全局IPv6直连通常无NAT）')
    print(json.dumps(r, ensure_ascii=False, indent=2))
    sys.exit(rc)

if __name__ == '__main__':
    main()
