import base64
import http.client
import json
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from .server import Handler
from .test_engine import recording, score


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, origin="http://localhost:3000"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            conn.request(method, path, json.dumps(body).encode() if body is not None else None,
                         {"Origin": origin, "Content-Type": "application/json"})
            response = conn.getresponse()
            content = response.read()
            return response.status, dict(response.getheaders()), json.loads(content) if response.getheader("Content-Type", "").startswith("application/json") else {}
        finally:
            conn.close()

    def test_job_lifecycle_and_origin(self):
        status, _, data = self.request("POST", "/jobs", {"scoreXml": score(),
            "audioWavBase64": base64.b64encode(recording()).decode(), "bpm": 60, "instrument": "violin"})
        self.assertEqual(status, 202)
        self.assertEqual(len(data["id"]), 32)
        for _ in range(40):
            status, headers, job = self.request("GET", "/jobs/" + data["id"])
            self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:3000")
            if job["status"] == "completed":
                self.assertEqual(job["result"]["summary"]["noteCount"], 5)
                break
            time.sleep(.05)
        else:
            self.fail("job did not complete")
        status, _, _ = self.request("GET", "/jobs/" + data["id"], origin="https://untrusted.example")
        self.assertEqual(status, 403)

    def test_bad_upload_returns_client_error(self):
        status, _, data = self.request("POST", "/jobs", {"scoreXml": score(),
            "audioWavBase64": "???", "bpm": 60, "instrument": "violin"})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_analysis_of_selected_excerpt_over_http(self):
        status, _, data = self.request("POST", "/jobs", {"scoreXml": score(), "startMeasure": 3,
            "audioWavBase64": base64.b64encode(recording((72, 74, 76))).decode(), "bpm": 60, "instrument": "violin"})
        self.assertEqual(status, 202)
        for _ in range(40):
            _, _, job = self.request("GET", "/jobs/" + data["id"])
            if job["status"] == "completed":
                self.assertEqual(job["result"]["summary"]["startMeasure"], 3)
                self.assertEqual(job["result"]["summary"]["noteCount"], 3)
                break
            time.sleep(.05)
        else:
            self.fail("excerpt analysis did not complete")

    def test_metronome_sync_over_http(self):
        status, _, data = self.request("POST", "/jobs", {"scoreXml": score(), "startMeasure": 3,
            "syncMode": "metronome", "firstBeatAudioSec": 0.5,
            "audioWavBase64": base64.b64encode(recording((72, 74, 76))).decode(), "bpm": 60, "instrument": "violin"})
        self.assertEqual(status, 202)
        for _ in range(40):
            _, _, job = self.request("GET", "/jobs/" + data["id"])
            if job["status"] == "completed":
                self.assertEqual(job["result"]["summary"]["syncMode"], "metronome")
                self.assertEqual(job["result"]["summary"]["recordedFirstBeatSec"], 0.5)
                break
            time.sleep(.05)
        else:
            self.fail("metronome analysis did not complete")

    def test_omr_async_job_without_network(self):
        from unittest.mock import patch
        from .server import jobs, lock
        result = {"musicXml": score(), "compatible": True, "noteCount": 5, "measureCount": 5}
        with patch("analysis_service.server.recognize", return_value=result) as recognize:
            status, _, data = self.request("POST", "/omr/jobs", {"pdfBase64": base64.b64encode(b"%PDF-sample").decode(),
                "filename": "demo.pdf", "prependRestBeats": 4})
            self.assertEqual(status, 202)
            for _ in range(40):
                status, _, job = self.request("GET", "/omr/jobs/" + data["id"])
                if job["status"] == "completed":
                    break
                time.sleep(.05)
            else:
                self.fail("OMR job did not complete")
            recognize.assert_called_once()
            self.assertEqual(recognize.call_args.args[1:3], ("demo.pdf", 4))
            status, _, _ = self.request("GET", "/jobs/" + data["id"])
            self.assertEqual(status, 404)
        # The result is held only in process memory; keep test jobs isolated.
        with lock:
            jobs.pop(data["id"], None)


if __name__ == "__main__":
    unittest.main()
