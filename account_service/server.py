"""Account API: python3 -m account_service.server (loopback; nginx mounts it at /api/account/).

Same-origin only (no CORS). The session lives in an HttpOnly cookie. /internal/quota is
nginx's auth_request target for analysis submissions: 204 = allow, 403 = over quota.
"""

from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit

from . import mailer
from .cloud import CloudError, CloudStore
from .store import KINDS, SESSION_TTL, AccountStore, RateLimited, normalize_email

COOKIE = "sf_session"
MAX_BODY = 4096
logger = logging.getLogger("scorefollow.account")
store: AccountStore | None = None  # set by main() or tests
cloud: CloudStore | None = None
MAX_JSON_PUT = 2_600_000


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def limits(signed_in: bool) -> dict:
    who = "USER" if signed_in else "GUEST"
    base = {"analysis": 30, "omr": 10} if signed_in else {"analysis": 3, "omr": 2}
    return {k: env_int(f"ACCOUNT_LIMIT_{who}_{k.upper()}", v) for k, v in base.items()}


def quota_mode() -> str:
    mode = os.environ.get("ACCOUNT_QUOTA_MODE", "count")
    return mode if mode in ("off", "count", "enforce") else "count"


def allowed_origins() -> set:
    return set(os.environ.get("ACCOUNT_ALLOWED_ORIGINS",
                              "https://mega-metro.online,https://www.mega-metro.online").split(","))


def usage_view(subject: str, signed_in: bool) -> dict:
    used = store.usage(subject)
    cap = limits(signed_in)
    return {k: {"used": used[k], "limit": cap[k]} for k in KINDS}


class Handler(BaseHTTPRequestHandler):
    server_version = "scorefollow-account"

    def log_message(self, *_args) -> None:  # no emails/IPs in access logs
        pass

    # --- helpers -----------------------------------------------------------
    def client_ip(self) -> str:
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            jar = SimpleCookie(raw)
        except Exception:
            return None
        return jar[COOKIE].value if COOKIE in jar else None

    def respond(self, code: int, payload: dict | None = None, cookie: str | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            secure = "; Secure" if os.environ.get("ACCOUNT_COOKIE_SECURE", "1") != "0" else ""
            age = SESSION_TTL if cookie else 0
            self.send_header("Set-Cookie", f"{COOKIE}={cookie}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax{secure}")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code: int, key: str, zh: str, **extra) -> None:
        self.respond(code, {"error": zh, "code": key, **extra})

    def same_origin(self) -> bool:
        if self.headers.get("Origin") in allowed_origins():
            return True
        self.fail(403, "origin", "来源不允许")
        return False

    def body(self, limit: int = MAX_BODY) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 <= length <= limit or "application/json" not in (self.headers.get("Content-Type") or ""):
            self.fail(400, "bad_request", "请求格式无效")
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            data = None
        if not isinstance(data, dict):
            self.fail(400, "bad_request", "请求格式无效")
            return None
        return data

    # --- routes ------------------------------------------------------------
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/internal/quota":
            return self.quota()
        if path == "/health":
            return self.respond(200, {"status": "ok", "quotaMode": quota_mode()})
        user = store.session_user(self.token())
        if path == "/me":
            if user is None:
                return self.fail(401, "signed_out", "未登录", guestUsage=usage_view(store.ip_subject(self.client_ip()), False))
            return self.respond(200, {"user": user, "usage": usage_view("u:" + user["id"], True), "quotaMode": quota_mode()})
        if path == "/export":
            if user is None:
                return self.fail(401, "signed_out", "未登录")
            return self.respond(200, store.export(user["id"]))
        if user is not None and self.cloud_route("GET", path, user):
            return
        if user is None and path.strip("/").split("/")[0] in ("sync", "history", "blobs", "takes"):
            return self.fail(401, "signed_out", "未登录")
        self.fail(404, "not_found", "Not found")

    def do_HEAD(self) -> None:
        user = store.session_user(self.token())
        path = urlsplit(self.path).path
        if user is None or not path.startswith("/blobs/"):
            return self.respond(404)
        try:
            self.respond(200 if cloud.blob_size(user["id"], path[7:]) is not None else 404)
        except CloudError:
            self.respond(404)

    def do_PUT(self) -> None:
        if not self.same_origin():
            return
        user = store.session_user(self.token())
        if user is None:
            return self.fail(401, "signed_out", "未登录")
        if not self.cloud_route("PUT", urlsplit(self.path).path, user):
            self.fail(404, "not_found", "Not found")

    def cloud_route(self, method: str, path: str, user: dict) -> bool:
        """Cloud storage endpoints. True when the path was one of ours (a response was sent)."""
        uid = user["id"]
        parts = path.strip("/").split("/")
        try:
            if method == "GET" and parts == ["sync"]:
                self.respond(200, cloud.snapshot(uid))
            elif method == "GET" and parts == ["history"]:
                key = parse_qs(urlsplit(self.path).query).get("scoreKey", [""])[0]
                self.respond(200, {"takes": cloud.history(uid, key)})
            elif method == "GET" and len(parts) == 2 and parts[0] == "blobs":
                blob = cloud.blob_path(uid, parts[1])
                if blob is None:
                    return self.fail(404, "not_found", "Not found") or True
                size = blob.stat().st_size
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "private, max-age=31536000, immutable")
                self.end_headers()
                with open(blob, "rb") as f:
                    while chunk := f.read(65536):
                        self.wfile.write(chunk)
            elif method == "GET" and len(parts) == 3 and parts[0] == "takes" and parts[2] == "result":
                got = cloud.get_result(uid, parts[1])
                self.respond(200, got) if got else self.fail(404, "not_found", "Not found")
            elif method == "PUT" and len(parts) == 2 and parts[0] == "blobs":
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    length = 0
                self.respond(200, {"size": cloud.put_blob(uid, parts[1], self.rfile, length)})
            elif method == "PUT" and parts[:1] in (["takes"], ["scores"]) and len(parts) in (2, 3):
                data = self.body(MAX_JSON_PUT)
                if data is None:
                    return True
                if parts[0] == "takes" and len(parts) == 3 and parts[2] == "result":
                    cloud.put_result(uid, parts[1], data)
                    self.respond(200, {"ok": True})
                elif len(parts) == 2:
                    put = cloud.put_take if parts[0] == "takes" else cloud.put_score
                    self.respond(200, put(uid, parts[1], data))
                else:
                    return False
            elif method == "DELETE" and len(parts) == 2 and parts[0] in ("takes", "scores"):
                (cloud.delete_take if parts[0] == "takes" else cloud.delete_score)(uid, parts[1])
                self.respond(200, {"ok": True})
            else:
                return False
        except CloudError as exc:
            self.fail(exc.status, exc.code, str(exc))
        return True

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path not in ("/code", "/verify", "/logout", "/me"):
            return self.fail(404, "not_found", "Not found")
        if not self.same_origin():
            return
        data = self.body()
        if data is None:
            return
        if path == "/code":
            email = normalize_email(data.get("email"))
            if email is None:
                return self.fail(400, "bad_email", "邮箱格式不正确")
            try:
                code = store.issue_code(email, self.client_ip())
            except RateLimited as exc:
                return self.fail(429, "slow_down", "发送太频繁，请稍后再试", retryAfter=exc.args[0])
            lang = "en" if data.get("lang") == "en" else "zh"
            threading.Thread(target=self._mail, args=(email, code, lang), daemon=True).start()
            return self.respond(200, {"ok": True, "retryAfter": 60})
        if path == "/verify":
            email = normalize_email(data.get("email"))
            got = store.verify_code(email, data.get("code"), self.headers.get("User-Agent", "")) if email else None
            if got is None:
                return self.fail(400, "bad_code", "验证码不正确或已过期")
            user, token = got
            return self.respond(200, {"user": user, "usage": usage_view("u:" + user["id"], True)}, cookie=token)
        if path == "/logout":
            store.logout(self.token())
            return self.respond(200, {"ok": True}, cookie="")
        user = store.session_user(self.token())  # POST /me: profile update
        if user is None:
            return self.fail(401, "signed_out", "未登录")
        name = data.get("displayName")
        if not isinstance(name, str):
            return self.fail(400, "bad_request", "请求格式无效")
        self.respond(200, {"user": store.set_display_name(user["id"], name)})

    def do_DELETE(self) -> None:
        path = urlsplit(self.path).path
        if path != "/me" and not path.startswith(("/takes/", "/scores/")):
            return self.fail(404, "not_found", "Not found")
        if not self.same_origin():
            return
        user = store.session_user(self.token())
        if user is None:
            return self.fail(401, "signed_out", "未登录")
        if path != "/me":
            if not self.cloud_route("DELETE", path, user):
                self.fail(404, "not_found", "Not found")
            return
        cloud.delete_user(user["id"])
        store.delete_user(user["id"])
        self.respond(200, {"ok": True}, cookie="")

    @staticmethod
    def _mail(email: str, code: str, lang: str) -> None:
        try:
            mailer.send_code(email, code, lang)
        except Exception as exc:  # never log the address or the code
            logger.warning(json.dumps({"event": "mail_failed", "errorClass": type(exc).__name__}))

    def quota(self) -> None:
        # Reachable only through nginx's internal location, which sets this header;
        # the public /api/account/ location blanks it.
        if self.headers.get("X-Quota-Check") != "1":
            return self.fail(404, "not_found", "Not found")
        mode = quota_mode()
        if mode == "off" or self.headers.get("X-Original-Method", "GET").upper() != "POST":
            return self.respond(204)
        kind = "omr" if "/omr/" in self.headers.get("X-Original-URI", "") else "analysis"
        user = store.session_user(self.token())
        subject = "u:" + user["id"] if user else store.ip_subject(self.client_ip())
        allowed, used = store.consume(subject, kind, limits(user is not None)[kind])
        logger.info(json.dumps({"event": "quota", "kind": kind, "signedIn": user is not None, "used": used, "allowed": allowed}))
        self.respond(204 if allowed or mode == "count" else 403)


def main() -> None:
    global store, cloud
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    secret = os.environ.get("ACCOUNT_SECRET", "").encode()
    store = AccountStore(os.environ.get("ACCOUNT_DATA_DIR", str(Path.home() / ".local/share/scorefollow-account")), secret)
    cloud = CloudStore(store, env_int("ACCOUNT_STORAGE_BYTES", 500_000_000))
    host = os.environ.get("ACCOUNT_HOST", "127.0.0.1")
    port = int(os.environ.get("ACCOUNT_PORT", "8766"))
    logger.info(json.dumps({"event": "start", "port": port, "quotaMode": quota_mode()}))
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
