#!/usr/bin/env python3
"""真实隧道上的失败路径：把「隧道那头」真的拿掉，看 probe() 怎么报、多久报、恢复后是否自愈。

做法全部落在真实链路上（Mac forward → win-desktop serve → win-desktop 本地服务），
不模拟、不改任何产品代码。每个阶段跑 N 轮 probe，记录 ok / millis / 墙钟。
"""
import json, os, re, subprocess, sys, time

CP = '/tmp/i20/out:/tmp/i20/harness:/tmp/kotlinc-copy/lib/kotlin-stdlib.jar'
WIN = 'win-desktop'


def ssh(cmd, timeout=40):
    return subprocess.run(['ssh', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', WIN, cmd],
                          capture_output=True, text=True, timeout=timeout)


def probe_rounds(n, wait_ms=15000):
    out = subprocess.run(['java', '-cp', CP, 'ProbeHarnessKt', '43511', 'tok', str(wait_ms), str(n)],
                         capture_output=True, text=True, timeout=60 * n + 60).stdout
    rows = []
    for line in out.splitlines():
        m = re.match(r'ROUND (\d+) ok=(\w+) millis=(-?\d+) wall_ms=(\d+)', line.strip())
        if m:
            rows.append({'round': int(m.group(1)), 'ok': m.group(2) == 'true',
                         'millis': int(m.group(3)), 'wall_ms': int(m.group(4))})
    return rows


def kill_server():
    ssh("powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='pythonw.exe'\\\" "
        "| Where-Object { $_.CommandLine -like '*i20-server*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"")


def start_server():
    ssh("powershell -NoProfile -Command \"$cmd='C:\\Users\\xc\\AppData\\Local\\Programs\\Python\\Python312\\pythonw.exe "
        "C:\\Users\\xc\\i20-server.py 43510 normal'; (Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
        "-Arguments @{CommandLine=$cmd}).ProcessId\"")


def listener_count():
    r = ssh("powershell -NoProfile -Command \"(Get-NetTCPConnection -LocalPort 43510 -State Listen "
            "-EA SilentlyContinue | Measure-Object).Count\"")
    return int((r.stdout or '0').strip().splitlines()[-1] or 0)


result = {'phases': []}

print('== phase 1: 基线（隧道那头在） ==', file=sys.stderr)
rows = probe_rounds(5)
result['phases'].append({'name': 'baseline', 'ok': sum(r['ok'] for r in rows), 'n': len(rows),
                         'millis': [r['millis'] for r in rows], 'wall_ms': [r['wall_ms'] for r in rows]})

print('== phase 2: 拿掉隧道那头的服务（accept 还在，后端没了） ==', file=sys.stderr)
kill_server()
time.sleep(2)
result['listener_after_kill'] = listener_count()
rows = probe_rounds(5)
result['phases'].append({'name': 'backend_down', 'ok': sum(r['ok'] for r in rows), 'n': len(rows),
                         'millis': [r['millis'] for r in rows], 'wall_ms': [r['wall_ms'] for r in rows]})

print('== phase 3: 恢复后端，看是否自愈 ==', file=sys.stderr)
start_server()
time.sleep(3)
result['listener_after_restart'] = listener_count()
rows = probe_rounds(5)
result['phases'].append({'name': 'recovered', 'ok': sum(r['ok'] for r in rows), 'n': len(rows),
                         'millis': [r['millis'] for r in rows], 'wall_ms': [r['wall_ms'] for r in rows]})

print(json.dumps(result, ensure_ascii=False, indent=2))
