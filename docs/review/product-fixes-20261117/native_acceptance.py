#!/usr/bin/env python3
"""Native journeys on the target device (CREW_SERIAL: emulator-5586 or the owned phone) and the
marker-protected synthetic carrier."""
import datetime
import json
import time
import urllib.request
import native_probe as u

HEADERS = {'x-crew-device': 'product-fixture-device', 'x-crew-credential': 'fixture-only-not-a-production-credential', 'Content-Type': 'application/json'}
BASE = 'http://127.0.0.1:18888'
RESULT = u.ROOT.parent / 'NATIVE_CHECK.json'
checks = []


def api(path, data=None):
    req = urllib.request.Request(BASE + path, headers=HEADERS, data=None if data is None else json.dumps(data).encode())
    return json.load(urllib.request.urlopen(req, timeout=10))


def control(**data):
    return api('/__fixture', data)


def labels(name='current'):
    root, _ = u.tree(name)
    return [row['text'] for row in u.visible_nodes(root)]


def wait_text(text, name, timeout=16, exact=False):
    end = time.monotonic() + timeout
    while True:
        values = labels(name)
        if any((text == value if exact else text in value) for value in values):
            return values
        if time.monotonic() >= end:
            raise AssertionError({'missing': text, 'visible': values})
        time.sleep(.5)


def editor():
    root, _ = u.tree()
    return u.composer_text(root)


def capture(name):
    (u.ROOT / (name + '.png')).write_bytes(u.adb('exec-out', 'screencap', '-p'))


def check(name, **details):
    checks.append({'name': name, 'passed': True, **details})
    RESULT.write_text(json.dumps({'at': datetime.datetime.now().astimezone().isoformat(), 'syntheticOnly': True, 'serial': u.SERIAL, 'checks': checks}, ensure_ascii=False, indent=2) + '\n')
    print(name, flush=True)


def switch(current, target):
    u.tap(text=current + ' ▾')
    wait_text(target, 'session-picker', exact=True)
    u.tap(text=target)
    wait_text(target + ' ▾', 'session-' + target, exact=True)


def send(text):
    assert editor() == ''
    u.tap_composer(); u.type_text(text)
    assert editor() == text, 'input must be complete before sending'
    u.tap(text='发送')
    if 'mInputShown=true' in u.adb('shell', 'dumpsys', 'input_method').decode(errors='replace'):
        u.adb('shell', 'input', 'keyevent', '4')
    end = time.monotonic() + 10
    while True:
        data = api('/api/mobile/timeline?session_id=main')
        row = next((item for item in data['items'] if item.get('role') == 'user' and item.get('text') == text), None)
        if row:
            return int(row['id'].removeprefix('m')), row['request_id']
        if time.monotonic() >= end:
            raise AssertionError('native send did not reach isolated queue')
        time.sleep(.3)


def main():
    control(action='online')
    mid, rid = send('Native-state-' + str(int(time.time())))
    for phase, copy in [('evaluating', '评估中'), ('model', '模型处理中'), ('tool', '使用工具'), ('retrying', '正在重试模型请求')]:
        control(action='phase', messageId=mid, phase=phase)
        wait_text(copy, 'state-' + phase)
        check('native-' + phase, requestId=rid)
    control(action='ack', messageId=mid)
    row = next(item for item in api('/api/mobile/timeline?session_id=main')['items'] if item.get('request_id') == rid)
    assert row['request_state'] != 'replied'
    check('ack-does-not-complete-request')
    capture('active-retry')
    control(action='phase', messageId=mid, phase='ended')
    control(action='reply', messageId=mid)
    wait_text('验收回复：任务已完成。', 'state-replied')
    check('typed-reply-visible')
    u.tap(node_class='android.widget.EditText'); u.type_text('Draft-main-01'); u.adb('shell', 'input', 'keyevent', '4')
    switch('main', 'work')
    assert editor() == ''
    u.tap(node_class='android.widget.EditText'); u.type_text('Draft-work-01'); u.adb('shell', 'input', 'keyevent', '4')
    switch('work', 'main')
    assert editor() == 'Draft-main-01'
    u.adb('shell', 'am', 'force-stop', u.PACKAGE); u.adb('shell', 'am', 'start', '-n', u.PACKAGE + '/.MainActivity')
    wait_text('main ▾', 'draft-restart', exact=True)
    assert editor() == 'Draft-main-01'
    switch('main', 'work'); assert editor() == 'Draft-work-01'
    check('drafts-survive-session-switch-and-process-death')
    capture('draft-work-restored')
    u.clear(); u.adb('shell', 'input', 'keyevent', '4')
    switch('work', 'main'); u.clear(); u.adb('shell', 'input', 'keyevent', '4')
    assert editor() == ''


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        capture('failure')
        checks.append({'passed': False, 'error': str(error)})
        RESULT.write_text(json.dumps({'at': datetime.datetime.now().astimezone().isoformat(),
                                      'syntheticOnly': True, 'serial': u.SERIAL, 'checks': checks},
                                     ensure_ascii=False, indent=2) + '\n')
        raise
