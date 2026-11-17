#!/usr/bin/env python3
"""Small native acceptance driver.

Default target is the owned headless emulator-5586; a physical phone must be named
explicitly via CREW_SERIAL (only the whitelist below is accepted). On a physical phone
prefs under /data/data are unreadable (release build, no root), so callers must fall back
to on-screen evidence instead of reading crew-sends.xml.
"""
import argparse
import json
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ADB = '/Users/cpuser/Library/Android/sdk/platform-tools/adb'
# Default stays the owned emulator; a physical phone must be named explicitly via CREW_SERIAL.
SERIAL = os.environ.get('CREW_SERIAL', 'emulator-5586')
ALLOWED_SERIALS = ('emulator-5586', '9f9cc3db')
if SERIAL not in ALLOWED_SERIALS:
    raise SystemExit(f'CREW_SERIAL must be one of {ALLOWED_SERIALS}, got {SERIAL!r}')
PACKAGE = 'com.dsh.botcrew'
ROOT = Path(__file__).resolve().parent / 'native'
ROOT.mkdir(exist_ok=True)


def adb(*args):
    # The physical phone drops its USB link intermittently. Retry transport-layer failures a few
    # times so a transient disconnect is not scored as an acceptance failure; real command errors
    # (permission denied, missing file) still raise.
    for attempt in range(4):
        result = subprocess.run([ADB, '-s', SERIAL, *args], capture_output=True)
        if result.returncode == 0:
            return result.stdout
        message = result.stderr.decode(errors='replace')
        transient = any(word in message for word in ('not found', 'offline', 'closed', 'no devices'))
        if transient and attempt < 3:
            time.sleep(1.5)
            continue
        raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
    raise RuntimeError('adb retries exhausted')


def wake():
    """A physical phone dozes during a long journey and `uiautomator dump` then returns a
    hierarchy without our package. Wake it and drop the keyguard; on an already-awake device
    with the app in front this never fires, so the emulator flow is unchanged."""
    adb('shell', 'input', 'keyevent', '224')
    time.sleep(0.4)
    adb('shell', 'wm', 'dismiss-keyguard')
    time.sleep(0.8)


def tree(name='current'):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', name):
        raise ValueError('artifact name must be a basename')
    path = ROOT / (name + '.xml')
    for attempt in range(3):
        adb('shell', 'uiautomator', 'dump', '/sdcard/crew-product.xml')
        adb('pull', '/sdcard/crew-product.xml', str(path))
        root = ET.fromstring(path.read_bytes())
        # Awake and in our app: this is a real frame. Empty or foreign hierarchy: the screen
        # slept or another window owns it — wake and re-read instead of scoring a false failure.
        if any(node.get('package') == PACKAGE for node in root.iter('node')):
            return root, path
        if attempt < 2:
            wake()
    return root, path


def visible_nodes(root):
    rows = []
    for node in root.iter('node'):
        text = node.get('text') or node.get('content-desc')
        if text:
            rows.append({'text': text, 'class': node.get('class'), 'bounds': node.get('bounds'),
                         'enabled': node.get('enabled'), 'package': node.get('package')})
    return rows


def tap(text=None, contains=None, description=None, node_class=None, index=None):
    root, _ = tree()
    matches = []
    for node in root.iter('node'):
        if node.get('package') != PACKAGE or node.get('enabled') != 'true':
            continue
        if text is not None and node.get('text') != text:
            continue
        if contains is not None and contains not in (node.get('text') or ''):
            continue
        if description is not None and node.get('content-desc') != description:
            continue
        if node_class is not None and node.get('class') != node_class:
            continue
        coordinates = [int(n) for n in re.findall(r'\d+', node.get('bounds') or '')]
        if len(coordinates) == 4 and coordinates[2] > coordinates[0] and coordinates[3] > coordinates[1]:
            matches.append(coordinates)
    # Compose sometimes exposes both the clickable wrapper and identical child text bounds.
    matches = list(dict.fromkeys(tuple(row) for row in matches))
    if index is None and len(matches) != 1:
        raise ValueError(f'expected one native match; found {len(matches)} for {text or contains or description or node_class}')
    bounds = matches[index or 0]
    adb('shell', 'input', 'tap', str((bounds[0] + bounds[2]) // 2), str((bounds[1] + bounds[3]) // 2))
    return bounds


def type_text(text):
    if not re.fullmatch(r'[A-Za-z0-9 _.-]+', text):
        raise ValueError('test input must be shell-inert ASCII words')
    adb('shell', 'input', 'text', text.replace(' ', '%s'))


def composer(root):
    """The composer is the bottom-most EditText; an approval card also carries its own
    "write a line" field above it, so the only stable selector is vertical position."""
    fields = [node for node in root.iter('node')
              if node.get('package') == PACKAGE and node.get('class') == 'android.widget.EditText']
    if not fields:
        raise ValueError('no native EditText on screen')
    return max(fields, key=lambda node: int(re.findall(r'\d+', node.get('bounds') or '0')[1]))


def composer_text(root=None):
    return composer(root if root is not None else tree()[0]).get('text', '')


def tap_composer():
    field = composer(tree()[0])
    x1, y1, x2, y2 = [int(n) for n in re.findall(r'\d+', field.get('bounds'))]
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def clear():
    tap_composer()
    for _ in range(4):
        text = composer_text()
        if not text:
            return
        adb('shell', 'input', 'keyevent', '123')
        time.sleep(.2)
        for _ in range(len(text) + 1):
            adb('shell', 'input', 'keyevent', '67')
        time.sleep(.3)
    raise AssertionError('native field did not become empty after delete events')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['tree', 'screen', 'tap', 'type', 'clear', 'start', 'stop', 'back', 'wait'])
    parser.add_argument('--name', default='current')
    parser.add_argument('--text')
    parser.add_argument('--contains')
    parser.add_argument('--description')
    parser.add_argument('--class', dest='node_class')
    parser.add_argument('--index', type=int)
    parser.add_argument('--timeout', type=float, default=20)
    args = parser.parse_args()
    if adb('get-state').decode().strip() != 'device':
        raise RuntimeError(f'{SERIAL} is not connected as a device')
    if args.action == 'tree':
        root, path = tree(args.name)
        print(json.dumps({'path': str(path), 'nodes': visible_nodes(root)}, ensure_ascii=False))
    elif args.action == 'screen':
        path = ROOT / (args.name + '.png')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', args.name):
            raise ValueError('artifact name must be a basename')
        path.write_bytes(adb('exec-out', 'screencap', '-p'))
        print(path)
    elif args.action == 'tap':
        print(tap(args.text, args.contains, args.description, args.node_class, args.index))
    elif args.action == 'type':
        type_text(args.text or '')
    elif args.action == 'clear':
        tap_composer()
        adb('shell', 'input', 'keycombination', '113', '29')
        adb('shell', 'input', 'keyevent', '67')
    elif args.action == 'start':
        adb('shell', 'am', 'start', '-n', PACKAGE + '/.MainActivity')
    elif args.action == 'stop':
        adb('shell', 'am', 'force-stop', PACKAGE)
    elif args.action == 'back':
        adb('shell', 'input', 'keyevent', '4')
    elif args.action == 'wait':
        if not 0 < args.timeout <= 30:
            raise ValueError('wait must be bounded to 30 seconds')
        deadline = time.monotonic() + args.timeout
        while True:
            root, path = tree(args.name)
            labels = [row['text'] for row in visible_nodes(root)]
            if args.text in labels or args.contains is not None and any(args.contains in label for label in labels):
                print(json.dumps({'found': args.text or args.contains, 'path': str(path)}, ensure_ascii=False))
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(f'native text not seen: {args.text or args.contains}')
            time.sleep(0.5)


if __name__ == '__main__':
    main()
