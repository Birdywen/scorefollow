import json
import os
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from .engine import parse_score
from .omr import recognize, restore_first_rest
from .test_engine import score


class OmrTests(unittest.TestCase):
    def test_full_presigned_upload_trigger_poll_download(self):
        requests = []

        def fake_fetch(url, *, method="GET", data=None, headers=None, limit=5_000_000):
            requests.append((url, method, data, headers))
            if "presigned-upload?" in url:
                return json.dumps({"url": "https://bucket.example/upload", "filename": "s3-pdf-name"}).encode()
            if url == "https://bucket.example/upload":
                return b""
            if url.endswith("/presigned-upload"):
                return b'{"inference_id":"test-id"}'
            if url.endswith("/recognize/test-id"):
                return b'{"job_status":"completed", "body":{"filename_musicxml":"storage/name.xml"}}'
            if "presigned-download/" in url:
                return b'{"url":"https://bucket.example/result.musicxml"}'
            if url == "https://bucket.example/result.musicxml":
                return score().encode()
            raise AssertionError(url)

        with patch.dict(os.environ, {"HALBESTUNDE_OMR_API_KEY": "test-only"}), patch("analysis_service.omr.fetch", side_effect=fake_fetch):
            result = recognize(b"%PDF-1.4 sample", "my score.pdf")
        self.assertTrue(result["compatible"])
        self.assertEqual(result["noteCount"], 5)
        self.assertIn("filename=my+score.pdf", requests[0][0])
        self.assertEqual(requests[1][1:3], ("PUT", b"%PDF-1.4 sample"))
        submitted = json.loads(requests[2][2])
        self.assertTrue(submitted["pdf_image"])
        self.assertEqual(submitted["filename"], "s3-pdf-name")
        self.assertEqual(len(submitted["device_hash"]), 32)
        self.assertIn("url_storage=storage%2Fname.xml", requests[4][0])
        self.assertTrue(all("test-only" not in url for url, _, _, _ in requests))
        self.assertNotIn("api-key", requests[1][3])

    def test_restore_manual_first_rest_and_shift_measures(self):
        xml = restore_first_rest(score(), 4)
        notes = parse_score(xml)
        self.assertEqual(notes[0]["measure"], 2)
        self.assertEqual(notes[0]["onsetBeat"], 4)
        self.assertEqual(notes[-1]["measure"], 6)
        namespaced = score().replace("<score-partwise>", '<score-partwise xmlns="urn:musicxml">')
        restored = restore_first_rest(namespaced, 3)
        self.assertEqual(parse_score(restored)[0]["onsetBeat"], 3)
        root = ET.fromstring(restored)
        self.assertIsNotNone(root.find("./{*}part/{*}measure/{*}attributes/{*}divisions"))
        with self.assertRaisesRegex(ValueError, "divisions"):
            restore_first_rest('<score-partwise><part><measure><note><rest/><duration>1</duration></note></measure></part></score-partwise>', 4)
        decimal = restore_first_rest(score((69,)).replace("<divisions>1</divisions>", "<divisions>1.0</divisions>"), 4)
        self.assertEqual(parse_score(decimal)[0]["onsetBeat"], 4)

    def test_missing_key_is_a_clear_failure(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "HALBESTUNDE_OMR_API_KEY"):
                recognize(b"%PDF-test", "test.pdf")

    def test_failed_recognition_reports_opening_rest_hint(self):
        states = iter([
            {"url": "https://bucket.example/upload", "filename": "remote-name"},
            {"inference_id": "test-id"},
            {"job_status": "failed"},
        ])
        with patch.dict(os.environ, {"HALBESTUNDE_OMR_API_KEY": "test-only"}), \
             patch("analysis_service.omr.fetch", return_value=b""), \
             patch("analysis_service.omr.get_json", side_effect=lambda *args, **kwargs: next(states)):
            with self.assertRaisesRegex(ValueError, "首小节"):
                recognize(b"%PDF-test", "test.pdf")


if __name__ == "__main__":
    unittest.main()
