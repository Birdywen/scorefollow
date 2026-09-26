#!/usr/bin/env python3
"""上报 bundle 解包: report.json 的 pagePngs(浏览器分析底图) -> 可分析基准目录.

用法: python3 scripts/report-pages.py <reports/<dir>> [outDir, 默认 benchmarks/gpu/_rep]
输出: outDir/{meta.json,page_N.png,page_N.raw(RGB)} + auto/corrected 摘要.
之后 scripts/pxdump.mjs 等以 outDir 名直接跑, 与浏览器同帧像素, 零采样差.
"""
import base64
import io
import json
import os
import sys

from PIL import Image

srcdir = sys.argv[1]
outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join("benchmarks", "gpu", "_rep")
rep = json.load(open(os.path.join(srcdir, "report.json")))
os.makedirs(outdir, exist_ok=True)
meta = {"pages": []}
for key in sorted(int(k) for k in (rep.get("pagePngs") or {})):
    du = rep["pagePngs"][str(key)]
    if not isinstance(du, str) or not du.startswith("data:image/png;base64,"):
        print(f"p{key}: no png")
        continue
    im = Image.open(io.BytesIO(base64.b64decode(du.split(",", 1)[1]))).convert("RGB")
    im.save(os.path.join(outdir, f"page_{key}.png"))
    with open(os.path.join(outdir, f"page_{key}.raw"), "wb") as f:
        f.write(im.tobytes())
    meta["pages"].append({"page": key, "w": im.width, "h": im.height})
    print(f"p{key}: {im.width}x{im.height}")
json.dump(meta, open(os.path.join(outdir, "meta.json"), "w"))
print("report:", rep.get("pdfName"), "algo:", rep.get("algoVersion"), "schema:", rep.get("schema"))
print("\n".join(rep.get("summary", [])))
