#!/usr/bin/env python3
"""HoMR 音符模板门数据: PDF -> 本地 :8000 HoMR -> 宽1000坐标 gate JSON.

gate JSON 供浏览器做最后一道 veto(只否决, 不新增):
  候选内线 x 若距 HoMR 音符头 <=8px(同系统带内) 且 HoMR 在该处无小节线(>8px)
  -> 判为符干, 否决. HoMR 也认是线 / HoMR 无音符 -> 保留.

用法: python3 scripts/homr-gate.py <score.pdf> [out.homr-gate.json]
输出: {generator, pages: [{page, w:1000, h, notes: [[x,y]...],
        systems: [{y1, y2, bars: [x...]}]}]}  (全部宽1000坐标)
"""
import json
import os
import sys
import urllib.request

try:
    import pymupdf as _pdfmod
except ImportError:
    import fitz as _pdfmod

HOMR_URL = "http://127.0.0.1:8000/homr"
RENDER_W = 1000
DEDUP_PX = 8  # HOMR 坐标下去重半径(同一小节线被两谱表各检一次), 与 homr-compare 一致
BOUNDARY = "----sfboundary"


def post_homr(path):
    with open(path, "rb") as f:
        data = f.read()
    body = (
        b"--" + BOUNDARY.encode() + b'\r\nContent-Disposition: form-data; name="image"; filename="score.pdf"'
        b"\r\nContent-Type: application/pdf\r\n\r\n" + data + b"\r\n--" + BOUNDARY.encode() + b"--\r\n"
    )
    req = urllib.request.Request(HOMR_URL, data=body,
                                 headers={"Content-Type": "multipart/form-data; boundary=" + BOUNDARY})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.load(r)


def dedupe(xs):
    s = sorted(xs)
    out = []
    for x in s:
        if out and x - out[-1] < DEDUP_PX:
            out[-1] = (out[-1] + x) / 2
        else:
            out.append(x)
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: python3 scripts/homr-gate.py <score.pdf> [out.homr-gate.json]", file=sys.stderr)
        sys.exit(1)
    pdf_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(pdf_path)[0] + ".homr-gate.json"
    print(f"== POST homr ({pdf_path}) ...", flush=True)
    res = post_homr(pdf_path)
    pages = res if isinstance(res, list) else [res]
    doc = _pdfmod.open(pdf_path)
    out = {"generator": "scripts/homr-gate.py", "render_w": RENDER_W, "pages": []}
    for i, page in enumerate(doc):
        hp = pages[i]
        hs = hp.get("image_size") or {"w": 1653, "h": 2339}
        zoom = RENDER_W / page.rect.width
        pix = page.get_pixmap(matrix=_pdfmod.Matrix(zoom, zoom))
        W, H = pix.width, pix.height
        sx, sy = W / hs["w"], H / hs["h"]
        notes = []
        systems = []
        for g in hp["bbox"]["staffs"]:
            subs = g["sub"]
            y1 = min(s["min_y"] for s in subs) * sy
            y2 = max(s["max_y"] for s in subs) * sy
            for s in subs:
                for n in s.get("notes", []):
                    notes.append([round(n["cx"] * sx, 1), round(n["cy"] * sy, 1)])
            bars = dedupe([b["cx"] * sx for s in subs for b in s.get("bar_lines", [])])
            systems.append({"y1": round(y1, 1), "y2": round(y2, 1),
                            "bars": [round(x, 1) for x in bars]})
        out["pages"].append({"page": i + 1, "w": W, "h": H, "notes": notes, "systems": systems})
        print(f"   page {i + 1}: {W}x{H} notes={len(notes)} sys={len(systems)}", flush=True)
    doc.close()
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
