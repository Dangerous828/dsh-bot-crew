#!/usr/bin/env python3
"""Read-only viewer for a baoyu-design / claude-design canvas folder.

Serves the folder's artboards with a shim for the editor's support.js so the
<.dc.html> files render standalone in a plain browser, plus an index page that
lays every board out by the x/y/w/h recorded in project/canvas.json.

Why this exists: the baoyu-design editor server is not always running, and its
support.js is not checked in. This shows the same boards straight from the repo.

Two things this deliberately gets right, because getting them wrong makes the
canvas look like the design is broken when it isn't:

  * Zoom is a CSS transform on a fixed-size stage, never `zoom`. `zoom` reflows
    the iframe's layout viewport, so at 79% the three columns squeeze into each
    other and the artboard looks wrong.
  * A board's height is the real rendered height, not the number in
    canvas.json. The offline board is 1196 tall but recorded as 900; trusting
    the record crops its footer and makes it overlap the row below.

  python3 tools/canvas-viewer.py .             # default port 4730
  python3 tools/canvas-viewer.py . 8080

Then open http://127.0.0.1:4730/.
"""
import json
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 4730

SHIM = """<style id="dc-shim">
x-dc, helmet { display: contents; }
helmet > style { display: none; }
html, body { margin: 0; }
</style>"""

# Report the real content height back to the canvas so the board box can grow.
REPORT = """<script>
(function () {
  function send() {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    parent.postMessage({ dc: 'height', h: h }, '*');
  }
  window.addEventListener('load', function () { send(); setTimeout(send, 120); });
  if (window.ResizeObserver) {
    new ResizeObserver(send).observe(document.documentElement);
  }
})();
</script>"""

SCRIPT_RE = re.compile(r'<script src="\./support\.js"></script>', re.I)


def prep_html(raw: str) -> str:
    out = SCRIPT_RE.sub(SHIM, raw)
    if SHIM not in out:
        out = out.replace("</head>", SHIM + "</head>", 1)
    return out.replace("</body>", REPORT + "</body>", 1)


def build_index() -> str:
    canvas = json.loads((ROOT / "project" / "canvas.json").read_text("utf-8"))
    boards = canvas.get("boards", {})
    if not boards:
        raise SystemExit("canvas.json has no boards")

    max_x = max(b["x"] + b["w"] for b in boards.values())
    max_y = max(b["y"] + b["h"] for b in boards.values())

    items, chips = [], []
    ordered = sorted(boards.items(), key=lambda kv: (kv[1]["y"], kv[1]["x"]))
    for i, (name, b) in enumerate(ordered):
        title = b.get("title", name)
        items.append(
            f'<div class="board" id="b{i}" data-w="{b["w"]}" data-h="{b["h"]}" '
            f'data-orig-x="{b["x"]}" data-orig-y="{b["y"]}" '
            f'style="left:{b["x"]}px;top:{b["y"]}px;width:{b["w"]}px;height:{b["h"]}px">'
            f'<iframe loading="lazy" src="/render?f={urllib.parse.quote(name)}" '
            f'title="{title}" style="width:{b["w"]}px;height:{b["h"]}px"></iframe>'
            f'<span class="tag">{i + 1} · {title}</span></div>'
        )
        chips.append(f'<a href="#b{i}" data-idx="{i}" class="chip">{i + 1} {title}</a>')

    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Personal Agent · 九张画板</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:#E4DFD7; font:13px/1.5 -apple-system,'PingFang SC',sans-serif;
          color:#1F1D1A; overflow:hidden; }}
  header {{ position:fixed; inset:0 0 auto 0; height:54px; display:flex; align-items:center;
            gap:16px; padding:0 18px; background:rgba(255,255,255,.9); backdrop-filter:blur(14px);
            border-bottom:1px solid #D9D3C9; z-index:20; }}
  header h1 {{ font-size:14px; font-weight:640; margin:0; white-space:nowrap; letter-spacing:-.01em; }}
  header .meta {{ color:#8A8377; font-size:12px; white-space:nowrap; }}
  .chips {{ display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; flex:1; }}
  .chips::-webkit-scrollbar {{ display:none; }}
  .chip {{ flex:none; padding:5px 11px; border-radius:999px; border:1px solid #D9D3C9;
           background:#fff; color:#3E6B62; text-decoration:none; font-size:12px; }}
  .chip:hover {{ background:#EDF3F1; }}
  .zoom {{ display:flex; align-items:center; gap:6px; flex:none; }}
  .zoom button {{ min-width:28px; height:28px; padding:0 8px; border-radius:8px; border:1px solid #D9D3C9;
                  background:#fff; cursor:pointer; font-size:14px; line-height:1; color:#1F1D1A; }}
  .zoom button:hover {{ background:#F6F3EE; }}
  .zoom span {{ min-width:46px; text-align:center; color:#57524A; font-variant-numeric:tabular-nums; }}
  #vp {{ position:absolute; inset:54px 0 0 0; overflow:auto; }}
  /* The sizer is the scroll area; the stage inside it is never resized by zoom,
     only scaled visually. That keeps every iframe's layout viewport at its
     designed width. */
  #sizer {{ position:relative; }}
  #stage {{ position:absolute; left:0; top:0; transform-origin:0 0; }}
  .board {{ position:absolute; border-radius:12px; overflow:hidden; background:#fff;
            box-shadow:0 1px 2px rgba(31,29,26,.07), 0 14px 36px -14px rgba(31,29,26,.25); }}
  .board iframe {{ border:0; display:block; }}
  .tag {{ position:absolute; left:0; top:0; transform:translateY(-100%); padding:3px 9px;
          font-size:11.5px; color:#6B655C; background:#F6F3EE; border-radius:6px 6px 0 0;
          white-space:nowrap; }}
</style></head>
<body>
<header>
  <h1>Personal Agent</h1>
  <span class="meta">{len(boards)} 张画板</span>
  <nav class="chips">{''.join(chips)}</nav>
  <div class="zoom">
    <button id="out" title="缩小">−</button><span id="zv">50%</span><button id="in" title="放大">+</button>
    <button id="fit" title="适应窗口">适应</button>
    <button id="one" title="100%">1:1</button>
  </div>
</header>
<div id="vp"><div id="sizer"><div id="stage">{''.join(items)}</div></div></div>
<script>
  const vp = document.getElementById('vp');
  const sizer = document.getElementById('sizer');
  const stage = document.getElementById('stage');
  const zv = document.getElementById('zv');
  const MAX_X = {max_x}, MAX_Y = {max_y};
  let z = 0.5;

  // The stage is laid out once at its designed size and only ever scaled, so
  // every iframe keeps the layout viewport the artboard was drawn for.
  const stageBase = {{ w: MAX_X, h: MAX_Y }};
  stage.style.width = stageBase.w + 'px';
  stage.style.height = stageBase.h + 'px';

  function applySize2() {{
    const w = stageBase.w, h = stageBase.h;
    sizer.style.width = (w * z) + 'px';
    sizer.style.height = (h * z) + 'px';
    stage.style.transform = 'scale(' + z + ')';
    zv.textContent = Math.round(z * 100) + '%';
  }}

  // Rows are re-flowed from real heights. canvas.json's y values are not
  // trustworthy: the offline board is recorded as 900 tall but renders 1196,
  // so trusting them overlaps it with the row below.
  const ROW_GAP = 96;
  function reflow() {{
    const boards = [...document.querySelectorAll('.board')];
    // Group by the row they were recorded on, keeping the recorded order.
    const rows = [];
    for (const b of boards.sort((a, c) => parseFloat(a.style.top) - parseFloat(c.style.top))) {{
      const y = parseFloat(b.dataset.origY);
      const row = rows.find(r => Math.abs(r.y - y) < 40);
      (row || (rows.push({{ y, items: [] }}), rows[rows.length - 1])).items.push(b);
    }}
    let cursor = 0, maxRight = 0;
    for (const row of rows) {{
      let rowH = 0;
      for (const b of row.items.sort((a, c) => parseFloat(a.dataset.origX) - parseFloat(c.dataset.origX))) {{
        b.style.top = cursor + 'px';
        b.style.left = b.dataset.origX + 'px';
        rowH = Math.max(rowH, parseFloat(b.style.height));
        maxRight = Math.max(maxRight, parseFloat(b.dataset.origX) + parseFloat(b.style.width));
      }}
      cursor += rowH + ROW_GAP;
    }}
    stageBase.h = cursor;
    stageBase.w = Math.max(stageBase.w, maxRight);
    stage.style.height = stageBase.h + 'px';
    applySize2();
  }}

  // Real heights arrive from each artboard via postMessage.
  const gotHeight = new Set();
  window.addEventListener('message', e => {{
    const d = e.data;
    if (!d || d.dc !== 'height' || !e.source) return;
    const frame = [...document.querySelectorAll('.board iframe')].find(f => f.contentWindow === e.source);
    if (!frame) return;
    const board = frame.parentElement;
    const want = Math.max(parseInt(board.dataset.h, 10) || 0, Math.ceil(d.h));
    const have = Math.round(parseFloat(board.style.height));
    if (want > have) {{
      board.style.height = want + 'px';
      frame.style.height = want + 'px';
      gotHeight.add(board.id);
      reflow();
    }}
  }});

  function setZoom(nz, anchor) {{
    nz = Math.max(0.1, Math.min(2, nz));
    const cx = anchor ? anchor.x : vp.clientWidth / 2;
    const cy = anchor ? anchor.y : vp.clientHeight / 2;
    const wx = (vp.scrollLeft + cx) / z, wy = (vp.scrollTop + cy) / z;
    z = nz;
    applySize2();
    vp.scrollLeft = wx * z - cx;
    vp.scrollTop = wy * z - cy;
  }}
  function fit() {{
    const pad = 0.94;
    setZoom(Math.min(vp.clientWidth / stageBase.w, vp.clientHeight / stageBase.h) * pad);
    if (vp.scrollWidth <= vp.clientWidth + 2) vp.scrollLeft = 0;
    if (vp.scrollHeight <= vp.clientHeight + 2) vp.scrollTop = 0;
  }}

  document.getElementById('in').onclick = () => setZoom(z + 0.1);
  document.getElementById('out').onclick = () => setZoom(z - 0.1);
  document.getElementById('fit').onclick = fit;
  document.getElementById('one').onclick = () => setZoom(1);
  vp.addEventListener('wheel', e => {{
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    setZoom(z * (1 - e.deltaY * 0.0015), {{ x: e.clientX - r.left, y: e.clientY - r.top }});
  }}, {{ passive: false }});
  document.querySelectorAll('.chip').forEach(a => a.onclick = e => {{
    e.preventDefault();
    const el = document.getElementById('b' + a.dataset.idx);
    vp.scrollTo({{ left: el.offsetLeft * z - 40, top: el.offsetTop * z - 40, behavior: 'smooth' }});
  }});
  reflow();
  fit();
  window.addEventListener('resize', fit);
</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            self._send(build_index().encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/render":
            name = (qs.get("f") or [""])[0]
            target = (ROOT / "project" / name).resolve()
            if ROOT not in target.parents or target.suffix != ".html":
                self.send_error(404)
                return
            try:
                raw = target.read_text("utf-8")
            except FileNotFoundError:
                self.send_error(404)
                return
            self._send(prep_html(raw).encode("utf-8"), "text/html; charset=utf-8")
            return
        self.send_error(404)


if __name__ == "__main__":
    if not (ROOT / "project" / "canvas.json").exists():
        raise SystemExit(f"{ROOT} 下没有 project/canvas.json —— 传设计稿目录，不是仓库根")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"serving {ROOT} at http://127.0.0.1:{PORT}/", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
