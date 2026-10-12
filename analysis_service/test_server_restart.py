"""Exercise real server startup/restart against an isolated private data root."""
import base64
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from .engine import VERSION, analyze
from .job_store import JobStore
from .test_engine import recording, score


class ServerRestartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/tmp/opencode")
        self.root = Path(self.temp.name) / "private"
        self.store = JobStore(self.root)
        self.process = None

    def tearDown(self):
        self.stop()
        self.store.close()
        self.temp.cleanup()

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.communicate(timeout=5)
            self.process = None

    def start(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        env = {**os.environ, "ANALYSIS_HOST": "127.0.0.1", "ANALYSIS_PORT": str(self.port),
               "ANALYSIS_DATA_DIR": str(self.root), "ANALYSIS_API_TOKEN": ""}
        self.process = subprocess.Popen([sys.executable, "-B", "-m", "analysis_service.server"],
                                        cwd=Path(__file__).resolve().parents[1], env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail(f"Server exited during startup: {self.process.communicate()[1].decode()}")
            try:
                status, health = self.request("GET", "/health")
                self.assertEqual(status, 200)
                self.assertEqual(health["stringAlgorithmVersion"], VERSION)
                return
            except OSError:
                time.sleep(.03)
        self.fail("Server did not start")

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_real_restart_retains_completed_results_and_interrupts_unfinished_work(self):
        audio, xml = recording(), score()
        inputs = {"audio.wav": audio, "score.musicxml": xml.encode()}
        parameters = {"bpm": 60.0, "instrument": "violin", "startMeasure": 1,
                      "firstBeatAudioSec": None, "syncMode": "vamp-beat", "measureSync": None,
                      "pitchToleranceCents": 25.0}
        queued, _ = self.store.submit("analysis", inputs, parameters, [VERSION, "evidence-1"])
        running, _ = self.store.submit("analysis", inputs, {**parameters, "bpm": 62.0}, [VERSION, "evidence-1"])
        self.store.update(running["id"], {"status": "analyzing", "stage": "extracting_features"})
        completed, _ = self.store.submit("analysis", inputs, {**parameters, "bpm": 61.0}, [VERSION, "evidence-1"])
        saved = analyze(audio, xml, 61, "violin")
        self.store.update(completed["id"], {"status": "completed", "finishedAt": time.time(), "result": saved})
        self.start()
        for previous in (queued, running):
            status, recovered = self.request("GET", "/jobs/" + previous["id"])
            self.assertEqual(status, 200)
            self.assertEqual(recovered["status"], "failed")
            self.assertEqual(recovered["stage"], "interrupted")
            self.assertEqual(recovered["errorClass"], "ServiceRestart")
            self.assertNotIn("result", recovered)
        status, restored = self.request("GET", "/jobs/" + completed["id"])
        self.assertEqual(status, 200)
        self.assertEqual(restored["result"], saved)
        body = {"scoreXml": xml, "audioWavBase64": base64.b64encode(audio).decode(),
                "bpm": 60, "instrument": "violin"}
        status, retry = self.request("POST", "/jobs", body)
        self.assertEqual(status, 202)
        self.assertNotEqual(retry["id"], queued["id"])
        for _ in range(150):
            _, result = self.request("GET", "/jobs/" + retry["id"])
            if result["status"] in ("completed", "failed"):
                break
            time.sleep(.05)
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(result["attempt"], 2)
        self.assertEqual(result["retryOf"], queued["id"])
        self.stop()
        self.start()
        _, retained = self.request("GET", "/jobs/" + retry["id"])
        self.assertEqual(retained["result"], result["result"])
        status, duplicate = self.request("POST", "/jobs", body)
        self.assertEqual(status, 202)
        self.assertEqual(duplicate["id"], retry["id"])


if __name__ == "__main__":
    unittest.main()
