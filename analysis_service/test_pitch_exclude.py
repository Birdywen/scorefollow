import unittest

from .engine import PITCH_SCORE_EXCLUDE_CENTS, classify_pitch
from .quality import assess_quality


class PitchExclude019Test(unittest.TestCase):
    def test_classification_unchanged_from_018(self):
        # 0.19 只改打分, 判定口径保持 0.18 (漂移跟踪/补救/匹配率依赖它)。
        self.assertEqual(PITCH_SCORE_EXCLUDE_CENTS, 600.0)
        self.assertEqual(classify_pitch(700.0, 60.0), "sharp")
        self.assertEqual(classify_pitch(-1095.0, 50.0), "flat")
        self.assertEqual(classify_pitch(1150.0, 60.0), "octave")
        self.assertEqual(classify_pitch(1500.0, 60.0), "outlier")

    @staticmethod
    def _result(excluded):
        return {"summary": {"noteCount": 10, "voicedNotes": 10, "scoredPitchNotes": 10,
                            "correctPitchNotes": 8, "timedNotes": 9, "timingCandidateNotes": 9,
                            "pitchScore": 80, "rhythmScore": 90, "outlierNotes": 0,
                            "octaveUncertainNotes": 0, "excludedPitchNotes": excluded}}

    def test_unreliable_tracking_downgrades(self):
        q = assess_quality(self._result(2))
        self.assertIn("pitch_tracking_unreliable", q["issues"])
        self.assertIsNone(q["overallScore"])
        self.assertNotIn(q["outcome"], ("complete", "complete_with_rescue"))

    def test_below_ratio_not_flagged(self):
        q = assess_quality(self._result(1))
        self.assertNotIn("pitch_tracking_unreliable", q["issues"])
        self.assertIsNotNone(q["overallScore"])


if __name__ == "__main__":
    unittest.main()
