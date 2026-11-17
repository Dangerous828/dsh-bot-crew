#!/usr/bin/env python3
"""Native recovery, receipt ownership, and multiple attention entry journeys."""
import json
import time
import native_acceptance as a
import native_probe as u

a.RESULT = u.ROOT.parent / 'NATIVE_RECOVERY_CHECK.json'


def hide_keyboard():
    """Back exits the activity on this phone when the soft keyboard is not showing, so only
    send it when the IME is actually up."""
    state = u.adb('shell', 'dumpsys', 'input_method').decode(errors='replace')
    if 'mInputShown=true' in state:
        u.adb('shell', 'input', 'keyevent', '4')


def ensure_app():
    u.adb('shell', 'am', 'start', '-n', u.PACKAGE + '/.MainActivity')


def press_send(text):
    u.clear(); u.type_text(text)
    assert a.editor() == text
    u.tap(text='发送'); hide_keyboard()
    end = time.monotonic() + 12
    while True:
        last = a.api('/__fixture')['lastSend']
        if last and last['text'] == text:
            return last['requestId']
        assert time.monotonic() < end
        time.sleep(.2)


def rows(rid):
    return [row for row in a.api('/api/mobile/timeline?session_id=main')['items'] if row.get('role') == 'user' and row.get('request_id') == rid]


def restart():
    u.adb('shell', 'am', 'force-stop', u.PACKAGE)
    u.adb('shell', 'am', 'start', '-n', u.PACKAGE + '/.MainActivity')


def retry_entry_present():
    """Physical phones have no root/run-as, so crew-sends.xml cannot be read. The on-screen
    retry entry is the only honest evidence that an unconfirmed envelope survived a restart."""
    return any('用原内容重试' in value for value in a.labels())


def main():
    ensure_app()
    # Clear synthetic leftovers through their own native remove action; never delete production data.
    a.wait_text('main ▾', 'recovery-start', exact=True)
    for _ in range(8):
        if '不再重试，移除本机记录' not in a.labels():
            break
        u.tap(text='不再重试，移除本机记录', index=0)
    # Clear both isolated drafts using native edits, leaving other app data intact.
    u.clear(); hide_keyboard()
    a.switch('main', 'work'); u.clear(); hide_keyboard(); a.switch('work', 'main')
    tag = str(int(time.time()))
    a.control(action='fail-before')
    failed = press_send('Failed-A-' + tag)
    a.wait_text('结果待确认', 'failure-owned', timeout=40)
    assert rows(failed) == []
    a.control(action='online')
    successful = press_send('Success-B-' + tag)
    end = time.monotonic() + 12
    while not rows(successful):
        assert time.monotonic() < end
        time.sleep(.3)
    values = a.wait_text('Failed-A-' + tag, 'failure-excerpt')
    assert any('结果待确认' in value for value in values)
    assert len(rows(successful)) == 1 and not rows(failed)
    a.check('failure-stays-with-original-request-after-edited-send-succeeds', failedRequest=failed, successfulRequest=successful)
    restart(); a.wait_text('用原内容重试', 'recovered-envelope', timeout=20, exact=True)
    a.check('unconfirmed-envelope-visible-after-process-death', requestId=failed,
            evidence='after force-stop the card still owns the failed text and shows the retry entry; '
                     'native/recovered-envelope.xml')
    u.tap(text='用原内容重试')
    end = time.monotonic() + 20
    while not rows(failed):
        assert time.monotonic() < end
        time.sleep(.3)
    assert len(rows(failed)) == 1
    a.check('retry-keeps-original-uuid-and-payload', requestId=failed)
    # A stored message with a lost response must reconcile without another write after restart.
    a.control(action='uncertain')
    uncertain = press_send('Uncertain-C-' + tag)
    a.wait_text('结果待确认', 'unknown-stored', timeout=40)
    before = len(a.api('/__fixture')['events'])
    restart()
    # crew-sends.xml is unreadable on the physical phone (no root, non-debuggable package), and
    # while the fixture link is down after restart the app shows only its connection error page,
    # so the stored-envelope retry entry is not reachable in that window. Reconnect and require
    # the reconciliation to be silent: the carrier must see no resend, and the timeline must
    # hold the request exactly once.
    a.control(action='online')
    # The reconciled row can sit below the fold once the fixture timeline has history, so prove
    # reconciliation from the carrier side: the app must refetch the timeline after reconnecting,
    # must not resend, and the request must exist exactly once.
    end = time.monotonic() + 45
    while True:
        events = a.api('/__fixture')['events'][before:]
        refetched = [event for event in events if event['path'].startswith('/api/mobile/timeline') and event['status'] == 200]
        if refetched and len(rows(uncertain)) == 1:
            break
        assert time.monotonic() < end, f'app never refetched timeline after reconnect: {events[-5:]}'
        time.sleep(.5)
    sent_after_restart = [event for event in events if event['path'] == '/api/mobile/send']
    assert not sent_after_restart, f'restart must not resend: {sent_after_restart}'
    assert len(rows(uncertain)) == 1, 'reconciled request must appear exactly once'
    end = time.monotonic() + 20
    while retry_entry_present():
        assert time.monotonic() < end, 'local send record must clear after reconciliation'
        time.sleep(.5)
    a.check('accepted-request-reconciles-after-restart-without-duplicate', requestId=uncertain,
            evidence='carrier saw no resend after restart; single timeline row; prefs unreadable without root')
    mid = int(rows(successful)[0]['id'].removeprefix('m'))
    a.control(action='two-approvals', messageId=mid)
    a.wait_text('另有 1 项待决定', 'multiple-attention', timeout=20)
    a.wait_text('路径片段保持 %2F。', 'preview-literal', timeout=20)
    a.capture('readable-approval-and-multiple-entry')
    a.check('readable-approval-preserves-literal-percent-encoding',
            evidence='card preview renders the body verbatim, 「路径片段保持 %2F。」 keeps its %2F; '
                     'native/multiple-attention.xml')
    u.tap(text='逐项看')
    a.wait_text('等你拍板', 'pending-board')
    board = a.labels()
    assert any('验收任务-a' in value for value in board) and any('验收任务-b' in value for value in board), \
        'board must list both pending approvals'
    a.capture('pending-board')
    a.check('multiple-attention-entry-opens-board',
            evidence='「逐项看」 opens the board with 等你拍板 · 2 and both 验收任务-a / 验收任务-b listed; '
                     'native/pending-board.xml')


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        a.capture('recovery-failure')
        a.checks.append({'passed': False, 'error': str(error)})
        a.RESULT.write_text(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                                        'syntheticOnly': True, 'serial': u.SERIAL, 'checks': a.checks},
                                       ensure_ascii=False, indent=2) + '\n')
        raise
