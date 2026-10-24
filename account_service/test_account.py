import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock
import urllib.error
import urllib.request

from account_service import server
from account_service.store import CODE_ATTEMPTS, SESSION_TTL, AccountStore, RateLimited, normalize_email

SECRET = b"test-secret-0123456789"


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.s = AccountStore(self.tmp.name, SECRET, clock=self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def test_email_normalize(self):
        self.assertEqual(normalize_email("  Ann@Example.COM "), "ann@example.com")
        for bad in ("", "no-at", "a@b", "a b@c.de", "x@-bad.com", None, 5, "a@" + "b" * 300 + ".com"):
            self.assertIsNone(normalize_email(bad), bad)

    def test_code_login_and_session(self):
        code = self.s.issue_code("a@x.io", "1.1.1.1")
        self.assertRegex(code, r"^\d{6}$")
        user, token = self.s.verify_code("a@x.io", code)
        self.assertEqual(user["email"], "a@x.io")
        self.assertEqual(self.s.session_user(token)["id"], user["id"])
        self.assertIsNone(self.s.verify_code("a@x.io", code), "code is single use")
        self.clock.t += 61
        again, _ = self.s.verify_code("a@x.io", self.s.issue_code("a@x.io", "1.1.1.1"))
        self.assertEqual(again["id"], user["id"], "same email -> same account")
        raw = (Path(self.tmp.name) / "account.sqlite3").read_bytes()
        self.assertNotIn(token.encode(), raw)
        self.assertNotIn(code.encode(), raw)
        self.assertNotIn(b"1.1.1.1", raw)

    def test_code_expiry_and_attempts(self):
        code = self.s.issue_code("b@x.io", "ip")
        self.clock.t += 601
        self.assertIsNone(self.s.verify_code("b@x.io", code), "expired")
        self.clock.t += 61
        code = self.s.issue_code("b@x.io", "ip")
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(CODE_ATTEMPTS):
            self.assertIsNone(self.s.verify_code("b@x.io", wrong))
        self.assertIsNone(self.s.verify_code("b@x.io", code), "burnt after 5 wrong guesses")
        self.assertIsNone(self.s.verify_code("b@x.io", "12ab56"))

    def test_send_rate_limits(self):
        self.s.issue_code("c@x.io", "ip1")
        with self.assertRaises(RateLimited):
            self.s.issue_code("c@x.io", "ip1")
        for i in range(9):
            self.clock.t += 61
            self.s.issue_code("c@x.io", f"ip{i}")
        self.clock.t += 61
        with self.assertRaises(RateLimited):
            self.s.issue_code("c@x.io", "ipz")  # 10 per email per day
        self.clock.t += 86400
        self.s.issue_code("c@x.io", "ipz")
        for i in range(20):
            self.s.issue_code(f"d{i}@x.io", "same-ip")
        with self.assertRaises(RateLimited):
            self.s.issue_code("e@x.io", "same-ip")  # 20 per IP per hour

    def test_session_rolling_and_logout(self):
        _, token = self.s.verify_code("f@x.io", self.s.issue_code("f@x.io", "ip"))
        self.clock.t += SESSION_TTL - 10
        self.assertIsNotNone(self.s.session_user(token), "refreshed while in use")
        self.clock.t += SESSION_TTL - 10
        self.assertIsNotNone(self.s.session_user(token))
        self.clock.t += SESSION_TTL + 1
        self.assertIsNone(self.s.session_user(token), "idle session expires")
        _, token = self.s.verify_code("f@x.io", self.s.issue_code("f@x.io", "ip"))
        self.s.logout(token)
        self.assertIsNone(self.s.session_user(token))

    def test_quota_daily_reset(self):
        self.assertEqual(self.s.consume("ip:a", "analysis", 2), (True, 1))
        self.assertEqual(self.s.consume("ip:a", "analysis", 2), (True, 2))
        self.assertEqual(self.s.consume("ip:a", "analysis", 2), (False, 2))
        self.assertEqual(self.s.consume("ip:a", "omr", 2), (True, 1), "kinds counted apart")
        self.clock.t += 86400
        self.assertEqual(self.s.consume("ip:a", "analysis", 2), (True, 1), "new UTC day")

    def test_delete_user(self):
        user, token = self.s.verify_code("g@x.io", self.s.issue_code("g@x.io", "ip"))
        self.s.consume("u:" + user["id"], "analysis", 5)
        self.s.delete_user(user["id"])
        self.assertIsNone(self.s.session_user(token))
        self.assertEqual(self.s.usage("u:" + user["id"])["analysis"], 0)

    def test_storage_rules(self):
        with self.assertRaises(ValueError):
            AccountStore(self.tmp.name, b"short")
        with self.assertRaises(ValueError):
            AccountStore(Path(server.__file__).parent / "data", SECRET)
        self.assertEqual(os.stat(self.tmp.name).st_mode & 0o777, 0o700)


ORIGIN = "https://mega-metro.online"


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mail = Path(self.tmp.name) / "mail"
        self.env = mock.patch.dict(os.environ, {"ACCOUNT_MAIL_MODE": "file", "ACCOUNT_MAIL_DIR": str(self.mail),
                                                "ACCOUNT_COOKIE_SECURE": "0", "ACCOUNT_QUOTA_MODE": "enforce"})
        self.env.start()
        server.store = AccountStore(Path(self.tmp.name) / "db", SECRET)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.env.stop()
        self.tmp.cleanup()

    def call(self, method, path, body=None, cookie=None, headers=None):
        h = {"Origin": ORIGIN, **(headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        if cookie:
            h["Cookie"] = f"sf_session={cookie}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read()
                return r.status, json.loads(raw) if raw else None, r.headers
        except urllib.error.HTTPError as e:
            raw = e.read()
            return e.code, json.loads(raw) if raw else None, e.headers

    def login(self, email):
        self.assertEqual(self.call("POST", "/code", {"email": email})[0], 200)
        for _ in range(100):  # mail goes out on a thread
            f = self.mail / f"{email}.txt"
            if f.exists():
                break
            threading.Event().wait(0.02)
        code = f.read_text().split("验证码是 ")[1][:6]
        status, payload, headers = self.call("POST", "/verify", {"email": email, "code": code})
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        return cookie.split(";")[0].split("=", 1)[1], payload

    def quota(self, method="POST", uri="/analysis/jobs", cookie=None, ip="9.9.9.9"):
        return self.call("GET", "/internal/quota", cookie=cookie, headers={
            "X-Quota-Check": "1", "X-Original-Method": method, "X-Original-URI": uri, "X-Real-IP": ip})[0]

    def test_login_me_logout(self):
        status, payload, _ = self.call("GET", "/me")
        self.assertEqual(status, 401)
        self.assertEqual(payload["guestUsage"]["analysis"], {"used": 0, "limit": 3})
        token, payload = self.login("h@x.io")
        self.assertEqual(payload["usage"]["analysis"]["limit"], 30)
        status, me, _ = self.call("GET", "/me", cookie=token)
        self.assertEqual((status, me["user"]["email"]), (200, "h@x.io"))
        self.assertEqual(self.call("POST", "/me", {"displayName": "  小明 "}, cookie=token)[1]["user"]["displayName"], "小明")
        status, _, headers = self.call("POST", "/logout", {}, cookie=token)
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.call("GET", "/me", cookie=token)[0], 401)

    def test_bad_inputs(self):
        self.assertEqual(self.call("POST", "/code", {"email": "nope"})[1]["code"], "bad_email")
        self.assertEqual(self.call("POST", "/verify", {"email": "h@x.io", "code": "123456"})[1]["code"], "bad_code")
        self.assertEqual(self.call("POST", "/code", {"email": "h@x.io"}, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.call("POST", "/code", {"email": "h@x.io"})[0], 200)
        status, payload, _ = self.call("POST", "/code", {"email": "h@x.io"})
        self.assertEqual((status, payload["code"]), (429, "slow_down"))
        self.assertEqual(self.call("GET", "/nope")[0], 404)

    def test_quota_guest_and_user(self):
        self.assertEqual(self.call("GET", "/internal/quota")[0], 404, "needs nginx's internal header")
        for _ in range(3):
            self.assertEqual(self.quota(), 204)
        self.assertEqual(self.quota(), 403, "4th guest analysis today")
        self.assertEqual(self.quota(method="GET", uri="/analysis/jobs/abc"), 204, "polling is free")
        self.assertEqual(self.quota(uri="/analysis/omr/jobs"), 204, "omr counted separately")
        self.assertEqual(self.quota(ip="8.8.8.8"), 204, "other guest")
        token, _ = self.login("i@x.io")
        self.assertEqual(self.quota(cookie=token), 204, "signed-in user has own budget")
        self.assertEqual(self.call("GET", "/me", cookie=token)[1]["usage"]["analysis"]["used"], 1)
        with mock.patch.dict(os.environ, {"ACCOUNT_QUOTA_MODE": "count"}):
            self.assertEqual(self.quota(), 204, "count mode never blocks")
        with mock.patch.dict(os.environ, {"ACCOUNT_QUOTA_MODE": "off"}):
            self.assertEqual(self.quota(), 204)

    def test_delete_and_export(self):
        token, _ = self.login("j@x.io")
        status, data, _ = self.call("GET", "/export", cookie=token)
        self.assertEqual((status, data["user"]["email"]), (200, "j@x.io"))
        self.assertEqual(self.call("DELETE", "/me", cookie=token, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.call("DELETE", "/me", cookie=token)[0], 200)
        self.assertEqual(self.call("GET", "/me", cookie=token)[0], 401)


if __name__ == "__main__":
    unittest.main()
