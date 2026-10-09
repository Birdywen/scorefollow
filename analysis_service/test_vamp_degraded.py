"""Vamp degradation is explicit in the result payload (not logs only)."""
import sys
import unittest
from unittest.mock import patch

from . import vamp_features
from .engine import analyze
from .test_engine import recording, score


class VampDegradedTests(unittest.TestCase):
    def test_degraded_true_when_vamp_import_fails(self):
        wav = recording()
        # Real import failure path: `import vamp` raises, each extractor
        # returns None and the engine falls back to builtin detectors.
        with patch.dict(sys.modules, {"vamp": None}):
            pitch, onsets, beats = vamp_features.extract_all(wav)
        self.assertIsNone(pitch)
        self.assertIsNone(onsets)
        self.assertIsNone(beats)
        reasons = vamp_features.degradation_reasons(pitch, onsets, beats)
        self.assertTrue(vamp_features.is_degraded(pitch, onsets, beats))
        self.assertIn("pitch:builtin", reasons)
        self.assertIn("onset:builtin", reasons)
        self.assertIn("beat:legacy", reasons)
        result = analyze(wav, score(), 60, "violin")
        summary = result["summary"]
        self.assertTrue(summary["degraded"])
        self.assertIn("pitch:builtin", summary["degradedReasons"])
        self.assertIn("onset:builtin", summary["degradedReasons"])
        self.assertIn("beat:legacy", summary["degradedReasons"])
        # Backward compatibility: existing keys remain.
        self.assertIn("sensors", summary)
        self.assertEqual(summary["sensors"], ["builtin"])

    def test_degraded_false_when_detectors_return_values(self):
        wav = recording()
        segments = [(0.13 + i, 0.89 + i, float(m)) for i, m in enumerate((69, 71, 72, 74, 76))]
        onsets = [0.12 + i for i in range(5)]
        beats = [0.12 + i for i in range(6)]
        result = analyze(wav, score(), 60, "violin", sync_mode="vamp-beat",
                         pitch_notes=segments, onset_hint=onsets, beat_map=beats)
        summary = result["summary"]
        self.assertEqual(summary["syncMode"], "vamp-beat")
        self.assertFalse(summary["degraded"])
        self.assertEqual(summary["degradedReasons"], [])
        self.assertIn("fused-pitch", summary["sensors"])
        self.assertIn("qm-onset", summary["sensors"])

    def test_job_payload_exposes_degraded(self):
        from . import server
        wav = recording()
        xml = score()
        # Degraded job payload (vamp absent).
        job_id = "test-vamp-degraded-absent"
        server.jobs[job_id] = {"id": job_id, "status": "queued", "createdAt": 0, "kind": "analysis"}
        try:
            with patch.object(server.vamp_features, "extract_all", return_value=(None, None, None)):
                server.run(job_id, wav, xml, 60, "violin", 1)
            summary = server.jobs[job_id]["result"]["summary"]
            self.assertTrue(summary["degraded"])
            self.assertTrue(summary["degradedReasons"])
        finally:
            server.jobs.pop(job_id, None)
        # Full-sensor job payload (vamp available and used).
        job_id = "test-vamp-degraded-present"
        server.jobs[job_id] = {"id": job_id, "status": "queued", "createdAt": 0, "kind": "analysis"}
        segments = [(0.13 + i, 0.89 + i, float(m)) for i, m in enumerate((69, 71, 72, 74, 76))]
        try:
            with patch.object(server.vamp_features, "extract_all",
                               return_value=(segments, [0.12 + i for i in range(5)],
                                             [0.12 + i for i in range(6)])):
                server.run(job_id, wav, xml, 60, "violin", 1,
                           first_beat_audio_sec=None, sync_mode="vamp-beat")
            summary = server.jobs[job_id]["result"]["summary"]
            self.assertFalse(summary["degraded"])
            self.assertEqual(summary["degradedReasons"], [])
        finally:
            server.jobs.pop(job_id, None)


if __name__ == "__main__":
    unittest.main()
