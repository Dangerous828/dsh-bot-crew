#!/usr/bin/env python3
"""Design-fidelity mock: serves the artboard content over the mobile API.

Read-only, port 18899. Nothing here touches the real crew; it exists so the
desktop window can be screenshotted against the design with real density
instead of an empty state.

  python3 tools/design-mock.py &
  DSH_GW=http://127.0.0.1:18899 DSH_TOKEN=x DSH_DEVICE=shot go run ./desktop

Data is verbatim from designs/personal-agent/project/Desktop.dc.html, so any
mismatch on screen is an implementation gap, not a content difference.
"""
import json
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NOW = int(time.time())


def ts(seconds_ago):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(NOW - seconds_ago))


BOTS = [
    {"id": "lead", "name": "大哥", "role": "default",
     "persona": "简练，先应一声再决定。能转派就转派，拿不准就先问一句。"},
    {"id": "scribbler", "name": "写手", "role": "member",
     "persona": "中文文案。克制，不堆词，先给一版再改。"},
    {"id": "coder", "name": "码农", "role": "member",
     "persona": "写代码先看现有约定，改动小步、可回退，交付前自己跑一遍验证。"},
]

MESSAGES = [
    {"id": "m1", "role": "human", "text": "登录页在手机上输入框太挤，帮我把间距调开一点",
     "at": ts(900), "request_id": "r1"},
    {"id": "m2", "role": "agent", "bot_id": "coder",
     "text": "输入框间距 12px，按钮贴底。改 16px，底部留 24px 安全区。",
     "at": ts(840),
     "code": {"path": "login.tsx", "added": 8, "removed": 4,
              "lines": [
                  {"text": "  gap: 12px;", "kind": ""},
                  {"text": "+ gap: 16px;", "kind": "added"},
                  {"text": "  padding-bottom: 0;", "kind": ""},
                  {"text": "+ padding-bottom: 24px;", "kind": "added"},
              ]}},
    {"id": "m3", "role": "human", "text": "按这个改", "at": ts(780), "request_id": "r2"},
    {"id": "m4", "role": "agent", "bot_id": "coder",
     "text": "改完了，在 375 和 390 两个宽度下都过了一遍。", "at": ts(600)},
    {"id": "m5", "role": "agent", "bot_id": "coder",
     "text": "这一段拆给两个分身同时跑：一个查 375 宽度，一个查 390。", "at": ts(540)},
    {"id": "m6", "role": "agent", "bot_id": "scribbler",
     "text": "付款条款对不上。合同第 4 条写 30/70，客户 11 点的邮件说 50/50。两条路：按合同回，或者我改合同。",
     "at": ts(300)},
]

TASKS = [
    {"id": "tk1", "title": "调开登录页输入框间距", "state": "work", "open": True,
     "retryable": False, "bot_id": "coder", "created_at": ts(900), "updated_at": ts(60),
     "total_steps": 3},
    {"id": "tk2", "title": "合同付款条款确认", "state": "person", "open": True,
     "retryable": False, "bot_id": "scribbler", "needs_person": "付款比例 30/70 还是 50/50",
     "created_at": ts(1200), "updated_at": ts(480)},
    {"id": "tk3", "title": "跑测试套件", "state": "failed", "open": True,
     "retryable": True, "bot_id": "coder", "created_at": ts(1800), "updated_at": ts(240)},
    {"id": "tk4", "title": "整理本周会议纪要", "state": "completed", "open": False,
     "retryable": False, "bot_id": "scribbler", "created_at": ts(90000), "updated_at": ts(86400)},
]

AGENTS = {
    "tk1": [
        {"id": "a1", "label": "查 375 宽度", "state": "done", "children": [
            {"id": "a1-1", "label": "量输入框间距", "state": "done", "children": []},
        ]},
        {"id": "a2", "label": "查 390 宽度", "state": "running", "children": []},
    ]
}

STEPS = {
    "tk1": [
        {"at": ts(120), "kind": "command", "text": "rg 'gap:' app/login.css"},
        {"at": ts(90), "kind": "output", "text": "app/login.css:42:  gap: 12px;"},
        {"at": ts(60), "kind": "said", "text": "两处都改了，跑到 390 复验。"},
    ]
}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        p = u.path

        if p == "/api/mobile/timeline":
            self.send_json({
                "items": MESSAGES, "bots": BOTS, "default_bot_id": "lead",
                "model": "DeepSeek V4", "tasks": TASKS,
                "queued": ["r3"], "declined": [],
                "status": {"runtime": "ready", "mobile": "ready", "paused": False},
            })
            return
        if p == "/api/mobile/agents":
            self.send_json({"agents": AGENTS.get((q.get("ticket") or [""])[0], [])})
            return
        if p == "/api/mobile/work":
            self.send_json({"steps": STEPS.get((q.get("ticket") or [""])[0], [])})
            return
        if p == "/api/mobile/screen":
            self.send_json({"state": "unavailable", "kind": "unavailable", "ticket_id": "tk1",
                            "live": False, "reason": "这一步还没接上", "lines": []})
            return
        if p == "/api/mobile/models":
            self.send_json({"providers": [], "current": {"provider": "deepseek", "model": "DeepSeek V4"}})
            return
        self.send_json({"ok": True})

    def do_POST(self):
        self.send_json({"ok": True})


if __name__ == "__main__":
    # 绑 0.0.0.0：模拟器要用 10.0.2.2 访问宿主机，只听回环通不了。
    srv = ThreadingHTTPServer(("0.0.0.0", 18899), H)
    print("mock on http://127.0.0.1:18899", flush=True)
    srv.serve_forever()
