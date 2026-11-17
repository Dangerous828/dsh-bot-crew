#!/usr/bin/env python3
"""Capture an uninstrumented real send; query accessibility only before/after recording."""
import argparse
import datetime
import json
import re
import sqlite3
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
args = parser.parse_args()
o = args.directory
o.mkdir(parents=True, exist_ok=True)
b = ['adb', '-s', '9f9cc3db']
remote = '/sdcard/crew-pure-' + str(int(time.time())) + '.mp4'
events = []
recording = None
started = time.monotonic()

def run(*arguments):
    return subprocess.check_output(b + list(arguments), stderr=subprocess.DEVNULL)

def mark(event, **data):
    events.append({'seconds': round(time.monotonic() - started, 3), 'event': event, **data})

def snapshot(label):
    run('shell', 'uiautomator', 'dump', '/sdcard/crew-pure-snapshot.xml')
    path = o / (label + '.xml')
    run('pull', '/sdcard/crew-pure-snapshot.xml', str(path))
    return list(ET.parse(path).iter('node'))

def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    run('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))

assert run('shell', 'getprop', 'ro.product.device').decode().strip() == 'zorn'
run('shell', 'input', 'keyevent', '224')
run('shell', 'wm', 'dismiss-keyguard')
run('shell', 'am', 'start', '-n', 'com.dsh.botcrew/.MainActivity')
previous_queue = sqlite3.connect('file:/Users/cpuser/.dsh/state/superagent/mobileq.db?mode=ro', uri=True)
previous_queue.row_factory = sqlite3.Row
previous_reply = previous_queue.execute("SELECT id,text,to_msg FROM replies WHERE conversation='main' ORDER BY id DESC LIMIT 1").fetchone()
previous_queue.close()
assert previous_reply
(o / 'before-reply.json').write_text(json.dumps(dict(previous_reply), ensure_ascii=False, indent=2) + '\n')
for attempt in range(5):
    nodes = snapshot('before-focus')
    if any(n.get('text') == previous_reply['text'] and n.get('bounds') != '[0,0][0,0]' for n in nodes):
        break
else:
    raise AssertionError('Latest reply is not visible before keyboard focus')
field = [n for n in nodes if n.get('class') == 'android.widget.EditText'][-1]
assert not field.get('text'), 'Existing user draft must be preserved'
(o / 'before-focus.png').write_bytes(run('exec-out', 'screencap', '-p'))
tap(field)
for letter in 'hi':
    run('shell', 'input', 'text', letter)
    time.sleep(.15)
run('shell', 'input', 'keyevent', '62')
nodes = snapshot('record-initial')
field = [n for n in nodes if n.get('class') == 'android.widget.EditText'][-1]
assert field.get('text', '').strip() == 'hi', 'IME composition must be committed first'
send = next(n for n in nodes if n.get('text') == '发送' and n.get('enabled') == 'true')
(o / 'ime-open.png').write_bytes(run('exec-out', 'screencap', '-p'))
window = run('shell', 'dumpsys', 'window').decode()
starts = [m.start() for m in re.finditer(r'(?m)^[ \t]*Window #\d+ Window\{', window)]
blocks = [window[a:z] for a, z in zip(starts, starts[1:] + [len(window)])]
block = next((s for s in blocks if 'com.dsh.botcrew/' in s.splitlines()[0]), '')
(o / 'window-ime.txt').write_text('\n'.join(s for s in block.splitlines()
                                           if any(k in s for k in ['Window #', 'mAttrs=', 'Frames:', 'mGivenContentInsets'])) + '\n')
print({'header': next((n.get('bounds') for n in nodes if n.get('text') == '☰'), None),
       'composer': field.get('bounds'), 'preflight': 'ready'}, flush=True)
state_dir = Path('/Users/cpuser/.dsh/state/superagent')
queue = sqlite3.connect('file:' + str(state_dir / 'mobileq.db') + '?mode=ro', uri=True)
queue.row_factory = sqlite3.Row
store = sqlite3.connect('file:' + str(state_dir / 'orchestrator.sqlite') + '?mode=ro', uri=True)
before = queue.execute('SELECT MAX(id) FROM messages').fetchone()[0]
before_tickets = store.execute('SELECT COUNT(*) FROM ticket').fetchone()[0]
started = time.monotonic()
try:
    recording = subprocess.Popen(b + ['shell', 'screenrecord', '--size', '720x1600', '--bit-rate',
                                     '6000000', '--time-limit', '35', remote],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    mark('record_start')
    time.sleep(1)
    tap(send)
    mark('send_tap')
    seen = False
    while time.monotonic() - started < 24:
        if not seen:
            row = queue.execute("SELECT m.id,r.id AS reply_id FROM messages m JOIN replies r "
                                "ON r.to_msg=m.id AND r.conversation=m.conversation "
                                "WHERE m.id>? AND trim(m.text)='hi' ORDER BY m.id DESC LIMIT 1", (before,)).fetchone()
            if row:
                mark('reply_in_database', messageId=row['id'], replyId=row['reply_id'])
                seen = True
        time.sleep(.25)
    if int(re.findall(r'\d+', field.get('bounds'))[-1]) < 2720:
        run('shell', 'input', 'keyevent', '4')
        mark('hide_keyboard')
    _, error = recording.communicate(timeout=20)
    assert recording.returncode == 0, error.decode()
    mark('record_complete')
finally:
    if recording is not None:
        if recording.poll() is None:
            subprocess.run(b + ['shell', 'pkill', '-2', '-f', '^screenrecord.*' + remote], capture_output=True)
            recording.communicate(timeout=10)
        run('pull', remote, str(o / 'pure-send.mp4'))
        run('shell', 'rm', '-f', remote)
    (o / 'pure-events.json').write_text(json.dumps(events, ensure_ascii=False, indent=2) + '\n')
snapshot('record-after-ime')
(o / 'after-ime.png').write_bytes(run('exec-out', 'screencap', '-p'))
message = queue.execute("SELECT id,text,conversation FROM messages WHERE id>? AND trim(text)='hi' ORDER BY id DESC LIMIT 1", (before,)).fetchone()
assert message, 'No captured send reached the queue'
reply = queue.execute('SELECT id,text,to_msg FROM replies WHERE conversation=? AND to_msg=? ORDER BY id DESC LIMIT 1',
                      (message['conversation'], message['id'])).fetchone()
assert reply, 'No actual reply reached the queue during capture'
tickets = [json.loads(r[0]) for r in store.execute('SELECT value FROM ticket')]
opened = [ticket['id'] for ticket in tickets if not ticket.get('ended')]
decisions = [json.loads(r[0]) for r in store.execute('SELECT value FROM decision ORDER BY rowid DESC LIMIT 5')]
state = {'at': datetime.datetime.now().astimezone().isoformat(), 'message': dict(message), 'reply': dict(reply),
         'ticketCountBefore': before_tickets, 'ticketCount': len(tickets), 'openTicketIds': opened,
         'explicitlyViewedHistoricalTicket': None, 'expectedSubagentCard': False if not opened else None,
         'recentDecisions': [{'kind': d.get('kind'), 'threadKey': d.get('threadKey'),
                              'reasonCodes': [r.get('code') for r in d.get('reason', [])]} for d in decisions]}
(o / 'real-send-state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'events': events, 'state': state}, ensure_ascii=False))
