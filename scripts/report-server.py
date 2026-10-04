#!/usr/bin/env python3
"""scorefollow 异常上报本地直收(测试用, 与 public/sf-report-upload.php 同协议).

用法: python3 scripts/report-server.py [port, 默认 8931]
  - 密钥: 首次运行生成 reports/.secret 并打印, 上报对话框密钥框填它
  - 落盘: reports/<dir>/{orig.preload.js,fixed.preload.js,report.json}
  - 前端上报地址框填: http://<本机IP>:8931/upload
只用标准库, Ctrl+C 停止.
"""
import os
import re
import secrets
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reports")
DIR_RE = re.compile(r"^[0-9A-Za-z\-_]{1,80}$")
MAX_FILE = 120 * 1024 * 1024
# 公开谱库: 落盘位置独立于 next out/ 之外, 重构建不清空; 由 nginx
# location /scorefollow/Score/ 直接 alias 对外(见 /etc/nginx/sites-enabled/default)
SCORE_ROOT = "/home/ubuntu/scorefollow-scores"
SCORE_PATH_RE = re.compile(r"^Score/[0-9A-Za-z\-_./]{1,110}\.js$")
SCORE_FOLDER_RE = re.compile(r"^Score/[0-9A-Za-z\-_./]{1,110}$")
SCORE_ORIG_RE = re.compile(r"^original(\.pdf|-p[0-9]+\.(png|jpg|jpeg))$")


def get_secret() -> str:
    os.makedirs(ROOT, exist_ok=True)
    sf = os.path.join(ROOT, ".secret")
    if os.path.exists(sf):
        with open(sf) as f:
            s = f.read().strip()
            if s:
                return s
    s = secrets.token_hex(16)
    with open(sf, "w") as f:
        f.write(s + "\n")
    os.chmod(sf, 0o600)
    return s


SECRET = get_secret()


def parse_multipart(body: bytes, boundary: bytes):
    """极简 multipart 解析 -> {field: (filename|None, bytes)}"""
    out = {}
    for part in body.split(b"--" + boundary):
        if b"\r\n\r\n" not in part:
            continue
        head, data = part.split(b"\r\n\r\n", 1)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        if data == b"--" or not data:
            continue
        m = re.search(rb'name="([^"]+)"(?:;\s*filename="([^"]*)")?', head)
        if not m:
            continue
        name = m.group(1).decode("utf-8", "replace")
        filename = m.group(2).decode("utf-8", "replace") if m.group(2) else None
        out[name] = (filename, data)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "sf-report/1"

    def log_message(self, *a):
        sys.stderr.write("%s %s\n" % (self.address_string(), " ".join(str(x) for x in a)))

    def _json(self, code: int, obj: dict):
        import json
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/upload":
            return self._json(404, {"ok": False, "error": "POST /upload only"})
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r"boundary=([^;]+)", ctype)
        if not m:
            return self._json(400, {"ok": False, "error": "multipart only"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json(400, {"ok": False, "error": "bad length"})
        if length <= 0 or length > 3 * MAX_FILE + 65536:
            return self._json(400, {"ok": False, "error": "bad size"})
        body = self.rfile.read(length)
        fields = parse_multipart(body, m.group(1).strip().encode())
        secret = fields.get("secret", (None, b""))[1].decode("utf-8", "replace")
        if not secrets.compare_digest(secret, SECRET):
            return self._json(403, {"ok": False, "error": "bad secret"})
        # 公开谱面推送(target=score): 同密钥; path=Score/[子目录/]名.js 白名单;
        # 落盘 SCORE_ROOT 并更新 Score/scores.json 目录单(同 path 去重后置顶)
        if fields.get("target", (None, b""))[1].decode("utf-8", "replace") == "score":
            import json
            import time
            p = fields.get("path", (None, b""))[1].decode("utf-8", "replace")
            if not SCORE_PATH_RE.match(p) or ".." in p:
                return self._json(400, {"ok": False, "error": "bad path (want Score/[sub/]name.js)"})
            if "file" not in fields or fields["file"][0] is None:
                return self._json(400, {"ok": False, "error": "missing file: file"})
            data = fields["file"][1]
            if not data or len(data) > MAX_FILE:
                return self._json(400, {"ok": False, "error": "bad size on file"})
            dest = os.path.join(SCORE_ROOT, p)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
            os.chmod(dest, 0o644)
            title = fields.get("title", (None, b""))[1].decode("utf-8", "replace").strip()
            if not title:
                title = re.sub(r"\.js$", "", os.path.basename(p), flags=re.I)
            bpm_raw = fields.get("bpm", (None, b""))[1].decode("utf-8", "replace").strip()
            meter_raw = fields.get("meter", (None, b""))[1].decode("utf-8", "replace").strip()
            try:
                bpm = min(300, max(20, int(bpm_raw))) if bpm_raw else None
            except ValueError:
                bpm = None
            meter = meter_raw if re.match(r"^\d{1,2}/\d{1,2}$", meter_raw) else None
            mf = os.path.join(SCORE_ROOT, "Score", "scores.json")
            manifest = {"scores": []}
            if os.path.exists(mf):
                try:
                    with open(mf) as f:
                        old = json.load(f)
                    if isinstance(old, dict) and isinstance(old.get("scores"), list):
                        manifest = old
                except (ValueError, OSError):
                    pass
            entry = {"path": p, "title": title[:80], "bpm": bpm, "meter": meter,
                     "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            manifest["scores"] = [entry] + [s for s in manifest["scores"]
                                            if isinstance(s, dict) and s.get("path") != p][:499]
            with open(mf, "w") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=1)
            os.chmod(mf, 0o644)
            return self._json(200, {"ok": True, "path": p,
                                    "files": [os.path.basename(p), "scores.json"]})
        # 三件套发布(target=score-bundle): folder=Score/书名/曲名; 文件 fixed.js + auto.js 必需,
        # origN(原文件, 文件名白名单 original.pdf / original-pN.png|jpg)可选; 目录单 path 指向 fixed.js
        if fields.get("target", (None, b""))[1].decode("utf-8", "replace") == "score-bundle":
            import json
            import time
            folder = fields.get("folder", (None, b""))[1].decode("utf-8", "replace")
            if not SCORE_FOLDER_RE.match(folder) or ".." in folder or folder.endswith("/"):
                return self._json(400, {"ok": False, "error": "bad folder (want Score/book/piece)"})
            want = {"fixed": "fixed.js", "auto": "auto.js"}
            blobs = {}
            for field, name in want.items():
                if field not in fields or fields[field][0] is None:
                    return self._json(400, {"ok": False, "error": "missing file: " + field})
                data = fields[field][1]
                if not data or len(data) > MAX_FILE:
                    return self._json(400, {"ok": False, "error": "bad size on " + field})
                blobs[name] = data
            for key in sorted(fields):
                if not re.match(r"^orig[0-9]+$", key) or fields[key][0] is None:
                    continue
                fn = fields[key][0] or ""
                if not SCORE_ORIG_RE.match(fn):
                    return self._json(400, {"ok": False, "error": "bad original name: " + fn[:40]})
                data = fields[key][1]
                if not data or len(data) > MAX_FILE:
                    return self._json(400, {"ok": False, "error": "bad size on " + key})
                blobs[fn] = data
            for name, data in blobs.items():
                dest = os.path.join(SCORE_ROOT, folder, name)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(data)
                os.chmod(dest, 0o644)
            title = fields.get("title", (None, b""))[1].decode("utf-8", "replace").strip()
            if not title:
                title = os.path.basename(folder)
            bpm_raw = fields.get("bpm", (None, b""))[1].decode("utf-8", "replace").strip()
            meter_raw = fields.get("meter", (None, b""))[1].decode("utf-8", "replace").strip()
            try:
                bpm = min(300, max(20, int(bpm_raw))) if bpm_raw else None
            except ValueError:
                bpm = None
            meter = meter_raw if re.match(r"^\d{1,2}/\d{1,2}$", meter_raw) else None
            mf = os.path.join(SCORE_ROOT, "Score", "scores.json")
            manifest = {"scores": []}
            if os.path.exists(mf):
                try:
                    with open(mf) as f:
                        old = json.load(f)
                    if isinstance(old, dict) and isinstance(old.get("scores"), list):
                        manifest = old
                except (ValueError, OSError):
                    pass
            p = folder + "/fixed.js"
            originals = sorted(n for n in blobs if n not in ("fixed.js", "auto.js"))
            entry = {"path": p, "title": title[:80], "bpm": bpm, "meter": meter,
                     "bundle": {"auto": folder + "/auto.js",
                                "original": [folder + "/" + n for n in originals]},
                     "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            manifest["scores"] = [entry] + [s for s in manifest["scores"]
                                            if isinstance(s, dict) and s.get("path") != p][:499]
            with open(mf, "w") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=1)
            os.chmod(mf, 0o644)
            return self._json(200, {"ok": True, "path": p,
                                    "files": sorted(blobs) + ["scores.json"]})
        d = fields.get("dir", (None, b""))[1].decode("utf-8", "replace")
        if not DIR_RE.match(d):
            return self._json(400, {"ok": False, "error": "bad dir"})
        want = {"orig": "orig.preload.js", "fixed": "fixed.preload.js", "meta": "report.json"}
        dest = os.path.join(ROOT, d)
        os.makedirs(dest, exist_ok=True)
        saved = []
        for field, name in want.items():
            if field not in fields or fields[field][0] is None:
                return self._json(400, {"ok": False, "error": "missing file: " + field})
            data = fields[field][1]
            if not data or len(data) > MAX_FILE:
                return self._json(400, {"ok": False, "error": "bad size on " + field})
            with open(os.path.join(dest, name), "wb") as f:
                f.write(data)
            saved.append(name)
        return self._json(200, {"ok": True, "dir": d, "files": saved})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
    print("secret:", SECRET)
    print("reports:", os.path.abspath(ROOT))
    print(f"listening on 0.0.0.0:{port}  (上报地址填 http://<本机IP>:{port}/upload)", flush=True)
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
