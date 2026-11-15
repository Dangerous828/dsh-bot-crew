#!/usr/bin/env python3
"""桌面 GUI 验收用的本地 fixture 后端（只在本机回环端口，不连生产）。

它按契约形状回 /api/mobile/sessions、/api/mobile/timeline、/api/mobile/read、
/api/mobile/takeover 与 /orchestrator/api/state，让真窗口渲染出：
  · 双徽标同屏（unread>0 且 unread_replies>0）
  · 群组栏 live / empty / unavailable 三态
  · 一张 open 票（供「接手 →」按钮出现并记录被点）
每个请求都追加到 fixture/requests.log，作为「GUI 真发过这条请求」的证据。
"""
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

STATE = {
    "mode": "live",          # live | empty | unavailable
    "unread": 3,
    "unread_replies": 2,
    "open_ticket": True,
    "takeover_calls": [],
    "read_calls": [],
}
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "requests.log")
LOCK = threading.Lock()


def log(line):
    with LOCK:
        with open(LOG, "a") as f:
            f.write(line + "\n")


def groups():
    m = STATE["mode"]
    if m == "unavailable":
        return {"state": "unavailable", "reason": "fixture：读不到群组投影"}
    if m == "empty":
        return {"state": "empty", "groups": []}
    return {"state": "live", "groups": [
        {"id": "main", "title": "main", "sessions": ["main"], "bots": ["b1", "b2"], "ticket_count": 5},
        {"id": "work", "title": "work", "sessions": ["work"], "bots": [], "ticket_count": 1},
    ]}


def timeline(session):
    items = [
        {"id": "m1", "role": "user", "text": "fixture：主人发的一条（队伍还没读走）",
         "at": "2026-11-14T18:00:00+0800", "request_id": "fx-1", "read_at": ""},
        {"id": "r1", "role": "agent", "text": "fixture：队伍的回话一", "at": "2026-11-14T18:00:05+0800"},
        {"id": "r2", "role": "agent", "text": "fixture：队伍的回话二", "at": "2026-11-14T18:00:09+0800"},
    ]
    tasks = [{
        "id": "fixture-ticket-0001", "title": "fixture：一张在跑的票（供接手按钮）",
        "state": "working", "open": STATE["open_ticket"], "retryable": False,
        "bot_id": "b1", "created_at": "2026-11-14T18:00:00+0800",
        "updated_at": "2026-11-14T18:00:10+0800",
    }]
    return {
        "items": items,
        "bots": [
            {"bot_id": "b1", "name": "大哥", "role": "default", "state": "待命", "charter": "fixture"},
            {"bot_id": "b2", "name": "写手", "role": "worker", "state": "待命", "charter": "fixture"},
        ],
        "default_bot_id": "b1",
        "tasks": tasks,
        "status": {"runtime": "ready", "mobile": "ready", "paused": False},
        "queued": [], "declined": [],
        "unread": {"count": STATE["unread"], "state": "live"},
        "unread_replies": {"count": STATE["unread_replies"], "state": "live"},
        "session_id": session, "session_api": 1,
        "sessions": ["main", "work"], "default_session_id": "main",
        "groups": groups(),
    }


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _session(self, q):
        return (q.get("session_id") or ["main"])[0]

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        log(f"GET {self.path}")
        if u.path == "/api/mobile/sessions":
            return self._send(200, {"sessions": ["main", "work"], "default_session_id": "main", "session_api": 1})
        if u.path == "/api/mobile/timeline":
            return self._send(200, timeline(self._session(q)))
        if u.path == "/api/mobile/models":
            return self._send(200, {"providers": []})
        if u.path == "/orchestrator/api/state":
            return self._send(200, {"load": {"queued": 0, "maxWorkers": 3}, "watchdog": None})
        return self._send(404, {"error": "Not found"})

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        raw = self._body()
        log(f"POST {self.path} {raw.decode(errors='replace')[:200]}")
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {}
        if u.path == "/api/mobile/takeover":
            STATE["takeover_calls"].append(body)
            STATE["open_ticket"] = False
            return self._send(200, {"ok": True, "stopped": True})
        if u.path == "/api/mobile/read":
            STATE["read_calls"].append(body)
            return self._send(200, {"ok": True, "last_read_id": body.get("last_read_id")})
        if u.path == "/control/mode":
            STATE["mode"] = body.get("mode") or "live"
            if "unread" in body: STATE["unread"] = int(body["unread"])
            if "unread_replies" in body: STATE["unread_replies"] = int(body["unread_replies"])
            if "open_ticket" in body: STATE["open_ticket"] = bool(body["open_ticket"])
            return self._send(200, {"ok": True, "state": STATE})
        if u.path == "/control/reset":
            STATE.update({"mode": "live", "unread": 3, "unread_replies": 2, "open_ticket": True,
                          "takeover_calls": [], "read_calls": []})
            return self._send(200, {"ok": True})
        if u.path == "/api/mobile/pause":
            return self._send(200, {"ok": True})
        if u.path == "/api/mobile/send":
            return self._send(200, {"ok": True, "id": 999, "request_id": body.get("request_id"), "session_id": self._session(q), "session_api": 1})
        return self._send(404, {"error": "Not found"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18899
    if len(sys.argv) > 2:
        STATE["mode"] = sys.argv[2]
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
