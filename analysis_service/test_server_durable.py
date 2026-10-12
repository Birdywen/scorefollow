import base64
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from . import server
from .job_store import JobStore
from .test_engine import recording, score


class DurableApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/tmp/opencode")
        self.store = JobStore(Path(self.temp.name) / "private")
        self.config = patch.object(server, "job_store", self.store)
        self.config.start()
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.body = {"scoreXml": score(), "audioWavBase64": base64.b64encode(recording()).decode(),
                     "bpm": 60, "instrument": "violin"}

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.config.stop()
        self.store.close()
        self.temp.cleanup()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def wait(self, job_id, path="/jobs/"):
        for _ in range(100):
            status, job = self.request("GET", path + job_id)
            self.assertEqual(status, 200)
            if job["status"] in ("completed", "failed"):
                return job
            time.sleep(.02)
        self.fail("Job did not finish")

    def test_completed_idempotent_request_and_get_survive_memory_loss(self):
        with patch.object(server.vamp_features, "extract_all", return_value=(None, None, None)) as extract:
            status, submitted = self.request("POST", "/jobs", self.body)
            self.assertEqual(status, 202)
            job = self.wait(submitted["id"])
            self.assertEqual(job["status"], "completed", job.get("error"))
            with server.lock:
                server.jobs.pop(job["id"], None)
            status, restored = self.request("GET", "/jobs/" + job["id"])
            self.assertEqual(status, 200)
            self.assertEqual(restored["result"], job["result"])
            status, duplicate = self.request("POST", "/jobs", self.body)
            self.assertEqual(status, 202)
            self.assertEqual(duplicate["id"], job["id"])
            extract.assert_called_once()

    def test_running_duplicate_computes_once_and_commits_inputs_before_enqueue(self):
        entered, release = threading.Event(), threading.Event()
        def extract(audio):
            entered.set()
            if not release.wait(3):
                raise TimeoutError("Fixture was not released")
            return None, None, None
        with patch.object(server.vamp_features, "extract_all", side_effect=extract) as sensor:
            try:
                _, first = self.request("POST", "/jobs", self.body)
                self.assertTrue(entered.wait(2))
                self.assertEqual((self.store.root / first["id"] / "audio.wav").read_bytes(), recording())
                _, duplicate = self.request("POST", "/jobs", self.body)
                self.assertEqual(duplicate["id"], first["id"])
            finally:
                release.set()
            self.assertEqual(self.wait(first["id"])["status"], "completed")
            sensor.assert_called_once()

    def test_failed_attempt_retry_has_new_id_and_keeps_old_diagnostics(self):
        with patch.object(server.vamp_features, "extract_all", side_effect=RuntimeError("private-do-not-log")):
            _, first = self.request("POST", "/jobs", self.body)
            failed = self.wait(first["id"])
            self.assertEqual(failed["status"], "failed")
        with patch.object(server.vamp_features, "extract_all", return_value=(None, None, None)):
            _, retry = self.request("POST", "/jobs", self.body)
            job = self.wait(retry["id"])
        self.assertNotEqual(retry["id"], first["id"])
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["attempt"], 2)
        self.assertEqual(job["retryOf"], first["id"])
        _, previous = self.request("GET", "/jobs/" + first["id"])
        self.assertEqual(previous["errorClass"], "RuntimeError")
        self.assertNotIn("private-do-not-log", json.dumps(previous))

    def test_enqueue_failure_is_terminal_and_retryable(self):
        with patch.object(server.pool, "submit", side_effect=RuntimeError("shutdown")):
            status, _ = self.request("POST", "/jobs", self.body)
            self.assertEqual(status, 503)
        with patch.object(server.vamp_features, "extract_all", return_value=(None, None, None)):
            _, retry = self.request("POST", "/jobs", self.body)
            completed = self.wait(retry["id"])
            self.assertEqual(completed["status"], "completed")
            self.assertEqual(completed["attempt"], 2)

    def test_result_storage_failure_cannot_appear_completed(self):
        write = self.store._write
        def fail_result(path, data):
            if path.name == "result.json":
                raise OSError("private disk error")
            return write(path, data)
        with patch.object(self.store, "_write", side_effect=fail_result), \
                patch.object(server.vamp_features, "extract_all", return_value=(None, None, None)):
            _, submitted = self.request("POST", "/jobs", self.body)
            failed = self.wait(submitted["id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["stage"], "persisting_result")
        self.assertNotIn("result", failed)
        self.assertNotIn("private disk error", json.dumps(failed))

    def test_metadata_failure_after_result_write_cannot_appear_completed(self):
        encode = self.store._json
        def fail_completion(value):
            if isinstance(value, dict) and value.get("status") == "completed":
                import sqlite3
                raise sqlite3.OperationalError("private metadata error")
            return encode(value)
        with patch.object(self.store, "_json", side_effect=fail_completion), \
                patch.object(server.vamp_features, "extract_all", return_value=(None, None, None)):
            _, submitted = self.request("POST", "/jobs", self.body)
            failed = self.wait(submitted["id"])
        self.assertTrue((self.store.root / submitted["id"] / "result.json").exists())
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["stage"], "persisting_result")
        self.assertNotIn("result", failed)
        self.assertNotIn("private metadata error", json.dumps(failed))

    def test_omr_result_is_durable_and_kind_is_checked(self):
        body = {"pdfBase64": base64.b64encode(b"%PDF-sample").decode(), "filename": "demo.pdf"}
        with patch.object(server, "recognize", return_value={"musicXml": score(), "compatible": True}) as recognize:
            _, submitted = self.request("POST", "/omr/jobs", body)
            job = self.wait(submitted["id"], "/omr/jobs/")
            self.assertEqual(job["status"], "completed")
            _, duplicate = self.request("POST", "/omr/jobs", body)
            self.assertEqual(duplicate["id"], submitted["id"])
            recognize.assert_called_once()
        with server.lock:
            server.jobs.pop(job["id"], None)
        status, restored = self.request("GET", "/omr/jobs/" + job["id"])
        self.assertEqual(status, 200)
        self.assertEqual(restored["result"], job["result"])
        self.assertEqual(self.request("GET", "/jobs/" + job["id"])[0], 404)


if __name__ == "__main__":
    unittest.main()
