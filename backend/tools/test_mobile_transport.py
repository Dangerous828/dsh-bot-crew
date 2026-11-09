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

    def test_auth_and_exact_routes(self):
        self.assertEqual(self.request('/timeline', token=False)[0], 401)
        self.assertEqual(self.request('/timeline-unrelated')[0], 404)
        self.assertEqual(self.request('/send-unrelated', {'text': 'hello'})[0], 404)


if __name__ == '__main__':
    from unittest import mock
    unittest.main()
