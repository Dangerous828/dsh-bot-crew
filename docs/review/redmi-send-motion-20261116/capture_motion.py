#!/usr/bin/env python3
"""Record a real short send, keeping the IME open across asynchronous refreshes."""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--serial', default='9f9cc3db')
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=True)
adb = ['adb', '-s', args.serial]
remote = '/sdcard/crew-motion-' + str(int(time.time())) + '.mp4'
events = []
started = time.monotonic()
recording = None

def run(*arguments):
    return subprocess.check_output(adb + list(arguments), stderr=subprocess.DEVNULL)

def mark(event, **data):
    events.append({'seconds': round(time.monotonic() - started, 3), 'event': event, **data})

def snapshot(label):
    run('shell', 'uiautomator', 'dump', '/sdcard/crew-motion-snapshot.xml')
    target = args.directory / (label + '.xml')
    run('pull', '/sdcard/crew-motion-snapshot.xml', str(target))
    nodes = list(ET.parse(target).iter('node'))
    mark('snapshot', label=label, texts=[node.get('text') for node in nodes if node.get('text')][-18:])
    return nodes

def tap(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    run('shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))

nodes = snapshot('before-focus')
field = [node for node in nodes if node.get('class') == 'android.widget.EditText'][-1]
assert not field.get('text'), 'Preserve any existing user draft; start with an empty composer'
events.clear()
started = time.monotonic()
try:
    recording = subprocess.Popen(adb + ['shell', 'screenrecord', '--size', '720x1600',
                                         '--bit-rate', '5000000', '--time-limit', '40', remote],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    mark('record_start')
    time.sleep(1)
    tap(field)
    mark('focus_composer')
    # Hardware key injection reaches the Chinese IME composing buffer; Space commits it first.
    for letter in 'hi':
        run('shell', 'input', 'text', letter)
        time.sleep(.15)
    run('shell', 'input', 'keyevent', '62')
    nodes = snapshot('record-initial')
    field = [node for node in nodes if node.get('class') == 'android.widget.EditText'][-1]
    assert field.get('text', '').strip() == 'hi', 'Input must be committed before tapping Send'
    tap(next(node for node in nodes if node.get('text') == '发送' and node.get('enabled') == 'true'))
    mark('send_tap')
    for index in range(4):
        nodes = snapshot('record-after-send-' + str(index))
        card = next((node for node in nodes if node.get('text') == '子代理'
                     or '个子代理' in node.get('text', '')), None)
        if card is not None and not any(event['event'] == 'tap_subagent' for event in events):
            tap(card)
            mark('tap_subagent')
            snapshot('record-expanded')
        time.sleep(.5)
    while time.monotonic() - started < 29:
        time.sleep(.25)
    nodes = snapshot('before-ime-close')
    field = [node for node in nodes if node.get('class') == 'android.widget.EditText'][-1]
    height = int(re.search(r'(\d+)x(\d+)', run('shell', 'wm', 'size').decode()).group(2))
    bottom = int(re.findall(r'\d+', field.get('bounds'))[-1])
    if bottom < height * .85:
        run('shell', 'input', 'keyevent', '4')
        mark('hide_keyboard')
    snapshot('record-after-ime')
    _, error = recording.communicate(timeout=30)
    assert recording.returncode == 0, error.decode()
    mark('record_complete')
finally:
    if recording is not None:
        if recording.poll() is None:
            subprocess.run(adb + ['shell', 'pkill', '-2', '-f', '^screenrecord.*' + remote], capture_output=True)
            recording.communicate(timeout=10)
        run('pull', remote, str(args.directory / 'send.mp4'))
        run('shell', 'rm', '-f', remote)
    (args.directory / 'events.json').write_text(json.dumps(events, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(events, ensure_ascii=False))
