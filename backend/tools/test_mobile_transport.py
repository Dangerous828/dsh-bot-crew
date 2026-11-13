"""Exercise the real gateway and queue in a temporary DSH home (no running agent)."""
import http.client
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import unittest.mock
import urllib.error
import urllib.request

TOOLS = Path(__file__).resolve().parent
# #14 第 2 项的 header 形态；与网关 SESSION_HEADER、契约 §1 同一字面值。
SESSION_HEADER = 'x-crew-session'


class MobileTransportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = dict(os.environ, DSH_HOME=self.temp.name)
        with unittest.mock.patch.dict(os.environ, self.env):
            loader = importlib.machinery.SourceFileLoader('mobilegw_test', str(TOOLS / 'mobilegw'))
            spec = importlib.util.spec_from_loader(loader.name, loader)
            self.gateway = importlib.util.module_from_spec(spec)
            loader.exec_module(self.gateway)
        self.server = self.gateway.ThreadingHTTPServer(('127.0.0.1', 0), self.gateway.H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:%s' % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, body=None, token=True, extra_headers=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-GW-Token'] = self.gateway.TOKEN
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(self.url + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def queue(self, *args):
        output = subprocess.check_output([str(TOOLS / 'mobileq'), *args], env=self.env, text=True)
        return json.loads(output)

    def test_follow_up_has_both_sides_of_context_without_reusing_task_ownership(self):
        first = self.request('/send', {'text': '项目名称是什么？'})[1]['id']
        self.queue('reply', '--conversation', 'main', '--to', str(first), '--key', 'answer-1', '--text', '项目叫 Muse。')
        second = self.request('/send', {'text': '继续这个项目。'})[1]['id']
        pulled = self.queue('pull', '--after', '0', '--json')['items']
        self.assertEqual([m['thread'] for m in pulled], [first, second], 'the router must retain ownership of new task admission')
        context = self.queue('thread', '--conversation', 'main', '--root', str(second), '--json')['items']
        self.assertEqual([m['text'] for m in context], ['项目名称是什么？', '项目叫 Muse。', '继续这个项目。'])
        self.assertTrue(context[1]['sender']['bot'])
        self.assertEqual(context[-1]['id'], second)

    def test_retry_is_idempotent(self):
        body = {'text': '执行一次', 'request_id': 'phone-request-1'}
        self.assertEqual(self.request('/send', body)[1]['id'], self.request('/send', body)[1]['id'])
        self.assertEqual(len(self.queue('pull', '--after', '0', '--json')['items']), 1)

    def test_invalid_payload_returns_client_error(self):
        for body in ([], {'text': 42}, {'text': '   '}, {'text': 'ok', 'sender': 'intruder'}):
            with self.subTest(body=body):
                self.assertEqual(self.request('/send', body)[0], 400)

    def test_withdraw_hides_an_unread_message_from_timeline_and_pull(self):
        sent = self.request('/send', {'text': '这条反悔了', 'request_id': 'withdraw-1'})[1]
        self.assertIn('withdraw-1', [item.get('request_id') for item in self.request('/timeline')[1]['items']])
        status, body = self.request('/withdraw', {'request_id': 'withdraw-1'})
        self.assertEqual((status, body), (200, {'ok': True, 'id': sent['id'], 'request_id': 'withdraw-1'}))
        self.assertNotIn('withdraw-1', [item.get('request_id') for item in self.request('/timeline')[1]['items']])
        self.assertEqual(self.queue('pull', '--after', '0', '--json')['items'], [], 'a withdrawn message must never reach a worker')

    def test_withdraw_refuses_an_answered_or_already_picked_up_message(self):
        answered = self.request('/send', {'text': '已经答了', 'request_id': 'withdraw-2'})[1]['id']
        self.queue('reply', '--conversation', 'main', '--to', str(answered), '--key', 'withdraw-2-reply', '--text', '答')
        self.assertEqual(self.request('/withdraw', {'request_id': 'withdraw-2'})[0], 409)
        # A pull is the worker taking the message; after it, taking the message back would disagree with it.
        self.request('/send', {'text': '已经读走', 'request_id': 'withdraw-3'})
        self.queue('pull', '--after', '0', '--json')
        status, body = self.request('/withdraw', {'request_id': 'withdraw-3'})
        self.assertEqual((status, body['error']), (409, 'message was already picked up'))
        # The refused messages stay in the conversation rather than disappearing silently.
        users = [item.get('request_id') for item in self.request('/timeline')[1]['items'] if item.get('role') == 'user']
        self.assertEqual(users, ['withdraw-2', 'withdraw-3'])

    def test_withdraw_twice_conflicts_and_unknown_request_is_not_found(self):
        self.request('/send', {'text': '撤回一次', 'request_id': 'withdraw-4'})
        self.assertEqual(self.request('/withdraw', {'request_id': 'withdraw-4'})[0], 200)
        self.assertEqual(self.request('/withdraw', {'request_id': 'withdraw-4'})[0], 409)
        self.assertEqual(self.request('/withdraw', {'request_id': 'never-sent'})[0], 404)
        # Re-sending the withdrawn request_id must not resurrect the row.
        self.request('/send', {'text': '撤回一次', 'request_id': 'withdraw-4'})
        self.assertEqual(self.request('/timeline')[1]['items'], [])

    def test_withdraw_validates_request_id_and_auth(self):
        for body in ([], {}, {'request_id': 42}, {'request_id': ''}, {'request_id': 'x' * 129}):
            with self.subTest(body=body):
                self.assertEqual(self.request('/withdraw', body)[0], 400)
        self.assertEqual(self.request('/withdraw', {'request_id': 'x'}, token=False)[0], 401)

    def test_timeline_reads_in_time_order_and_says_which_message_a_reply_answers(self):
        first = self.request('/send', {'text': '第一问', 'request_id': 'order-1'})[1]['id']
        self.request('/send', {'text': '第二问', 'request_id': 'order-2'})
        # 回复挂在第一问下，但它发生在第二问之后：按时间读，不能插回第一问下面。
        self.queue('reply', '--conversation', 'main', '--to', str(first), '--key', 'order-reply', '--text', '答第一问')
        items = self.request('/timeline')[1]['items']
        self.assertEqual([item['text'] for item in items], ['第一问', '第二问', '答第一问'])
        reply = items[-1]
        self.assertEqual(reply['reply_to'], 'm%d' % first)

    def test_timeline_reports_which_messages_the_crew_picked_up(self):
        # 「未读」唯一的证据就是这个字段（契约 §5.6）。没读过是空串，被 pull/claim 取走之后有值。
        # 先发一条、让它被取走，再发一条留在队列里，两种状态就同时出现在一份时间线里。
        self.request('/send', {'text': '会被读走', 'request_id': 'unread-1'})
        self.queue('pull', '--after', '0', '--json')
        self.request('/send', {'text': '还没读', 'request_id': 'unread-2'})
        items = self.request('/timeline')[1]['items']
        by_request = {item['request_id']: item for item in items}
        self.assertNotEqual(by_request['unread-1']['read_at'], '', '被取走的消息该有读走的时刻')
        self.assertEqual(by_request['unread-2']['read_at'], '', '还在队列里的是空串')
        # 键必须一直在：缺席会被上游读成「这份时间线说不清」，那是另一种状态。
        for item in items:
            self.assertIn('read_at', item)

    def test_claim_takes_a_message_out_of_the_queue_for_a_steer(self):
        sent = self.request('/send', {'text': '插一句', 'request_id': 'steer-1'})[1]
        status, body = self.request('/claim', {'request_id': 'steer-1'})
        self.assertEqual((status, body['text']), (200, '插一句'))
        # claim 之后 pull 不该再把同一条交给路由，否则 worker 会收到两遍。
        pulled = self.queue('pull', '--after', '0', '--json')['items']
        self.assertNotIn('插一句', [item.get('text') for item in pulled])
        # 已经 claim 过（=已被读走）不能再 claim；已回复/不存在也各有明确的错。
        self.assertEqual(self.request('/claim', {'request_id': 'steer-1'})[0], 409)
        self.assertEqual(self.request('/claim', {'request_id': 'nope'})[0], 404)
        self.assertEqual(self.request('/claim', {'request_id': ''})[0], 400)
        answered = self.request('/send', {'text': '已答', 'request_id': 'steer-2'})[1]
        self.queue('reply', '--conversation', 'main', '--to', str(answered['id']), '--key', 'steer-reply', '--text', '答')
        self.assertEqual(self.request('/claim', {'request_id': 'steer-2'})[0], 409)

    def test_send_with_steer_is_never_routed_again(self):
        # 发送即插队：消息写进时间线，但 pull 不能再把它当新活接一次。
        sent = self.request('/send', {'text': '顺便看一眼', 'request_id': 'steer-send', 'steer': True})[1]
        self.assertEqual(self.request('/claim', {'request_id': 'steer-send'})[0], 409)
        pulled = self.queue('pull', '--after', '0', '--json')['items']
        self.assertNotIn('顺便看一眼', [item.get('text') for item in pulled])
        texts = [item.get('text') for item in self.request('/timeline')[1]['items']]
        self.assertIn('顺便看一眼', texts)

    def test_auth_and_exact_routes(self):
        self.assertEqual(self.request('/timeline', token=False)[0], 401)
        self.assertEqual(self.request('/timeline-unrelated')[0], 404)
        self.assertEqual(self.request('/send-unrelated', {'text': 'hello'})[0], 404)
    # --- S1: one request, one session; the queue column is never a process constant ---
    # Contract §1/§2/§3: session_id defaults to main, shape ^[a-z0-9][a-z0-9-]{0,31}$,
    # malformed -> 400 invalid_session, and GET /timeline echoes session_id + session_api: 1.
    # #14 第 2 项：query 优先、x-crew-session header 兜底；两者都给且不一致 -> 400，
    # 不许猜哪个算数。能力位判据（_send 一处）同步扩到 header：显式带 header 的
    # 请求，所有响应都回显 session_id + session_api:1。老调用（既无 query 也无
    # header）一个字段不加。绝不按 #14 字面「header 未识别就静默按 main 落库」——
    # 那会重新引入 C4 串线；下面的 header 用例就是这条裁决的可执行证据。

    def test_two_sessions_can_reuse_one_request_id_and_stay_apart(self):
        # UNIQUE(conversation, request_id) is per session: the same phone retry key in two
        # sessions must insert two rows, not be deduplicated across the wire.
        main_sent = self.request('/send?session_id=main', {'text': 'A 侧', 'request_id': 'shared-1'})[1]
        work_sent = self.request('/send?session_id=work', {'text': 'B 侧', 'request_id': 'shared-1'})[1]
        self.assertNotEqual(main_sent['id'], work_sent['id'])
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=main')[1]['items']], ['A 侧'])
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=work')[1]['items']], ['B 侧'])
        # Same key, same text, same session stays idempotent (the old contract).
        self.assertEqual(self.request('/send?session_id=work', {'text': 'B 侧', 'request_id': 'shared-1'})[1]['id'], work_sent['id'])
        self.assertEqual(len(self.request('/timeline?session_id=work')[1]['items']), 1)

    def test_withdraw_and_claim_stay_inside_their_session(self):
        self.request('/send?session_id=work', {'text': '只在 work', 'request_id': 'cross-1'})
        # Neither endpoint may find a row that belongs to another conversation.
        self.assertEqual(self.request('/withdraw?session_id=main', {'request_id': 'cross-1'})[0], 404)
        self.assertEqual(self.request('/claim?session_id=main', {'request_id': 'cross-1'})[0], 404)
        # A cross-session miss must not consume the row; work can still claim/withdraw it.
        self.assertEqual(self.request('/claim?session_id=work', {'request_id': 'cross-1'})[0], 200)
        self.assertEqual(self.request('/withdraw?session_id=work', {'request_id': 'cross-1'})[0], 409)

    def test_answered_check_does_not_borrow_another_sessions_reply(self):
        # mobileq writes replies with an explicit --conversation. Plant a reply under main
        # pointing at work's message id: work's answered-checks must not see it. If either
        # SELECT still uses a process-level conversation, these two succeed-by-accident.
        work_id = self.request('/send?session_id=work', {'text': 'B 侧', 'request_id': 'reply-1'})[1]['id']
        self.queue('reply', '--conversation', 'main', '--to', str(work_id), '--key', 'main-reply-1', '--text', '别串')
        self.assertEqual(self.request('/withdraw?session_id=work', {'request_id': 'reply-1'})[0], 200)
        work_id2 = self.request('/send?session_id=work', {'text': 'B 侧 2', 'request_id': 'reply-2'})[1]['id']
        self.queue('reply', '--conversation', 'main', '--to', str(work_id2), '--key', 'main-reply-2', '--text', '别串 2')
        status, body = self.request('/claim?session_id=work', {'request_id': 'reply-2'})
        self.assertEqual((status, body.get('text')), (200, 'B 侧 2'))

    def test_timeline_replies_are_scoped_to_the_requested_session(self):
        main_id = self.request('/send?session_id=main', {'text': 'A 侧', 'request_id': 'scope-1'})[1]['id']
        self.queue('reply', '--conversation', 'main', '--to', str(main_id), '--key', 'scope-reply', '--text', 'A 的答')
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=work')[1]['items']], [])
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=main')[1]['items']], ['A 侧', 'A 的答'])

    def test_timeline_echoes_session_and_capability_bit(self):
        self.request('/send?session_id=main', {'text': 'A 侧', 'request_id': 'echo-1'})
        work = self.request('/timeline?session_id=work')[1]
        self.assertEqual((work['session_id'], work['session_api']), ('work', 1))
        main = self.request('/timeline?session_id=main')[1]
        self.assertEqual((main['session_id'], main['session_api']), ('main', 1))
        # Legacy call: byte-for-byte the old body, plus exactly the two new fields.
        legacy = self.request('/timeline')[1]
        self.assertEqual(set(legacy), {'items', 'session_id', 'session_api'})
        self.assertEqual((legacy['session_id'], legacy['session_api']), ('main', 1))
        self.assertEqual(legacy['items'], main['items'])

    def test_every_explicit_session_response_carries_the_capability_bit(self):
        """能力位不只属于 timeline：直发 send / withdraw / claim 到老网关也必须能被认出来。

        老调用（query 不带 session_id）一个字段都不加，响应逐字不变。
        """
        code, sent = self.request('/send?session_id=work', {'text': 'B 侧', 'request_id': 'cap-1'})
        self.assertEqual(code, 200)
        self.assertEqual((sent['session_id'], sent['session_api']), ('work', 1))
        code, claimed = self.request('/claim?session_id=work', {'request_id': 'cap-1'})
        self.assertEqual(code, 200)
        self.assertEqual((claimed['session_id'], claimed['session_api']), ('work', 1))
        code, withdrawn = self.request('/withdraw?session_id=work', {'request_id': 'cap-1'})
        # 已被 claim 的消息撤不回来，但 409 也一样带能力位：任何响应都不能让消息面误判。
        self.assertEqual((withdrawn['session_id'], withdrawn['session_api']), ('work', 1))
        # 老调用逐字不变：send 响应仍是原来那三个键。
        code, legacy = self.request('/send', {'text': 'A 侧', 'request_id': 'cap-legacy'})
        self.assertEqual(code, 200)
        self.assertEqual(set(legacy), {'ok', 'id', 'request_id'})

    def test_invalid_session_id_is_rejected_with_400(self):
        bad = ['WORK', 'work%20x', 'w' * 33, '-lead', 'under_score', 'main%0A', '']
        for value in bad:
            with self.subTest(value=value):
                for path, body in (('/timeline?session_id=' + value, None),
                                   ('/health?session_id=' + value, None),
                                   ('/send?session_id=' + value, {'text': 'x'}),
                                   ('/withdraw?session_id=' + value, {'request_id': 'x'}),
                                   ('/claim?session_id=' + value, {'request_id': 'x'})):
                    self.assertEqual(self.request(path, body), (400, {'error': 'invalid_session'}), path)
        # A legal non-default session is accepted and never silently folded into main.
        # The shape only constrains the FIRST character, so a trailing '-' is legal too.
        for session in ('work-2', 'trail-', 'a' * 32):
            with self.subTest(session=session):
                self.assertEqual(self.request('/timeline?session_id=' + session)[1]['session_id'], session)

    def test_body_and_unrelated_headers_are_not_session_transports(self):
        self.request('/send', {'text': 'body 里的会话名不算数', 'session_id': 'work'})
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=main')[1]['items']],
                         ['body 里的会话名不算数'])
        self.assertEqual(self.request('/timeline?session_id=work')[1]['items'], [])
        # 只有约定的 x-crew-session 是会话头：随便一个近义头名（X-Session-Id）绝不能
        # 变成第二条传输，否则「客户端以为在 work、网关读成 main」又会静默发生。
        req = urllib.request.Request(self.url + '/timeline',
                                     headers={'X-GW-Token': self.gateway.TOKEN,
                                              'X-Session-Id': 'work'})
        with urllib.request.urlopen(req, timeout=3) as response:
            self.assertEqual(json.load(response)['session_id'], 'main')
        # 约定头名则必须生效：header 兜底把这条读请求放进 work，而不是 main。
        code, body = self.request('/timeline', extra_headers={SESSION_HEADER: 'work'})
        self.assertEqual(code, 200)
        self.assertEqual((body['session_id'], body['session_api']), ('work', 1))
        self.assertEqual(body['items'], [])

    def test_missing_session_id_falls_back_to_main(self):
        sent = self.request('/send', {'text': '老调用', 'request_id': 'legacy-1'})[1]
        self.assertEqual([i['text'] for i in self.request('/timeline')[1]['items']], ['老调用'])
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=main')[1]['items']], ['老调用'])
        self.assertEqual(self.request('/timeline?session_id=work')[1]['items'], [])
        self.assertEqual(self.request('/claim', {'request_id': 'legacy-1'})[1]['id'], sent['id'])
        self.assertEqual(self.request('/withdraw?session_id=work', {'request_id': 'legacy-1'})[0], 404)

    # --- #14 第 2 项：header 形态 session_id（契约 §1 裁决） ---
    # 反向验证目标：去掉 resolve_session 里的 header 读取，或去掉「query 与 header
    # 不一致 -> (None, True)」的冲突判定，下面这整块用例应当成片变红。

    def raw(self, path, header_pairs, body=None):
        """手写一个请求（可带重复 header 名），返回 (status, 解析后的 JSON)。"""
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            conn.putrequest('POST' if body is not None else 'GET', path)
            for name, value in header_pairs:
                conn.putheader(name, value)
            payload = None if body is None else json.dumps(body)
            if payload is not None:
                conn.putheader('Content-Type', 'application/json')
                conn.putheader('Content-Length', str(len(payload.encode())))
            conn.endheaders()
            if payload is not None:
                conn.send(payload.encode())
            response = conn.getresponse()
            with response:
                return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_header_is_a_fallback_for_every_endpoint(self):
        """header 兜底：query 缺省时，所有 operation 都从 x-crew-session 读会话。"""
        hdr = {SESSION_HEADER: 'work'}
        endpoints = (
            ('/timeline', None), ('/health', None),
            ('/send', {'text': 'header 侧', 'request_id': 'hdr-every-1'}),
            ('/withdraw', {'request_id': 'hdr-every-1'}),
            ('/claim', {'request_id': 'hdr-every-1'}),
        )
        for path, body in endpoints:
            with self.subTest(path=path):
                code, payload = self.request(path, body, extra_headers=hdr)
                self.assertIn(code, (200, 404, 409), path)
                # 所有响应都回显能力位（_send 一处逻辑，判据已扩到 header）。
                self.assertEqual((payload.get('session_id'), payload.get('session_api')), ('work', 1), path)

    def test_header_only_send_lands_in_its_session_and_never_silently_in_main(self):
        """C4 裁决的核心证据：#14 字面「header 未识别时按缺省 main，不得报错」按字面做，
        客户端以为在 work、消息却静默写进 main 且全程 200 —— 契约 §9.5 / ADR 0007
        判定的唯一危险组合。这里 header 必须被识别：消息只落在 work，main 一个字都没有。
        老网关不认 header 时的兜底不在本网关（见消息面 409 与桌面端能力位先验）。
        """
        code, sent = self.request('/send', {'text': '只给 header', 'request_id': 'hdr-c4'},
                                  extra_headers={SESSION_HEADER: 'work'})
        self.assertEqual(code, 200)
        self.assertEqual((sent['session_id'], sent['session_api']), ('work', 1))
        work = self.request('/timeline', extra_headers={SESSION_HEADER: 'work'})[1]
        self.assertEqual([i['text'] for i in work['items']], ['只给 header'])
        self.assertEqual(self.request('/timeline')[1]['items'], [], 'header 请求绝不静默按 main 落库')
        self.assertEqual(self.request('/timeline?session_id=main')[1]['items'], [])
        # query 与 header 指同一个会话时，读到的也是同一条。
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=work')[1]['items']],
                         ['只给 header'])

    def test_query_takes_priority_when_both_are_present_and_equal(self):
        hdr = {SESSION_HEADER: 'work'}
        for path, body in (('/timeline?session_id=work', None), ('/health?session_id=work', None),
                           ('/send?session_id=work', {'text': '双写', 'request_id': 'hdr-both'}),
                           ('/claim?session_id=work', {'request_id': 'hdr-both'})):
            with self.subTest(path=path):
                code, payload = self.request(path, body, extra_headers=hdr)
                self.assertIn(code, (200, 409), path)
                self.assertEqual((payload['session_id'], payload['session_api']), ('work', 1), path)
        self.assertEqual([i['text'] for i in self.request('/timeline?session_id=work')[1]['items']], ['双写'])

    def test_conflicting_query_and_header_is_400_and_writes_nothing(self):
        """两者都给且值不一致 -> 400 invalid_session：不许猜哪个算数，也不许落库。"""
        hdr = {SESSION_HEADER: 'other'}
        paths = (('/timeline?session_id=work', None), ('/health?session_id=work', None),
                 ('/send?session_id=work', {'text': '猜一个算数', 'request_id': 'hdr-conflict'}),
                 ('/withdraw?session_id=work', {'request_id': 'hdr-conflict'}),
                 ('/claim?session_id=work', {'request_id': 'hdr-conflict'}))
        for path, body in paths:
            with self.subTest(path=path):
                self.assertEqual(self.request(path, body, extra_headers=hdr),
                                 (400, {'error': 'invalid_session'}), path)
        # 「不许猜」= 任何一边都没有落到库里：work / other / main 全空。
        for query in ('/timeline?session_id=work', '/timeline?session_id=other', '/timeline'):
            self.assertEqual(self.request(query)[1]['items'], [], query)
        self.assertEqual(self.request('/timeline', extra_headers=hdr)[1]['items'], [])
        # main 作为 query 也一样冲突，不存在「缺省值优先」的偷偷放行。
        self.assertEqual(self.request('/timeline?session_id=main', extra_headers={SESSION_HEADER: 'work'}),
                         (400, {'error': 'invalid_session'}))

    def test_invalid_header_session_is_400_for_every_endpoint(self):
        """header 形状与 query 同一正则；非法 header 绝不按 main 静默放行。"""
        bad = ['WORK', 'work x', 'w' * 33, '-lead', 'under_score', 'main%0A', '']
        for value in bad:
            with self.subTest(value=value):
                hdr = {SESSION_HEADER: value}
                for path, body in (('/timeline', None), ('/health', None),
                                   ('/send', {'text': 'x', 'request_id': 'hdr-bad'}),
                                   ('/withdraw', {'request_id': 'x'}),
                                   ('/claim', {'request_id': 'x'})):
                    self.assertEqual(self.request(path, body, extra_headers=hdr),
                                     (400, {'error': 'invalid_session'}), (value, path))
        self.assertEqual(self.request('/timeline')[1]['items'], [], '非法 header 不许按 main 落库')
        # 合法形状与 query 完全一致：尾部连字符、32 位上限都放行。
        for session in ('work-2', 'trail-', 'a' * 32):
            with self.subTest(session=session):
                code, payload = self.request('/timeline', extra_headers={SESSION_HEADER: session})
                self.assertEqual(code, 200)
                self.assertEqual(payload['session_id'], session)

    def test_every_explicit_header_response_carries_the_capability_bit(self):
        """能力位覆盖所有响应：业务 200、409、404、400 都得让消息面认出对端版本。"""
        hdr = {SESSION_HEADER: 'work'}
        self.request('/send', {'text': 'B 侧', 'request_id': 'hdr-cap'}, extra_headers=hdr)
        cases = (
            ('/claim', {'request_id': 'hdr-cap'}),      # 200
            ('/claim', {'request_id': 'hdr-cap'}),      # 409 已读走
            ('/send', []),                              # 400 非法 body
            ('/withdraw', {'request_id': 'missing'}),   # 404
        )
        for path, body in cases:
            with self.subTest(path=path, body=body):
                code, payload = self.request(path, body, extra_headers=hdr)
                self.assertIn(code, (200, 400, 404, 409))
                self.assertEqual((payload['session_id'], payload['session_api']), ('work', 1))
        code, payload = self.request('/timeline-unrelated', extra_headers=hdr)
        self.assertEqual(code, 404)
        self.assertEqual((payload['session_id'], payload['session_api']), ('work', 1))

    def test_legacy_call_without_any_session_field_is_byte_for_byte_unchanged(self):
        """老调用（既无 query 也无 header）：响应一个字段都不加，逐字不变。"""
        self.assertEqual(self.request('/health'), (200, {'ok': True}))
        self.assertEqual(self.request('/timeline-unrelated'), (404, {'error': 'not found'}))
        self.assertEqual(self.request('/timeline', token=False), (401, {'error': 'unauthorized'}))
        code, legacy = self.request('/send', {'text': 'A 侧', 'request_id': 'hdr-legacy'})
        self.assertEqual(code, 200)
        self.assertEqual(set(legacy), {'ok', 'id', 'request_id'})
        code, missing = self.request('/withdraw', {'request_id': 'never-sent'})
        self.assertEqual(code, 404)
        self.assertEqual(missing, {'error': 'no such message'})

    def test_duplicate_conflicting_headers_are_400_not_a_guess(self):
        """同名 header 给了两个不同值也是「两者不一致」，不许取第一个猜。"""
        token = [('X-GW-Token', self.gateway.TOKEN)]
        self.assertEqual(self.raw('/timeline', token + [(SESSION_HEADER, 'work'), (SESSION_HEADER, 'other')]),
                         (400, {'error': 'invalid_session'}))
        # 两个相同值不是冲突，仍是那一个会话。
        code, payload = self.raw('/timeline', token + [(SESSION_HEADER, 'work'), (SESSION_HEADER, 'work')])
        self.assertEqual(code, 200)
        self.assertEqual((payload['session_id'], payload['session_api']), ('work', 1))


if __name__ == '__main__':
    from unittest import mock
    unittest.main()
