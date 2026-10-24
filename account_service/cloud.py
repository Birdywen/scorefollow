"""Per-user cloud storage: content-addressed blobs (take audio, score files) plus take/result/score records.

Blobs live at <root>/blobs/<userId>/<sha256>; records live in the account SQLite database.
A user can only ever address their own rows and files; every path component is validated.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
from uuid import uuid4

from .store import AccountStore

SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
KINDS = ("pdf", "xml", "abc")
MAX_BLOB = 25_000_000
MAX_JSON_FIELD = 2_000_000


class CloudError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


class CloudStore:
    def __init__(self, accounts: AccountStore, quota_bytes: int = 500_000_000):
        self.a = accounts
        self.quota = quota_bytes
        self.blob_root = accounts.root / "blobs"
        self.blob_root.mkdir(mode=0o700, exist_ok=True)
        with accounts._connect() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS blobs (user_id TEXT NOT NULL, sha TEXT NOT NULL, size INTEGER NOT NULL,
                PRIMARY KEY (user_id, sha));
            CREATE TABLE IF NOT EXISTS takes (user_id TEXT NOT NULL, id TEXT NOT NULL, score_key TEXT NOT NULL DEFAULT '',
                audio_sha TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL, meta TEXT NOT NULL,
                PRIMARY KEY (user_id, id));
            CREATE INDEX IF NOT EXISTS takes_score ON takes(user_id, score_key, created);
            CREATE TABLE IF NOT EXISTS results (user_id TEXT NOT NULL, take_id TEXT NOT NULL, updated REAL NOT NULL,
                summary TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (user_id, take_id));
            CREATE TABLE IF NOT EXISTS scores (user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
                kind TEXT NOT NULL, file_sha TEXT NOT NULL, updated REAL NOT NULL, edits TEXT NOT NULL,
                PRIMARY KEY (user_id, id));
            """)

    # --- helpers -------------------------------------------------------------
    @staticmethod
    def check_id(value, what="id") -> str:
        if not isinstance(value, str) or not ID_RE.match(value) or value in (".", ".."):
            raise CloudError(400, "bad_id", f"{what} 无效")
        return value

    @staticmethod
    def check_sha(value) -> str:
        if not isinstance(value, str) or not SHA_RE.match(value):
            raise CloudError(400, "bad_sha", "文件指纹无效")
        return value

    def _dir(self, uid: str) -> Path:
        d = self.blob_root / uid
        d.mkdir(mode=0o700, exist_ok=True)
        return d

    @staticmethod
    def _json_field(value, what: str) -> str:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(text) > MAX_JSON_FIELD:
            raise CloudError(413, "too_big", f"{what} 太大")
        return text

    def used_bytes(self, uid: str) -> int:
        with self.a._connect() as db:
            return db.execute("SELECT COALESCE(SUM(size),0) FROM blobs WHERE user_id=?", (uid,)).fetchone()[0]

    # --- blobs ---------------------------------------------------------------
    def blob_size(self, uid: str, sha: str) -> int | None:
        self.check_sha(sha)
        with self.a._connect() as db:
            row = db.execute("SELECT size FROM blobs WHERE user_id=? AND sha=?", (uid, sha)).fetchone()
        return row["size"] if row else None

    def blob_path(self, uid: str, sha: str) -> Path | None:
        return self._dir(uid) / sha if self.blob_size(uid, sha) is not None else None

    def put_blob(self, uid: str, sha: str, stream, length: int) -> int:
        """Store exactly `length` bytes read from `stream`; the content must hash to `sha`."""
        self.check_sha(sha)
        if length <= 0:
            raise CloudError(400, "empty", "文件为空")
        if length > MAX_BLOB:
            raise CloudError(413, "too_big", "文件太大")
        existing = self.blob_size(uid, sha)
        if existing is not None:
            remaining = length
            while remaining:  # drain so the connection stays usable
                chunk = stream.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            return existing
        if self.used_bytes(uid) + length > self.quota:
            raise CloudError(413, "storage_full", "云端空间已满，请先删除旧录音")
        final = self._dir(uid) / sha
        temp = final.with_name(sha + "." + uuid4().hex + ".tmp")
        h = hashlib.sha256()
        try:
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as out:
                remaining = length
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        raise CloudError(400, "short_body", "上传中断")
                    h.update(chunk)
                    out.write(chunk)
                    remaining -= len(chunk)
                out.flush()
                os.fsync(out.fileno())
            if h.hexdigest() != sha:
                raise CloudError(400, "hash_mismatch", "文件内容与指纹不符")
            os.replace(temp, final)
        finally:
            temp.unlink(missing_ok=True)
        with self.a._connect() as db:
            db.execute("INSERT OR IGNORE INTO blobs VALUES (?,?,?)", (uid, sha, length))
        return length

    def _gc_blob(self, db, uid: str, sha: str) -> None:
        used = db.execute("SELECT 1 FROM takes WHERE user_id=? AND audio_sha=? UNION ALL "
                          "SELECT 1 FROM scores WHERE user_id=? AND file_sha=?", (uid, sha, uid, sha)).fetchone()
        if used is None:
            db.execute("DELETE FROM blobs WHERE user_id=? AND sha=?", (uid, sha))
            (self._dir(uid) / sha).unlink(missing_ok=True)

    # --- takes ---------------------------------------------------------------
    def put_take(self, uid: str, tid: str, body: dict) -> dict:
        self.check_id(tid, "take id")
        sha = self.check_sha(body.get("audioSha"))
        if self.blob_size(uid, sha) is None:
            raise CloudError(409, "blob_missing", "请先上传录音文件")
        score_key = body.get("scoreKey", "")
        if not isinstance(score_key, str) or len(score_key) > 200:
            raise CloudError(400, "bad_request", "乐谱标识无效")
        created = body.get("created")
        created = float(created) if isinstance(created, (int, float)) and created > 0 else time.time()
        meta = self._json_field(body.get("meta", {}), "meta")
        now = time.time()
        with self.a._connect() as db:
            old = db.execute("SELECT audio_sha FROM takes WHERE user_id=? AND id=?", (uid, tid)).fetchone()
            db.execute("INSERT INTO takes VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET "
                       "score_key=excluded.score_key, audio_sha=excluded.audio_sha, updated=excluded.updated, meta=excluded.meta",
                       (uid, tid, score_key, sha, created, now, meta))
            if old and old["audio_sha"] != sha:
                self._gc_blob(db, uid, old["audio_sha"])
        return {"id": tid, "updated": now}

    def delete_take(self, uid: str, tid: str) -> None:
        self.check_id(tid, "take id")
        with self.a._connect() as db:
            row = db.execute("SELECT audio_sha FROM takes WHERE user_id=? AND id=?", (uid, tid)).fetchone()
            db.execute("DELETE FROM results WHERE user_id=? AND take_id=?", (uid, tid))
            db.execute("DELETE FROM takes WHERE user_id=? AND id=?", (uid, tid))
            if row:
                self._gc_blob(db, uid, row["audio_sha"])

    def put_result(self, uid: str, tid: str, body: dict) -> None:
        self.check_id(tid, "take id")
        summary, result = body.get("summary"), body.get("result")
        if not isinstance(summary, dict) or not isinstance(result, dict):
            raise CloudError(400, "bad_request", "报告格式无效")
        s, r = self._json_field(summary, "summary"), self._json_field(result, "result")
        with self.a._connect() as db:
            if db.execute("SELECT 1 FROM takes WHERE user_id=? AND id=?", (uid, tid)).fetchone() is None:
                raise CloudError(404, "no_take", "录音不存在")
            db.execute("INSERT OR REPLACE INTO results VALUES (?,?,?,?,?)", (uid, tid, time.time(), s, r))

    def get_result(self, uid: str, tid: str) -> dict | None:
        self.check_id(tid, "take id")
        with self.a._connect() as db:
            row = db.execute("SELECT * FROM results WHERE user_id=? AND take_id=?", (uid, tid)).fetchone()
        return None if row is None else {"summary": json.loads(row["summary"]), "result": json.loads(row["result"]), "updated": row["updated"]}

    # --- scores --------------------------------------------------------------
    def put_score(self, uid: str, sid: str, body: dict) -> dict:
        self.check_id(sid, "score id")
        sha = self.check_sha(body.get("fileSha"))
        if self.blob_size(uid, sha) is None:
            raise CloudError(409, "blob_missing", "请先上传乐谱文件")
        title, kind = body.get("title"), body.get("kind")
        if not isinstance(title, str) or not title.strip() or len(title) > 200 or kind not in KINDS:
            raise CloudError(400, "bad_request", "乐谱信息无效")
        edits = self._json_field(body.get("edits", {}), "edits")
        now = time.time()
        with self.a._connect() as db:
            old = db.execute("SELECT file_sha FROM scores WHERE user_id=? AND id=?", (uid, sid)).fetchone()
            db.execute("INSERT INTO scores VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET "
                       "title=excluded.title, kind=excluded.kind, file_sha=excluded.file_sha, updated=excluded.updated, edits=excluded.edits",
                       (uid, sid, title.strip(), kind, sha, now, edits))
            if old and old["file_sha"] != sha:
                self._gc_blob(db, uid, old["file_sha"])
        return {"id": sid, "updated": now}

    def delete_score(self, uid: str, sid: str) -> None:
        self.check_id(sid, "score id")
        with self.a._connect() as db:
            row = db.execute("SELECT file_sha FROM scores WHERE user_id=? AND id=?", (uid, sid)).fetchone()
            db.execute("DELETE FROM scores WHERE user_id=? AND id=?", (uid, sid))
            if row:
                self._gc_blob(db, uid, row["file_sha"])

    # --- listings ------------------------------------------------------------
    def snapshot(self, uid: str) -> dict:
        """Everything the client needs to merge: metadata only, no blobs and no full reports."""
        with self.a._connect() as db:
            takes = [{"id": r["id"], "scoreKey": r["score_key"], "audioSha": r["audio_sha"], "created": r["created"],
                      "updated": r["updated"], "meta": json.loads(r["meta"]), "hasResult": bool(r["has"])}
                     for r in db.execute("SELECT t.*, (SELECT 1 FROM results r WHERE r.user_id=t.user_id AND r.take_id=t.id) AS has "
                                         "FROM takes t WHERE t.user_id=? ORDER BY t.created", (uid,)).fetchall()]
            scores = [{"id": r["id"], "title": r["title"], "kind": r["kind"], "fileSha": r["file_sha"], "updated": r["updated"],
                       "edits": json.loads(r["edits"])}
                      for r in db.execute("SELECT * FROM scores WHERE user_id=? ORDER BY updated DESC", (uid,)).fetchall()]
        return {"takes": takes, "scores": scores, "usedBytes": self.used_bytes(uid), "quotaBytes": self.quota}

    def history(self, uid: str, score_key: str) -> list[dict]:
        with self.a._connect() as db:
            rows = db.execute("SELECT t.id, t.created, t.meta, r.summary FROM takes t JOIN results r "
                              "ON r.user_id=t.user_id AND r.take_id=t.id WHERE t.user_id=? AND t.score_key=? ORDER BY t.created",
                              (uid, score_key)).fetchall()
        return [{"id": r["id"], "created": r["created"], "meta": json.loads(r["meta"]), "summary": json.loads(r["summary"])} for r in rows]

    def delete_user(self, uid: str) -> None:
        with self.a._connect() as db:
            for table in ("results", "takes", "scores", "blobs"):
                db.execute(f"DELETE FROM {table} WHERE user_id=?", (uid,))
        shutil.rmtree(self.blob_root / uid, ignore_errors=True)
