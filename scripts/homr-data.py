#!/usr/bin/env python3
"""拉取 HOMR 识别结果 + 按宽1000渲染谱面, 存入 benchmarks/homr/<name>/.

用法: homr/.venv/bin/python scripts/homr-data.py
输出: page_N.png / page_N.raw(RGB) / meta.json / homr.json (去 musicxml)
"""
import json
import os
import urllib.request

import fitz  # noqa: F401  (homr venv 提供)

HOMR_URL = "http://127.0.0.1:8000/homr"
RENDER_W = 1000
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "benchmarks", "homr")

PDFS = {
    "demo": "/home/ubuntu/n/scorefollow/public/demo-score.pdf",
    "secret_garden": "/home/ubuntu/public/livescore/scores/secret_garden_adagio/score.pdf",
    "toccatta": "/home/ubuntu/public/livescore/viewer/score/Saint-Preux_-_Toccatta.pdf",
}

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


def main():
    for name, pdf in PDFS.items():
        d = os.path.join(OUT, name)
        os.makedirs(d, exist_ok=True)
        print(f"== {name}: POST homr ...", flush=True)
        res = post_homr(pdf)
        pages = res if isinstance(res, list) else [res]
        slim = []
        for p in pages:
            p = dict(p)
            p.pop("musicxml", None)
            slim.append(p)
        with open(os.path.join(d, "homr.json"), "w") as f:
            json.dump(slim, f)
        print(f"== {name}: render ...", flush=True)
        doc = fitz.open(pdf)
        meta = {"pdf": pdf, "render_w": RENDER_W, "pages": []}
        for i, page in enumerate(doc):
            zoom = RENDER_W / page.rect.width
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            n = i + 1
            pix.save(os.path.join(d, f"page_{n}.png"))
            with open(os.path.join(d, f"page_{n}.raw"), "wb") as f:
                f.write(pix.samples)
            meta["pages"].append({"page": n, "w": pix.width, "h": pix.height})
            print(f"   page {n}: {pix.width}x{pix.height}", flush=True)
        doc.close()
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump(meta, f)
        print(f"== {name}: done", flush=True)


if __name__ == "__main__":
    main()
