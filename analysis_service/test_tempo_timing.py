import unittest

from .quality import QUALITY_VERSION, assess_quality


def result(**patch):
    return {"summary": {"pitchScore": 85, "rhythmScore": 70, "noteCount": 20,
                        "scoredPitchNotes": 18, "correctPitchNotes": 15, "voicedNotes": 18,
                        "timingCandidateNotes": 19, "timedNotes": 17,
                        "confidence": "medium", **patch},
            "measureIntervals": [{"measure": 1, "startSec": .5, "endSec": 2.0},
                                 {"measure": 2, "startSec": 2.0, "endSec": 3.5}]}


class TempoTimingTests(unittest.TestCase):
    def test_tempo_mismatch_with_collapsed_rhythm_is_partial(self):
        q = assess_quality(result(tempoMismatch=True, rhythmScore=20))
        self.assertIn("tempo_mismatch", q["issues"])
        self.assertIn("tempo_timing_unreliable", q["issues"])
        self.assertEqual(q["outcome"], "partial")
        self.assertIsNone(q["overallScore"])
        self.assertEqual(q["version"], QUALITY_VERSION)
        self.assertEqual(QUALITY_VERSION, "evidence-2")

    def test_tempo_mismatch_with_good_rhythm_stays_complete(self):
        q = assess_quality(result(tempoMismatch=True, rhythmScore=74))
        self.assertIn("tempo_mismatch", q["issues"])
        self.assertNotIn("tempo_timing_unreliable", q["issues"])
        self.assertEqual(q["outcome"], "complete")
        self.assertIsNotNone(q["overallScore"])

    def test_low_rhythm_without_tempo_mismatch_is_a_real_score(self):
        q = assess_quality(result(rhythmScore=20))
        self.assertNotIn("tempo_timing_unreliable", q["issues"])
        self.assertEqual(q["outcome"], "complete")
        self.assertIsNotNone(q["overallScore"])


if __name__ == "__main__":
    unittest.main()
