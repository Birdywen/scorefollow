#!/usr/bin/env python3
"""GPU HOMR 批量拉数 + 宽1000渲染, 存入 benchmarks/gpu/<slug>/.

用法: python3 scripts/gpu-data.py [slug...]
  无参数跑 PDF_TO_TEST 下全部 9 首; 给 slug 只跑指定.
输出: page_N.png / page_N.raw(RGB) / meta.json / homr.json(去 musicxml/demo 图)
      + gpu_pN.json(原始全量) / pN.musicxml / pN.demo.png
GPU 端点慢, 逐页请求, 失败重试 3 次. 预计 27 页约 10~30 分钟, 建议 nohup 后台跑.
"""
import base64
import json
import os
import sys
import time
import urllib.request

import pymupdf

GPU_URL = "http://junpeng:8765/homr"
SRC = "/home/ubuntu/workspace/PDF_TO_TEST"
RENDER_W = 1000
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "benchmarks", "gpu")
BOUNDARY = "----sfboundary"
RETRIES = 3


def slug_of(path):
    s = os.path.basename(path).lower().replace(".pdf", "")
    return "".join(c if (c.isalnum() or c in "-_") else "_" for c in s)[:48]


def post_page(pdf_bytes, page, timeout=590):
    body = (
        b"--" + BOUNDARY.encode() + b'\r\nContent-Disposition: form-data; name="image"; filename="score.pdf"'
        b"\r\nContent-Type: application/pdf\r\n\r\n" + pdf_bytes
        + b"\r\n--" + BOUNDARY.encode() + b"--\r\n"
    )
    url = f"{GPU_URL}?page={page}"
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, data=body,
                                         headers={"Content-Type": "multipart/form-data; boundary=" + BOUNDARY})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - 重试一切网络/GPU 错误
            last = e
            print(f"    page {page} attempt {attempt} failed: {e}, retry in 10s", flush=True)
            time.sleep(10)
    raise RuntimeError(f"page {page} failed after {RETRIES}: {last}")


def main():
    only = set(sys.argv[1:])
    pdfs = sorted(os.path.join(SRC, f) for f in os.listdir(SRC) if f.lower().endswith(".pdf"))
    for pdf in pdfs:
        slug = slug_of(pdf)
        if only and slug not in only:
            continue
        d = os.path.join(OUT, slug)
        os.makedirs(d, exist_ok=True)
        with open(pdf, "rb") as f:
            pdf_bytes = f.read()
        doc = pymupdf.open(pdf)
        npages = len(doc)
        print(f"== {slug}: {npages} pages", flush=True)
        slim = []
        meta = {"pdf": pdf, "render_w": RENDER_W, "pages": []}
        for i in range(npages):
            n = i + 1
            t0 = time.time()
            res = post_page(pdf_bytes, n)
            dt = time.time() - t0
            slim_p = {k: v for k, v in res.items() if k not in ("musicxml", "demo_png_b64")}
            slim.append(slim_p)
            with open(os.path.join(d, f"gpu_p{n}.json"), "w") as f:
                json.dump(res, f)
            if res.get("musicxml"):
                with open(os.path.join(d, f"p{n}.musicxml"), "w") as f:
                    f.write(res["musicxml"])
            if res.get("demo_png_b64"):
                with open(os.path.join(d, f"p{n}.demo.png"), "wb") as f:
                    f.write(base64.b64decode(res["demo_png_b64"]))
            page = doc[i]
            zoom = RENDER_W / page.rect.width
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            pix.save(os.path.join(d, f"page_{n}.png"))
            with open(os.path.join(d, f"page_{n}.raw"), "wb") as f:
                f.write(pix.samples)
            meta["pages"].append({"page": n, "w": pix.width, "h": pix.height})
            print(f"   p{n}: {pix.width}x{pix.height} notes={res.get('notes')} "
                  f"measures={res.get('measures')} elapsed={res.get('elapsed_sec')}s req={dt:.0f}s", flush=True)
        doc.close()
        with open(os.path.join(d, "homr.json"), "w") as f:
            json.dump(slim, f)
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump(meta, f)
        print(f"== {slug}: done", flush=True)


if __name__ == "__main__":
    main()
