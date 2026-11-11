#!/usr/bin/env python3
"""Compose a single overview poster from rendered artboards (column-flow layout)."""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path("/Users/cpuser/Code/dsh-bot-crew/designs/personal-agent")
SHOTS = Path("/tmp/baoyu-viewer/full")
OUT = Path("/tmp/baoyu-viewer/overview-personal-agent.png")

BG = (233, 229, 222)
INK = (31, 29, 26)
MUTED = (107, 101, 92)
ACCENT = (62, 107, 98)
FAINT = (163, 155, 143)

canvas_json = json.loads((ROOT / "project" / "canvas.json").read_text("utf-8"))
order = canvas_json["order"]
meta = canvas_json["boards"]

files = {
    "Desktop.dc.html": "desk-light",
    "Desktop-dark.dc.html": "desk-dark",
    "Desktop-empty.dc.html": "desk-empty",
    "Desktop-offline.dc.html": "desk-offline",
    "Mobile.dc.html": "mb-light",
    "Mobile-dark.dc.html": "mb-dark",
    "Mobile-roster.dc.html": "mb-roster",
    "Mobile-card.dc.html": "mb-card",
    "Mobile-workspace.dc.html": "mb-workspace",
}

DESK_W, MOB_W = 940, 288
GAP_X, GAP_Y = 52, 62
MARGIN = 78
LABEL_H, CAP_H = 42, 30


def font(size, bold=False):
    for path, idx in [
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 2 if bold else 0),
        ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
    ]:
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


f_title = font(56, True)
f_sub = font(24)
f_label = font(23)
f_idx = font(20, True)
f_cap = font(19)


def load(name):
    img = Image.open(SHOTS / f"{files[name]}.png").convert("RGB")
    is_desk = meta[name]["w"] >= 1000
    tw = DESK_W if is_desk else MOB_W
    th = round(img.height * tw / img.width)
    real_w, real_h = img.width // 2, img.height // 2
    return img.resize((tw, th), Image.LANCZOS), is_desk, tw, th, real_w, real_h


tiles = {name: load(name) for name in order}
desk = [n for n in order if tiles[n][1]]
mob = [n for n in order if not tiles[n][1]]

# ---- geometry ----
DESK_COLS, MOB_COLS = 2, len(mob)  # 5
desk_col_w = DESK_W
mob_col_w = MOB_W

desk_block_w = DESK_COLS * desk_col_w + (DESK_COLS - 1) * GAP_X
mob_block_w = MOB_COLS * mob_col_w + (MOB_COLS - 1) * GAP_X
content_w = max(desk_block_w, mob_block_w)
W = content_w + 2 * MARGIN

HEADER_H = 196


def col_heights(names, cols, tile_w, gap_x, gap_y):
    """Flow names into `cols` columns; return per-column total height."""
    hs = [0] * cols
    for i, n in enumerate(names):
        c = i % cols
        _, _, tew, teh, _, _ = tiles[n]
        hs[c] += LABEL_H + teh + CAP_H + (gap_y if hs[c] else 0)
    return max(hs)


desk_h = col_heights(desk, DESK_COLS, DESK_W, GAP_X, GAP_Y)
mob_h = col_heights(mob, MOB_COLS, MOB_W, GAP_X, GAP_Y)
H = HEADER_H + desk_h + GAP_Y * 2 + mob_h + MARGIN

canvas = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(canvas)


def shadow_tile(tile, x, y, radius=14):
    tw, th = tile.size
    pad = 30
    sh = Image.new("L", (tw + pad * 2, th + pad * 2), 0)
    ImageDraw.Draw(sh).rounded_rectangle(
        (pad, pad + 8, pad + tw, pad + th + 8), radius=radius, fill=54
    )
    sh = sh.filter(ImageFilter.GaussianBlur(10))
    canvas.paste((148, 141, 130), (x - pad, y - pad), sh)
    mask = Image.new("L", (tw, th), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tw - 1, th - 1), radius=radius, fill=255)
    canvas.paste(tile, (x, y), mask)


# ---- header ----
d.text((MARGIN, 58), "Personal Agent", font=f_title, fill=INK)
d.text(
    (MARGIN, 130),
    "九张画板 · 桌面亮暗 / 空态 / 断连 · 手机对话 / 暗色 / 队伍 / 名片 / 工作区 · 暖白底低饱和",
    font=f_sub,
    fill=MUTED,
)
d.line((MARGIN, HEADER_H - 24, W - MARGIN, HEADER_H - 24), fill=(215, 209, 198), width=2)

counter = 0


def draw_block(names, cols, tile_w, x0, y0):
    global counter
    for i, name in enumerate(names):
        tile, _, tew, teh, real_w, real_h = tiles[name]
        c, r = i % cols, i // cols
        x = x0 + c * (tile_w + GAP_X)
        # offset by the accumulated heights of previous rows in same column
        y = y0
        for j in range(r):
            prev = names[j * cols + c]
            y += LABEL_H + tiles[prev][3] + CAP_H + GAP_Y

        counter += 1
        d.text((x, y + 4), f"{counter:02d}", font=f_idx, fill=ACCENT)
        d.text((x + 38, y), meta[name]["title"], font=f_label, fill=INK)
        shadow_tile(tile, x, y + LABEL_H, radius=14 if tile_w > 500 else 18)
        d.text((x, y + LABEL_H + teh + 9), f"{real_w} × {real_h}", font=f_cap, fill=FAINT)


y = HEADER_H
draw_block(desk, DESK_COLS, DESK_W, MARGIN + (content_w - desk_block_w) // 2, y)
y += desk_h + GAP_Y * 2
draw_block(mob, MOB_COLS, MOB_W, MARGIN + (content_w - mob_block_w) // 2, y)

OUT.parent.mkdir(parents=True, exist_ok=True)
canvas.save(OUT, optimize=True)
print(f"{OUT}  {W}x{H}  boards={counter}")
