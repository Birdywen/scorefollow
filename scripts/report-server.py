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
