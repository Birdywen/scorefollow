"""Accounts, one-time email codes, sessions and daily usage counters (SQLite).

Secrets never touch disk in clear: codes, session tokens and client IPs are stored
as keyed hashes (HMAC with ACCOUNT_SECRET). No files are created on import.
"""

from contextlib import contextmanager
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time

CODE_TTL = 600            # a login code lives 10 minutes
CODE_ATTEMPTS = 5         # wrong guesses before the code is burnt
SEND_GAP = 60             # one code per email per minute
SEND_PER_EMAIL_DAY = 10
SEND_PER_IP_HOUR = 20
SESSION_TTL = 30 * 86400  # rolling: refreshed at most once a day while in use
EMAIL_RE = re.compile(r"^[^@\s<>()\[\],;:\"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")
KINDS = ("analysis", "omr")


class RateLimited(Exception):
    pass


def normalize_email(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    email = raw.strip().lower()
    return email if len(email) <= 254 and EMAIL_RE.match(email) else None


def utc_day(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


class AccountStore:
    def __init__(self, root, secret: bytes, clock=time.time):
        if not secret or len(secret) < 16:
            raise ValueError("ACCOUNT_SECRET must be at least 16 bytes")
        self.root = Path(root).expanduser()
        if self.root.is_symlink():
            raise ValueError("Account storage cannot be a symlink")
        self.root = self.root.resolve()
        if self.root.is_relative_to(Path(__file__).resolve().parents[1]):
            raise ValueError("Account storage must be outside the repository")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.secret = secret
        self.now = clock
        self.db = self.root / "account.sqlite3"
        os.close(os.open(self.db, os.O_CREAT | os.O_RDWR, 0o600))
        self.db.chmod(0o600)
        init = sqlite3.connect(self.db, timeout=15)
        try:
            init.execute("PRAGMA journal_mode=WAL")
            init.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '',
                created REAL NOT NULL, last_login REAL NOT NULL, plan TEXT NOT NULL DEFAULT 'free');
            CREATE TABLE IF NOT EXISTS login_codes (
                email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS code_sends (email TEXT NOT NULL, ip_hash TEXT NOT NULL, at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS code_sends_email ON code_sends(email, at);
            CREATE INDEX IF NOT EXISTS code_sends_ip ON code_sends(ip_hash, at);
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created REAL NOT NULL,
                expires REAL NOT NULL, user_agent TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS usage (
                subject TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL,
                PRIMARY KEY (subject, day, kind));
            """)
        finally:
            init.close()

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.db, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    def _mac(self, *parts: str) -> str:
        return hmac.new(self.secret, "\x1f".join(parts).encode(), hashlib.sha256).hexdigest()

    def ip_subject(self, ip: str) -> str:
        return "ip:" + self._mac("ip", ip or "-")[:32]

    # --- login codes -------------------------------------------------------
    def issue_code(self, email: str, ip: str) -> str:
        """Store a fresh 6-digit code for `email`; RateLimited when sending too often."""
        now = self.now()
        ip_hash = self._mac("ip", ip or "-")
        with self._connect() as db:
            db.execute("DELETE FROM code_sends WHERE at < ?", (now - 86400,))
            db.execute("DELETE FROM login_codes WHERE expires < ?", (now,))
            db.execute("DELETE FROM sessions WHERE expires < ?", (now,))
            last = db.execute("SELECT MAX(at) FROM code_sends WHERE email=?", (email,)).fetchone()[0]
            if last is not None and now - last < SEND_GAP:
                raise RateLimited(int(SEND_GAP - (now - last)) + 1)
            per_email = db.execute("SELECT COUNT(*) FROM code_sends WHERE email=?", (email,)).fetchone()[0]
            per_ip = db.execute("SELECT COUNT(*) FROM code_sends WHERE ip_hash=? AND at>=?",
                                (ip_hash, now - 3600)).fetchone()[0]
            if per_email >= SEND_PER_EMAIL_DAY or per_ip >= SEND_PER_IP_HOUR:
                raise RateLimited(3600)
            code = f"{secrets.randbelow(10**6):06d}"
            db.execute("INSERT INTO code_sends VALUES (?,?,?)", (email, ip_hash, now))
            db.execute("INSERT OR REPLACE INTO login_codes VALUES (?,?,?,0,?)",
                       (email, self._mac("code", email, code), now + CODE_TTL, now))
        return code

    def verify_code(self, email: str, code: str, user_agent: str = "") -> tuple[dict, str] | None:
        """Consume a correct code: returns (user, session token); None when wrong/expired."""
        if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code.strip()):
            return None
        code = code.strip()
        now = self.now()
        with self._connect() as db:
            row = db.execute("SELECT * FROM login_codes WHERE email=?", (email,)).fetchone()
            if row is None or row["expires"] < now or row["attempts"] >= CODE_ATTEMPTS:
                return None
            if not hmac.compare_digest(row["code_hash"], self._mac("code", email, code)):
                db.execute("UPDATE login_codes SET attempts=attempts+1 WHERE email=?", (email,))
                return None
            db.execute("DELETE FROM login_codes WHERE email=?", (email,))
            user = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if user is None:
                uid = secrets.token_hex(12)
                db.execute("INSERT INTO users (id, email, created, last_login) VALUES (?,?,?,?)", (uid, email, now, now))
            else:
                uid = user["id"]
                db.execute("UPDATE users SET last_login=? WHERE id=?", (now, uid))
            token = secrets.token_urlsafe(32)
            db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)",
                       (self._mac("session", token), uid, now, now + SESSION_TTL, (user_agent or "")[:200]))
            return self._user(db, uid), token

    # --- sessions ----------------------------------------------------------
    def session_user(self, token: str | None) -> dict | None:
        if not token or len(token) > 100:
            return None
        now = self.now()
        th = self._mac("session", token)
        with self._connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE token_hash=?", (th,)).fetchone()
            if row is None or row["expires"] < now:
                return None
            if row["expires"] - now < SESSION_TTL - 86400:
                db.execute("UPDATE sessions SET expires=? WHERE token_hash=?", (now + SESSION_TTL, th))
            return self._user(db, row["user_id"])

    def logout(self, token: str | None) -> None:
        if token:
            with self._connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (self._mac("session", token),))

    def delete_user(self, uid: str) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            db.execute("DELETE FROM usage WHERE subject=?", ("u:" + uid,))
            db.execute("DELETE FROM users WHERE id=?", (uid,))

    def set_display_name(self, uid: str, name: str) -> dict:
        with self._connect() as db:
            db.execute("UPDATE users SET display_name=? WHERE id=?", (name.strip()[:60], uid))
            return self._user(db, uid)

    @staticmethod
    def _user(db, uid) -> dict | None:
        row = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if row is None:
            return None
        return {"id": row["id"], "email": row["email"], "displayName": row["display_name"],
                "plan": row["plan"], "created": row["created"]}

    # --- usage -------------------------------------------------------------
    def usage(self, subject: str) -> dict:
        day = utc_day(self.now())
        with self._connect() as db:
            rows = db.execute("SELECT kind, count FROM usage WHERE subject=? AND day=?", (subject, day)).fetchall()
        got = {r["kind"]: r["count"] for r in rows}
        return {k: got.get(k, 0) for k in KINDS}

    def consume(self, subject: str, kind: str, limit: int) -> tuple[bool, int]:
        """Count one use. Returns (allowed, used today). Over the limit nothing is added."""
        day = utc_day(self.now())
        with self._connect() as db:
            db.execute("DELETE FROM usage WHERE day < ?", (utc_day(self.now() - 40 * 86400),))
            row = db.execute("SELECT count FROM usage WHERE subject=? AND day=? AND kind=?", (subject, day, kind)).fetchone()
            used = row["count"] if row else 0
            if used >= limit:
                return False, used
            db.execute("INSERT INTO usage VALUES (?,?,?,1) ON CONFLICT(subject, day, kind) DO UPDATE SET count=count+1",
                       (subject, day, kind))
            return True, used + 1

    def export(self, uid: str) -> dict:
        with self._connect() as db:
            user = self._user(db, uid)
            usage = [dict(r) for r in db.execute("SELECT day, kind, count FROM usage WHERE subject=? ORDER BY day",
                                                 ("u:" + uid,)).fetchall()]
            sessions = [{"created": r["created"], "expires": r["expires"], "userAgent": r["user_agent"]}
                        for r in db.execute("SELECT * FROM sessions WHERE user_id=?", (uid,)).fetchall()]
        return {"user": user, "usage": usage, "sessions": sessions}
