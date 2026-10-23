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
        self.assertEqual(QUALITY_VERSION, "evidence-5")

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

    def test_played_repeats_can_be_followed(self):
        rep = result(repeatsUnfolded=True)
        rep["measureIntervals"] = [{"measure": m, "startSec": .5 + i, "endSec": 1.5 + i}
                                   for i, m in enumerate([1, 2, 1, 2])]
        self.assertTrue(assess_quality(rep)["followReady"])
        # Without a repeat in the score, a measure going back is still a broken timeline.
        rep["summary"]["repeatsUnfolded"] = False
        self.assertFalse(assess_quality(rep)["followReady"])
        # Time must still move forward.
        rep["summary"]["repeatsUnfolded"] = True
        rep["measureIntervals"][2]["startSec"] = 1.0
        self.assertFalse(assess_quality(rep)["followReady"])


if __name__ == "__main__":
    unittest.main()
