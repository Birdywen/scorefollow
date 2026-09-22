#!/usr/bin/env python3
"""叠加我方(红)与 HOMR(蓝)小节线, 输出 overlay PNG 供人工仲裁.

用法: homr/.venv/bin/python scripts/homr-overlay.py toccatta 1
"""
import json
import os
import sys

from PIL import Image, ImageDraw

BASE = os.environ.get("SF_BENCH_ROOT", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "benchmarks", "homr"))
HOMR_W, HOMR_H = 1653, 2339

name, page = sys.argv[1], int(sys.argv[2])
d = os.path.join(BASE, name)
meta = json.load(open(os.path.join(d, "meta.json")))
homr = json.load(open(os.path.join(d, "homr.json")))
ours = json.load(open(os.path.join(d, "ours.json")))

pm = meta["pages"][page - 1]
pg0 = homr[page - 1]
if pg0.get("image_size"):
    hspaceW, hspaceH = pg0["image_size"]["w"], pg0["image_size"]["h"]
else:
    hspaceW, hspaceH = HOMR_W, HOMR_H
sx, sy = pm["w"] / hspaceW, pm["h"] / hspaceH
img = Image.open(os.path.join(d, f"page_{page}.png")).convert("RGB")
dr = ImageDraw.Draw(img)

op = ours["pages"][page - 1]
for s, bars in zip(op["systems"], op["bars"]):
    dr.rectangle([s["x1"], s["y1"], s["x2"], s["y2"]], outline=(0, 180, 0), width=2)
    for x in bars:
        dr.line([x, s["y1"], x, s["y2"]], fill=(255, 0, 0), width=2)

pg = homr[page - 1]
seen = set()
for ms in pg["bbox"]["staffs"]:
    subs = ms["sub"]
    y1 = min(s["min_y"] for s in subs) * sy
    y2 = max(s["max_y"] for s in subs) * sy
    xs = sorted({round(b["cx"] * sx) for b in subs[0]["bar_lines"]} |
                {round(b["cx"] * sx) for s in subs[1:] for b in s["bar_lines"]})
    # 去重 5px
    uniq = []
    for x in xs:
        if not uniq or x - uniq[-1] > 5:
            uniq.append(x)
    for x in uniq:
        if (round(x), round(y1)) in seen:
            continue
        seen.add((round(x), round(y1)))
        dr.line([x + 3, y1, x + 3, y2], fill=(0, 80, 255), width=2)

out = os.path.join(d, f"page_{page}.overlay.png")
img.save(out)
print("wrote", out)
