"""补救失败可诊断：每个移调尝试的真实结果进 summary.rescueAttempts（给用户的文案不变）。"""
import unittest

from .engine import OCTAVE_SEARCH_SHIFTS, analyze
from .test_auto_rescue import PITCHES
from .test_engine import legato_recording, legato_score

REASONS = {"error", "boundary_unsupported", "unusable", "usable"}


class RescueAttemptsTests(unittest.TestCase):
    def test_failed_rescue_keeps_every_shift_reason(self):
        xml = legato_score(PITCHES)
        take = legato_recording([40, 41, 42, 43, 44, 45] * 3, 0.5)
        summary = analyze(take, xml, 120, "violin", start_measure=1)["summary"]
        self.assertFalse(summary["autoMeasureSync"])
        self.assertIn("手动小节同步", summary["syncAdvice"])
        attempts = summary.get("rescueAttempts")
        self.assertIsInstance(attempts, list)
        self.assertEqual([a["shift"] for a in attempts], list(OCTAVE_SEARCH_SHIFTS))
        for a in attempts:
            self.assertIn(a["reason"], REASONS)
            if a["reason"] == "error":
                self.assertTrue(a.get("detail"))

    def test_good_take_never_enters_rescue(self):
        summary = analyze(legato_recording(PITCHES, 0.5), legato_score(PITCHES),
                          120, "violin", start_measure=1)["summary"]
        self.assertNotIn("rescueAttempts", summary)


if __name__ == "__main__":
    unittest.main()
