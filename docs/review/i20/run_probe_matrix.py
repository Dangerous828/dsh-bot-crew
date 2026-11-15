#!/usr/bin/env python3
"""跑 probe() 的真实超时矩阵，逐个模式起一个受控「隧道那头」，记录 ok / 往返 / 墙钟。

判据：
  - ok=false 且墙钟≈waitMs  → 单步超时生效，预算未成为约束
  - ok=false 且墙钟≈20s     → 整轮预算生效（PROBE_BUDGET_MS 封住了）
  - 墙钟明显 > 20s          → 预算**没有**封住（readTimeout 是每次 read 的期限，
                               对端持续慢滴时每次 read 都被刷新）
"""
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = '/tmp/i20/out:/tmp/i20/harness:/tmp/kotlinc-copy/lib/kotlin-stdlib.jar'
JAVA = 'java'
SERVER = os.path.join(HERE, 'probe_server.py')
CAP_SECONDS = 75


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def run_case(name, mode, wait_ms, extra=None):
    port = free_port()
    srv = None
    if mode != 'refuse':
        args = [sys.executable, SERVER, str(port), mode]
        if extra:
            args += extra
        srv = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        line = srv.stdout.readline().strip()
        if not line.startswith('ready'):
            srv.kill()
            return {'case': name, 'error': 'server did not start: %r' % line}
    try:

        started = time.time()
        proc = subprocess.Popen(
            [JAVA, '-cp', CLASSES, 'ProbeHarnessKt', str(port), 'i20-token', str(wait_ms)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            out, _ = proc.communicate(timeout=CAP_SECONDS)
            capped = False
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
            capped = True
        wall = time.time() - started

        m = re.search(r'RESULT ok=(\w+) millis=(-?\d+) wall_ms=(\d+)', out)
        record = {'case': name, 'mode': mode, 'wait_ms': wait_ms,
                  'wall_seconds': round(wall, 2), 'capped_at_%ds' % CAP_SECONDS: capped}
        if m:
            record['ok'] = (m.group(1) == 'true')
            record['probe_millis'] = int(m.group(2))
            record['harness_wall_ms'] = int(m.group(3))
        else:
            record['raw'] = out.strip()[-400:]
        return record
    finally:
        if srv is not None:
            srv.send_signal(signal.SIGKILL)
            srv.wait()


CASES = [
    ('A 正常隧道（keep-alive，两步都成）', 'normal', 15000, None),
    ('B 端口没人听（拒连）', 'refuse', 15000, None),
    ('C 对端收下不回，单步 15s 上限', 'hang', 15000, None),
    ('D 对端收下不回，单步 60s 上限（预算该先触发）', 'hang', 60000, None),
    ('E 对端先挂 30s 再回，单步 15s 上限', 'delay', 15000, ['--delay-ms', '30000']),
    ('F 慢滴 100ms/字节', 'drip', 15000, ['--drip-ms', '100']),
    ('G 慢滴 300ms/字节（每次 read 都在刷期限）', 'drip', 15000, ['--drip-ms', '300']),
    ('H 慢滴 800ms/字节', 'drip', 15000, ['--drip-ms', '800']),
]

results = []
for name, mode, wait_ms, extra in CASES:
    print('running %s ...' % name, file=sys.stderr, flush=True)
    results.append(run_case(name, mode, wait_ms, extra))
    print(json.dumps(results[-1], ensure_ascii=False), file=sys.stderr, flush=True)

print(json.dumps(results, ensure_ascii=False, indent=2))
