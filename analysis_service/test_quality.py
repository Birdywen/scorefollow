import unittest

from .quality import assess_quality


class QualityTests(unittest.TestCase):
    def result(self, **patch):
        return {"summary": {"pitchScore": 80, "rhythmScore": 70, "noteCount": 10,
                            "scoredPitchNotes": 8, "timingCandidateNotes": 9, "timedNotes": 7,
                            "confidence": "medium", **patch},
                "measureIntervals": [{"measure": 1, "startSec": .5, "endSec": 2.0},
                                     {"measure": 2, "startSec": 2.0, "endSec": 3.5}]}

    def test_real_zero_is_not_insufficient_evidence(self):
        q = assess_quality(self.result(pitchScore=0, rhythmScore=0))
        self.assertEqual(q["outcome"], "complete")
        self.assertTrue(q["followReady"])

    def test_missing_scores_do_not_become_zero(self):
        self.assertEqual(assess_quality(self.result(pitchScore=None))["outcome"], "partial")
        self.assertEqual(assess_quality(self.result(pitchScore=None, rhythmScore=None))["outcome"], "insufficient_evidence")

    def test_unverified_alignment_blocks_follow_even_with_high_scores(self):
        q = assess_quality(self.result(pitchScore=100, rhythmScore=100, syncAdvice="Review alignment"))
        self.assertEqual(q["outcome"], "partial")
        self.assertFalse(q["followReady"])
        self.assertIn("alignment_unverified", q["issues"])

    def test_rescue_and_low_coverage_are_exposed(self):
        self.assertEqual(assess_quality(self.result(autoMeasureSync=True))["outcome"], "complete_with_rescue")
        q = assess_quality(self.result(scoredPitchNotes=3, clipped=True, degraded=True))
        self.assertEqual(q["pitchCoverage"], .3)
        self.assertEqual(q["outcome"], "partial")
        self.assertIn("clipped_audio", q["issues"])

    def test_nonmonotonic_timeline_is_not_follow_ready(self):
        result = self.result()
        result["measureIntervals"][1]["startSec"] = 1.0
        self.assertFalse(assess_quality(result)["followReady"])
