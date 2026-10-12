"""Opt-in replay of the original, unmodified Suzuki upload (no media in git).

SF_SUZUKI_MP3=/path/to/take.mp3 SF_SUZUKI_XML=/path/to/score.musicxml
python3 -B -m unittest analysis_service.test_suzuki_real -v
Uses the builtin-detector path so results don't depend on optional Vamp plugins.
The PDF is one page (measures 1-40) of a complete performance: the take runs
~44 s past the notation, and the OMR clef is an octave too high. Expected:
rescue with octave -12, score only the anchored prefix (m.1-37), and report
the untracked tail as take_beyond_score instead of failing the whole take.
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
    def test_take_longer_than_score_scores_anchored_prefix(self):
        pcm = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", os.environ["SF_SUZUKI_MP3"],
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
            self.assertTrue(s["autoMeasureSync"])
            self.assertEqual(s["octaveShift"], -12)
            self.assertIsNone(s["syncAdvice"])
            self.assertGreaterEqual(s["pitchScore"], 90)
            self.assertGreaterEqual(s["rhythmScore"], 80)
            self.assertEqual(s["startMeasure"], 1)
            self.assertTrue(36 <= s["endMeasure"] <= 38, s["endMeasure"])
            self.assertTrue(68 <= s["takeBeyondScoreAfterSec"] <= 76, s["takeBeyondScoreAfterSec"])
            self.assertIn("range", s["rescueReasons"])
            self.assertIn("take_beyond_score", result["quality"]["issues"])
            self.assertEqual(result["quality"]["outcome"], "partial")
            self.assertTrue(result["quality"]["followReady"])
            self.assertTrue(any("谱面可能缺页" in line for line in result["limitations"]))
            self.assertEqual(result["diagnostics"]["analysisId"], job_id)
            print(f"SUZUKI_PREFIX_OK pitch={s['pitchScore']} timing={s['rhythmScore']} "
                  f"range={s['startMeasure']}-{s['endMeasure']} shift={s['octaveShift']} "
                  f"tail_after={s['takeBeyondScoreAfterSec']}")
        finally:
            with lock:
                jobs.pop(job_id, None)
