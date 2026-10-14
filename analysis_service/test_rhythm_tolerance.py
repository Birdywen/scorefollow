import unittest

from analysis_service import engine as E


class RhythmToleranceTests(unittest.TestCase):
    """string-mono-0.18: onset detection error and first-onset anchoring are not the player's fault."""

    def test_detector_floor_and_offset_tolerance_are_free(self):
        self.assertEqual(E._rhythm_scores(15, 30), (100, 100))
        self.assertEqual(E._rhythm_scores(0, -30), (100, 100))

    def test_median_corpus_take_scores_high(self):
        self.assertGreaterEqual(E._rhythm_scores(23, 24)[1], 95)

    def test_real_timing_problems_still_score_low(self):
        self.assertLessEqual(E._rhythm_scores(87, -188)[1], 25)
        self.assertLessEqual(E._rhythm_scores(60, 101)[1], 60)

    def test_scores_fall_monotonically_beyond_tolerance(self):
        self.assertGreater(E._rhythm_scores(30, 0)[1], E._rhythm_scores(40, 0)[1])
        self.assertGreater(E._rhythm_scores(20, 40)[1], E._rhythm_scores(20, 60)[1])
        self.assertGreater(E._rhythm_scores(30, 0)[0], E._rhythm_scores(40, 0)[0])


if __name__ == '__main__':
    unittest.main()
