"""Exercise the real gateway and queue in a temporary DSH home (no running agent)."""
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

    def request(self, path, body=None, token=True):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-GW-Token'] = self.gateway.TOKEN
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


if __name__ == '__main__':
    from unittest import mock
    unittest.main()
