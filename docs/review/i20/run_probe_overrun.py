#!/usr/bin/env python3
"""钉住上一条矩阵里冒出来的信号：慢滴对端能让单步越过 20s 预算。

probeBudget 只决定「这一步开始前还能等多久」——它把值当 readTimeout 传下去。
readTimeout 是**每次 read** 的期限；对端只要在期限内持续吐字节，就没有任何一次 read
会超时，于是单步的总墙钟由「字节数 × 每字节间隔」决定，与 20s 预算无关。

这组用例把上界量出来：同一份响应，滴得越慢，墙钟越长。
"""
import json, os, re, signal, socket, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = '/tmp/i20/out:/tmp/i20/harness:/tmp/kotlinc-copy/lib/kotlin-stdlib.jar'
SERVER = os.path.join(HERE, 'probe_server.py')


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def one(name, drip_ms, wait_ms, cap):
    port = free_port()
    srv = subprocess.Popen([sys.executable, SERVER, str(port), 'drip', '--drip-ms', str(drip_ms)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    srv.stdout.readline()
    started = time.time()
    proc = subprocess.Popen(['java', '-cp', CLASSES, 'ProbeHarnessKt', str(port), 'i20-token', str(wait_ms)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        out, _ = proc.communicate(timeout=cap); capped = False
    except subprocess.TimeoutExpired:
        proc.kill(); out, _ = proc.communicate(); capped = True
    wall = time.time() - started
    srv.send_signal(signal.SIGKILL); srv.wait()
    m = re.search(r'RESULT ok=(\w+) millis=(-?\d+) wall_ms=(\d+)', out)
    rec = {'case': name, 'drip_ms': drip_ms, 'wait_ms': wait_ms, 'budget_ms': 20000,
           'wall_seconds': round(wall, 2), 'exceeded_budget': wall * 1000 > 20000,
           'capped': capped}
    if m:
        rec['ok'] = m.group(1) == 'true'; rec['probe_millis'] = int(m.group(2))
    else:
        rec['raw'] = out.strip()[-300:]
    return rec


CASES = [
    ('慢滴 200ms/字节（预算 20s）', 200, 15000, 200),
    ('慢滴 400ms/字节（预算 20s）', 400, 15000, 240),
    ('慢滴 800ms/字节（预算 20s，上限放到 240s）', 800, 15000, 240),
]
res = []
for name, drip, wait, cap in CASES:
    print('running %s' % name, file=sys.stderr, flush=True)
    r = one(name, drip, wait, cap); res.append(r)
    print(json.dumps(r, ensure_ascii=False), file=sys.stderr, flush=True)
print(json.dumps(res, ensure_ascii=False, indent=2))
