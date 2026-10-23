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

    def test_rescued_excerpt_is_partial_even_with_high_scores(self):
        q = assess_quality(self.result(pitchScore=100, rhythmScore=100,
                                       autoMeasureSync=True, rescueReasons=["range"]))
        self.assertEqual(q["outcome"], "partial")
        self.assertTrue(q["followReady"])


class TakeBeyondScoreQualityTests(unittest.TestCase):
    def test_trimmed_tail_is_reported_and_stays_partial(self):
        from .quality import assess_quality
        summary = {"noteCount": 10, "scoredPitchNotes": 9, "timedNotes": 9, "timingCandidateNotes": 9,
                   "pitchScore": 95, "rhythmScore": 85, "confidence": "medium",
                   "autoMeasureSync": True, "rescueReasons": ["range"],
                   "takeBeyondScoreAfterSec": 71.9}
        quality = assess_quality({"summary": summary, "measureIntervals": []})
        self.assertIn("take_beyond_score", quality["issues"])
        self.assertEqual(quality["outcome"], "partial")

    def test_absent_field_adds_no_issue(self):
        from .quality import assess_quality
        summary = {"noteCount": 10, "scoredPitchNotes": 9, "pitchScore": 95, "rhythmScore": 85}
        self.assertNotIn("take_beyond_score", assess_quality({"summary": summary})["issues"])


class OverallScoreTests(unittest.TestCase):
    def q(self, **patch):
        s = {"noteCount": 10, "scoredPitchNotes": 9, "timedNotes": 9, "timingCandidateNotes": 9,
             "pitchScore": 95, "rhythmScore": 82, "confidence": "medium"}
        s.update(patch)
        return assess_quality({"summary": s, "measureIntervals": []})

    def test_both_scores_give_weighted_overall(self):
        q = self.q()
        self.assertEqual(q["overallScore"], 89)
        self.assertEqual(q["overallWeights"], {"pitch": .5, "rhythm": .5})

    def test_take_beyond_score_prefix_still_has_overall(self):
        q = self.q(takeBeyondScoreAfterSec=72.3, autoMeasureSync=True, rescueReasons=["range"])
        self.assertEqual(q["overallScore"], 89)

    def test_missing_component_is_not_computed(self):
        self.assertIsNone(self.q(pitchScore=None)["overallScore"])
        self.assertIsNone(self.q(rhythmScore=None)["overallScore"])

    def test_unverified_alignment_is_not_computed(self):
        self.assertIsNone(self.q(syncAdvice="Review alignment")["overallScore"])

    def test_low_coverage_is_not_computed(self):
        self.assertIsNone(self.q(scoredPitchNotes=3)["overallScore"])

    def test_zero_scores_are_real(self):
        self.assertEqual(self.q(pitchScore=0, rhythmScore=0)["overallScore"], 0)


class ReferenceOverallTests(unittest.TestCase):
    """evidence-4: borderline coverage still gets an overall score, marked for reference."""
    def q(self, **patch):
        s = {"noteCount": 630, "voicedNotes": 503, "scoredPitchNotes": 500, "timedNotes": 600,
             "timingCandidateNotes": 629, "pitchScore": 90, "rhythmScore": 94, "correctPitchNotes": 440,
             "confidence": "low"}
        s.update(patch)
        return assess_quality({"summary": s, "measureIntervals": []})

    def test_borderline_low_coverage_gets_reference_overall(self):
        q = self.q()
        self.assertIn("low_coverage", q["issues"])
        self.assertEqual(q["overallScore"], 92)
        self.assertEqual(q["overallReliability"], "reference")
        self.assertEqual(q["unheardRatio"], round(1 - 503 / 630, 3))
        self.assertEqual(q["outcome"], "partial")

    def test_full_coverage_is_full(self):
        q = self.q(voicedNotes=600, scoredPitchNotes=598, confidence="medium")
        self.assertEqual(q["overallReliability"], "full")

    def test_too_little_heard_stays_uncomputed(self):
        q = self.q(voicedNotes=360, scoredPitchNotes=355)
        self.assertIsNone(q["overallScore"])
        self.assertIsNone(q["overallReliability"])

    def test_other_blockers_still_block(self):
        self.assertIsNone(self.q(syncAdvice="Review alignment")["overallScore"])
        self.assertIsNone(self.q(outlierNotes=120)["overallScore"])


class MismatchTests(unittest.TestCase):
    def q(self, **patch):
        s = {"noteCount": 46, "scoredPitchNotes": 37, "timedNotes": 38, "timingCandidateNotes": 45,
             "pitchScore": 0, "rhythmScore": 38, "correctPitchNotes": 4, "confidence": "medium",
             "syncAdvice": "alignment failed"}
        s.update(patch)
        return assess_quality({"summary": s, "measureIntervals": []})

    def test_unrelated_take_is_mismatch_not_zero(self):
        q = self.q()
        self.assertEqual(q["outcome"], "score_audio_mismatch")
        self.assertIn("score_audio_mismatch", q["issues"])
        self.assertIsNone(q["overallScore"])
        self.assertFalse(q["followReady"])
        self.assertEqual(q["pitchMatchRate"], round(4 / 37, 3))

    def test_wrong_score_without_advice_is_mismatch(self):
        q = self.q(noteCount=400, scoredPitchNotes=255, timedNotes=300, timingCandidateNotes=390,
                   pitchScore=None, rhythmScore=88, correctPitchNotes=47, syncAdvice=None)
        self.assertEqual(q["outcome"], "score_audio_mismatch")

    def test_rescued_poor_player_is_scored(self):
        q = self.q(noteCount=120, scoredPitchNotes=103, timedNotes=110, timingCandidateNotes=119,
                   pitchScore=67, rhythmScore=90, correctPitchNotes=74, syncAdvice=None, autoMeasureSync=True)
        self.assertNotEqual(q["outcome"], "score_audio_mismatch")

    def test_verified_timeline_with_many_wrong_notes_is_scored(self):
        q = self.q(noteCount=45, scoredPitchNotes=40, timedNotes=42, timingCandidateNotes=44,
                   pitchScore=30, rhythmScore=70, correctPitchNotes=10, syncAdvice=None)
        self.assertEqual(q["outcome"], "complete")
        self.assertEqual(q["overallScore"], 50)

    def test_too_few_notes_is_not_judged(self):
        q = self.q(noteCount=9, scoredPitchNotes=8, timedNotes=8, timingCandidateNotes=8, correctPitchNotes=1)
        self.assertEqual(q["outcome"], "partial")
        self.assertIsNone(q["pitchMatchRate"])

    def test_old_report_without_counts_is_not_judged(self):
        q = assess_quality({"summary": {"noteCount": 10, "scoredPitchNotes": 9, "timedNotes": 9,
                                        "pitchScore": 0, "rhythmScore": 0, "confidence": "medium"},
                            "measureIntervals": []})
        self.assertNotEqual(q["outcome"], "score_audio_mismatch")
