"""Opt-in replay of the original, unmodified Suzuki upload (no media in git).

SF_SUZUKI_MP3=/path/to/take.mp3 SF_SUZUKI_XML=/path/to/score.musicxml
python3 -B -m unittest analysis_service.test_suzuki_real -v
Uses the builtin-detector path so results don't depend on optional Vamp plugins.
The PDF is incomplete and its measures unverified; the recording is complete.
XML completeness is unknown. This checks fail-closed reporting, not high scores.
"""
import io
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import wave

from .server import jobs, lock, run


@unittest.skipUnless(os.getenv("SF_SUZUKI_MP3") and os.getenv("SF_SUZUKI_XML"),
                     "Real Suzuki fixture paths not configured")
class SuzukiReplayTests(unittest.TestCase):
    def test_original_upload_does_not_claim_verified_full_alignment(self):
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", os.environ["SF_SUZUKI_MP3"],
                              "-ac", "1", "-ar", "22050", "-f", "s16le", "pipe:1"],
                             capture_output=True, check=True, timeout=60).stdout
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as writer:
            writer.setparams((1, 2, 22050, len(pcm) // 2, "NONE", "not compressed"))
            writer.writeframes(pcm)
        xml = Path(os.environ["SF_SUZUKI_XML"]).read_text()
        job_id = "suzuki-real-replay"
        with lock:
            jobs[job_id] = {"id": job_id, "status": "queued"}
        try:
            with patch("analysis_service.server.vamp_features.extract_all", return_value=(None, None, None)):
                run(job_id, buffer.getvalue(), xml, 80, "cello", 1, sync_mode="vamp-beat")
            job = jobs[job_id]
            self.assertEqual(job["status"], "completed", job.get("error"))
            result, s = job["result"], job["result"]["summary"]
            self.assertFalse(s["autoMeasureSync"])
            self.assertIsNotNone(s["syncAdvice"])
            self.assertIn("谱面是否完整", s["syncAdvice"])
            self.assertIn("alignment_unverified", result["quality"]["issues"])
            self.assertIn(result["quality"]["outcome"], ("partial", "insufficient_evidence"))
            self.assertFalse(result["quality"]["followReady"])
            self.assertEqual(result["diagnostics"]["analysisId"], job_id)
            print(f"SUZUKI_BOUNDARY_GATE_OK pitch={s['pitchScore']} timing={s['rhythmScore']} "
                  f"range={s['startMeasure']}-{s['endMeasure']} shift={s['octaveShift']}")
        finally:
            with lock:
                jobs.pop(job_id, None)
