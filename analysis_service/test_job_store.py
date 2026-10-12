from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from .job_store import JobStore, QueueFull


class JobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/tmp/opencode")
        self.store = JobStore(Path(self.temp.name) / "private")

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def submit(self, version="test-1", **kwargs):
        return self.store.submit("analysis", {"audio.wav": b"wav", "score.musicxml": b"xml"},
                                 {"bpm": 60}, version, **kwargs)

    def complete(self, job):
        self.store.update(job["id"], {"status": "completed", "finishedAt": time.time(),
                                      "result": {"diagnostics": {"analysisId": job["id"]}}})

    def test_completed_result_survives_reopen_and_reuses_original_id(self):
        job, created = self.submit()
        self.assertTrue(created)
        self.complete(job)
        reopened = JobStore(self.store.root)
        self.assertEqual(reopened.get(job["id"])["result"]["diagnostics"]["analysisId"], job["id"])
        cached, created = self.submit()
        self.assertFalse(created)
        self.assertEqual(cached["id"], job["id"])
        self.assertEqual((self.store.root / job["id"] / "audio.wav").read_bytes(), b"wav")

    def test_changed_version_or_parameters_do_not_reuse_cached_result(self):
        job, _ = self.submit()
        self.complete(job)
        changed, created = self.submit(version="test-2")
        self.assertTrue(created)
        self.assertNotEqual(changed["id"], job["id"])
        changed, created = self.store.submit("analysis", {"audio.wav": b"wav", "score.musicxml": b"xml"},
                                              {"bpm": 61}, "test-1")
        self.assertTrue(created)
        self.assertNotEqual(changed["id"], job["id"])

    def test_concurrent_duplicate_submissions_admit_one_job_even_when_full(self):
        with ThreadPoolExecutor(max_workers=8) as workers:
            results = list(workers.map(lambda _: self.submit(max_pending=1), range(8)))
        self.assertEqual(len({job["id"] for job, _ in results}), 1)
        self.assertEqual(sum(created for _, created in results), 1)
        with self.assertRaises(QueueFull):
            self.submit(version="different", max_pending=1)

    def test_restart_keeps_diagnostics_and_retry_creates_new_attempt(self):
        queued, _ = self.submit()
        active, _ = self.submit(version="other")
        self.store.update(active["id"], {"status": "analyzing", "stage": "extracting_features"})
        self.assertEqual(self.store.acquire_and_recover(), 2)
        for job in (queued, active):
            recovered = self.store.get(job["id"])
            self.assertEqual(recovered["status"], "failed")
            self.assertEqual(recovered["stage"], "interrupted")
            self.assertTrue(recovered["interrupted"])
            self.assertEqual(recovered["errorClass"], "ServiceRestart")
        retry, created = self.submit()
        self.assertTrue(created)
        self.assertEqual(retry["attempt"], 2)
        self.assertEqual(retry["retryOf"], queued["id"])
        self.assertNotEqual(retry["id"], queued["id"])

    def test_second_server_cannot_recover_an_active_server_jobs(self):
        self.store.acquire_and_recover()
        second = JobStore(self.store.root)
        try:
            with self.assertRaises(BlockingIOError):
                second.acquire_and_recover()
        finally:
            second.close()

    def test_failed_result_write_never_publishes_completed(self):
        job, _ = self.submit()
        with patch.object(self.store, "_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.complete(job)
        self.assertEqual(self.store.get(job["id"])["status"], "queued")
        self.assertNotIn("result", self.store.get(job["id"]))

    def test_file_written_before_metadata_commit_is_not_recovered_as_success(self):
        job, _ = self.submit()
        self.store._write(self.store.root / job["id"] / "result.json", b'{"uncommitted": true}')
        self.store.acquire_and_recover()
        recovered = self.store.get(job["id"])
        self.assertEqual(recovered["status"], "failed")
        self.assertNotIn("result", recovered)

    def test_corrupt_or_missing_result_is_failed_and_not_reused(self):
        for contents in (b"not json", b"[]", b'{"silently_changed": true}', None):
            with self.subTest(contents=contents):
                job, _ = self.submit()
                self.complete(job)
                file = self.store.root / job["id"] / "result.json"
                if contents is None:
                    file.unlink()
                else:
                    file.write_bytes(contents)
                loaded = self.store.get(job["id"])
                self.assertEqual(loaded["status"], "failed")
                self.assertEqual(loaded["errorClass"], "ResultUnavailable")
                replacement, created = self.submit()
                self.assertTrue(created)
                self.assertNotEqual(replacement["id"], job["id"])
                self.store.update(replacement["id"], {"status": "failed", "finishedAt": time.time()})

    def test_ttl_only_expires_terminal_jobs_and_cleans_their_files(self):
        active, _ = self.submit()
        self.store.update(active["id"], {"createdAt": time.time() - 100})
        self.assertIsNotNone(self.store.get(active["id"], ttl=1))
        completed, _ = self.submit(version="other")
        self.complete(completed)
        self.store.update(completed["id"], {"finishedAt": time.time() - 100})
        self.assertEqual(self.store.expire(ttl=1), 1)
        self.assertTrue(self.store.contains(active["id"]))
        self.assertFalse((self.store.root / completed["id"]).exists())

    def test_private_permissions_and_no_repo_storage(self):
        job, _ = self.submit()
        self.assertEqual(self.store.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.store.db.stat().st_mode & 0o777, 0o600)
        folder = self.store.root / job["id"]
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in folder.iterdir()))
        self.assertEqual(json.loads((folder / "request.json").read_text())["version"], "test-1")
        with self.assertRaises(ValueError):
            JobStore(Path(__file__).parent / "private-job-fixture")


if __name__ == "__main__":
    unittest.main()
