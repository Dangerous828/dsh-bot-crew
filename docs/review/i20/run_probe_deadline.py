#!/usr/bin/env python3
"""修后验收：慢滴 / 不回 的对端必须被整轮墙钟封住，且连接真的被关掉。

与 run_probe_overrun.py 的区别：那条量的是**修前**无上界的行为（800ms/字节 拖到 81 秒），
这条量的是修后：预算压到 1500ms，看墙钟、看 ok、看对端连接是不是在探测返回后就被放掉。

台架与产品代码都不复制：probe_server.py 是那个可控的「隧道那头」，
ProbeHarness2Kt 直接调产品 TailcatP2p.probe()。
"""
import json, os, re, signal, socket, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = '/tmp/i20/out2:/tmp/i20/harness2:/tmp/kotlinc-copy/lib/kotlin-stdlib.jar'
SERVER = os.path.join(HERE, 'probe_server.py')
BUDGET_MS = 1500
# 生产默认预算是 20 秒。绝大多数用例压到 1.5 秒跑，只留一例按生产值跑一次 ——
# 它才是「真机上到底封在多少」的那条证据。
PROD_BUDGET_MS = 20000


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def connections_to(port):
    """数一下还有多少条到 port 的 ESTABLISHED 连接 —— 用来判断连接有没有被放掉。"""
    try:
        out = subprocess.run(['lsof', '-nP', '-iTCP:%d' % port, '-sTCP:ESTABLISHED'],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return -1
    return max(0, len([l for l in out.splitlines() if 'ESTABLISHED' in l]) - 1)  # 减去 LISTEN 行外的自身


def one(name, mode, drip_ms, wait_ms, rounds=1, cap=60, budget_ms=BUDGET_MS):
    port = free_port()
    srv = subprocess.Popen([sys.executable, SERVER, str(port), mode, '--drip-ms', str(drip_ms)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    srv.stdout.readline()
    started = time.time()
    proc = subprocess.Popen(
        ['java', '-cp', CLASSES, 'ProbeHarness2Kt', str(port), 'i20-token', str(wait_ms),
         str(budget_ms), str(rounds)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        out, _ = proc.communicate(timeout=cap); capped = False
    except subprocess.TimeoutExpired:
        proc.kill(); out, _ = proc.communicate(); capped = True
    wall = time.time() - started
    still = connections_to(port)
    srv.send_signal(signal.SIGKILL); srv.wait()
    lines = [l for l in out.splitlines() if l.startswith('RESULT')]
    rec = {'case': name, 'mode': mode, 'drip_ms': drip_ms, 'wait_ms': wait_ms,
           'budget_ms': budget_ms, 'rounds': rounds,
           'wall_seconds': round(wall, 2),
           # 多轮用例的总墙钟自然是 N 倍预算，所以逐轮判，不拿总数比单轮预算。
           'exceeded_budget': any(
               int(re.search(r'wall_ms=(\d+)', l).group(1)) > budget_ms + 1500
               for l in lines if re.search(r'wall_ms=(\d+)', l)),
           'capped': capped, 'peer_established_after': still, 'results': lines}
    if lines:
        m = re.search(r'ok=(\w+) millis=(-?\d+) wall_ms=(\d+)', lines[-1])
        if m:
            rec['ok'] = m.group(1) == 'true'
            rec['probe_millis'] = int(m.group(2))
            rec['probe_wall_ms'] = int(m.group(3))
    return rec


CASES = [
    ('慢滴 800ms/字节（#20 里拖到 81.64s 那例）', 'drip', 800, 15000, 1),
    ('慢滴 100ms/字节（#20 里 22.52s 且误报 ok）', 'drip', 100, 15000, 1),
    ('对端收下不回', 'hang', 0, 15000, 1),
    ('慢滴连续 3 轮（连接不许累积）', 'drip', 200, 15000, 3),
    ('快回（正常探测不受影响）', 'normal', 0, 15000, 1),
    # 生产默认预算下跑一次：这是「真机上封在多少」的直接证据，只跑一例。
    ('慢滴 800ms/字节，生产默认 20s 预算', 'drip', 800, 15000, 1),
]
res = []
for name, mode, drip, wait, rounds in CASES:
    print('running %s' % name, file=sys.stderr, flush=True)
    budget = PROD_BUDGET_MS if '生产默认' in name else BUDGET_MS
    r = one(name, mode, drip, wait, rounds, budget_ms=budget)
    res.append(r)
    print(json.dumps(r, ensure_ascii=False), file=sys.stderr, flush=True)
print(json.dumps(res, ensure_ascii=False, indent=2))
