"""Private, durable job metadata and artifacts; no files are created on import."""

import fcntl
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time
from uuid import uuid4


TERMINAL = ("completed", "failed")


class QueueFull(Exception):
    pass


class JobStore:
    def __init__(self, root):
        self.root = Path(root).expanduser()
        if self.root.is_symlink():
            raise ValueError("Job storage cannot be a symlink")
        self.root = self.root.resolve()
        if self.root.is_relative_to(Path(__file__).resolve().parents[1]):
            raise ValueError("Job storage must be outside the repository")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.db = self.root / "jobs.sqlite3"
        fd = os.open(self.db, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        self.db.chmod(0o600)
        self._lease = None
        with self._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, status TEXT NOT NULL,
                created REAL NOT NULL, attempt INTEGER NOT NULL, payload TEXT NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS jobs_cache ON jobs(cache_key, created)")

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.db, timeout=15)
        try:
            with db:
                yield db
        finally:
            db.close()

    def _write(self, path, data):
        temp = path.with_name(path.name + "." + uuid4().hex + ".tmp")
        try:
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
            self._sync_dir(path.parent)
        finally:
            temp.unlink(missing_ok=True)

    @staticmethod
    def _sync_dir(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    @staticmethod
    def _json(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)

    def acquire_and_recover(self):
        """Only the serving process may recover unfinished work at startup."""
        fd = os.open(self.root / ".server.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            os.close(fd)
            raise
        self._lease = fd
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id, payload FROM jobs WHERE status NOT IN ('completed', 'failed')").fetchall()
            for job_id, raw in rows:
                job = json.loads(raw)
                job.update(status="failed", stage="interrupted", interrupted=True,
                           errorClass="ServiceRestart", finishedAt=time.time(),
                           error="服务重启导致任务中断，请重新提交；之前的分析阶段未恢复。")
                db.execute("UPDATE jobs SET status='failed', payload=? WHERE id=?", (self._json(job), job_id))
        return len(rows)

    def close(self):
        if self._lease is not None:
            os.close(self._lease)
            self._lease = None

    def _load(self, db, job_id, raw):
        job = json.loads(raw)
        digest = job.pop("_resultSha256", None)
        if job["status"] == "completed":
            try:
                data = (self.root / job_id / "result.json").read_bytes()
                if hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError("Result integrity mismatch")
                result = json.loads(data)
                if not isinstance(result, dict):
                    raise ValueError("Invalid result")
                job["result"] = result
            except (OSError, ValueError):
                job.update(status="failed", stage="loading_result", errorClass="ResultUnavailable",
                           finishedAt=time.time(), error="已保存的结果不可读取，请重新提交分析。")
                db.execute("UPDATE jobs SET status='failed', payload=? WHERE id=?", (self._json(job), job_id))
        return job

    def get(self, job_id, ttl=3600):
        with self._connect() as db:
            row = db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            job = self._load(db, job_id, row[0])
            if job["status"] in TERMINAL and time.time() - job.get("finishedAt", job["createdAt"]) > ttl:
                return None
            return job

    def contains(self, job_id):
        with self._connect() as db:
            return db.execute("SELECT 1 FROM jobs WHERE id=?", (job_id,)).fetchone() is not None

    def submit(self, kind, inputs, parameters, version, *, max_pending=4, ttl=3600):
        """Commit inputs before enqueueing; serialize cache lookup and admission."""
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in inputs.items()}
        key = hashlib.sha256(self._json([kind, hashes, parameters, version]).encode()).hexdigest()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id, payload, attempt FROM jobs WHERE cache_key=? ORDER BY created DESC, rowid DESC", (key,)).fetchall()
            for job_id, raw, _ in rows:
                job = self._load(db, job_id, raw)
                if job["status"] not in TERMINAL or (job["status"] == "completed" and
                        time.time() - job.get("finishedAt", job["createdAt"]) <= ttl):
                    return job, False
            pending = db.execute("SELECT COUNT(*) FROM jobs WHERE status NOT IN ('completed', 'failed')").fetchone()[0]
            if pending >= max_pending:
                raise QueueFull()
            job_id = uuid4().hex
            attempt = max((row[2] for row in rows), default=0) + 1
            job = {"id": job_id, "kind": kind, "status": "queued", "stage": "queued",
                   "createdAt": time.time(), "attempt": attempt}
            if rows:
                job["retryOf"] = rows[0][0]
            folder = self.root / job_id
            folder.mkdir(mode=0o700)
            try:
                for name, data in inputs.items():
                    if name not in ("audio.wav", "score.musicxml", "input.pdf"):
                        raise ValueError("Invalid input artifact")
                    self._write(folder / name, data)
                self._write(folder / "request.json", self._json({"kind": kind, "parameters": parameters, "version": version}).encode())
                self._sync_dir(self.root)
                db.execute("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)",
                           (job_id, key, "queued", job["createdAt"], attempt, self._json(job)))
            except Exception:
                shutil.rmtree(folder)
                raise
            return job, True

    def update(self, job_id, change):
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise KeyError(job_id)
            job = json.loads(row[0])
            change = dict(change)
            result = change.pop("result", None)
            if change.get("status") == "completed":
                if not isinstance(result, dict):
                    raise ValueError("Completed jobs require a result")
                data = self._json(result).encode()
                self._write(self.root / job_id / "result.json", data)
                job["_resultSha256"] = hashlib.sha256(data).hexdigest()
            job.update(change)
            db.execute("UPDATE jobs SET status=?, payload=? WHERE id=?", (job["status"], self._json(job), job_id))

    def expire(self, ttl=3600):
        expired = []
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for job_id, raw in db.execute("SELECT id, payload FROM jobs WHERE status IN ('completed', 'failed')").fetchall():
                job = json.loads(raw)
                if time.time() - job.get("finishedAt", job["createdAt"]) > ttl:
                    db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
                    expired.append(job_id)
        for job_id in expired:
            shutil.rmtree(self.root / job_id, ignore_errors=True)
        return len(expired)
