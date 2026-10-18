import unittest

import numpy as np

from .engine import attribute_outlier, pitch_weight, _assign_pitch_weights


class OutlierAttributionTest(unittest.TestCase):
    def test_small_error_not_suspect(self):
        self.assertIsNone(attribute_outlier(120.0, 60.0, 59.0, None))
        self.assertEqual(pitch_weight(120.0), 1.0)

    def test_mixed_window_recovers_target_cluster(self):
        frames = np.array([62.0, 62.0, 60.02, 60.0, 59.98, 60.01])
        a = attribute_outlier(200.0, 62.0, 60.0, frames)
        self.assertEqual(a["cause"], "mixed-window")
        self.assertAlmostEqual(a["recovered"][1], 0.0, delta=3)

    def test_carryover_and_anticipation_downweighted(self):
        frames = np.array([65.0, 65.0, 65.0, 62.5, 63.0, 61.5])
        a = attribute_outlier(500.0, 65.0, 60.0, frames, prev_midi=65.0, next_midi=67.0)
        self.assertEqual(a["cause"], "carryover-prev")
        self.assertEqual(pitch_weight(500.0, a["cause"], a["stability"], 1.0), 0.25)
        b = attribute_outlier(700.0, 67.0, 60.0, np.array([67.0, 67.0, 67.0, 64.0, 64.5, 63.8]),
                              prev_midi=62.0, next_midi=67.0)
        self.assertEqual(b["cause"], "anticipation-next")

    def test_stable_neighbor_pitch_is_wrong_note_not_carryover(self):
        a = attribute_outlier(500.0, 65.0, 60.0, np.full(6, 65.0), prev_midi=65.0)
        self.assertIsNone(a["cause"])
        self.assertEqual(pitch_weight(500.0, a["cause"], a["stability"], 1.0), 1.0)

    def test_open_string_ring(self):
        a = attribute_outlier(-500.0, 50.0, 55.0, np.array([50.0, 50.0, 50.0, 53.0, 52.5, 53.5]),
                              prev_midi=57.0, next_midi=57.0)
        self.assertEqual(a["cause"], "open-string-ring")
        self.assertEqual(pitch_weight(-500.0, a["cause"]), 0.5)

    def test_stable_confident_unexplained_is_real_wrong_note(self):
        a = attribute_outlier(400.0, 64.0, 60.0, np.full(8, 64.0), prev_midi=62.0, next_midi=62.0)
        self.assertIsNone(a["cause"])
        self.assertEqual(pitch_weight(400.0, None, a["stability"], 0.95), 1.0)

    def test_unstable_unexplained_decays_with_floor(self):
        self.assertEqual(pitch_weight(375.0, None, 0.3, 0.8), 0.5)
        self.assertEqual(pitch_weight(590.0, None, 0.3, 0.8), 0.3)
        self.assertEqual(pitch_weight(650.0, None, 0.3, 0.8), 0.0)

    def test_assign_marks_excluded_only_at_zero(self):
        notes = [{"pitchStatus": "sharp", "pitchErrorCents": 700.0, "confidence": 1.0},
                 {"pitchStatus": "sharp", "pitchErrorCents": 300.0, "confidence": 0.8,
                  "windowStability": 0.2},
                 {"pitchStatus": "uncertain", "pitchErrorCents": None}]
        _assign_pitch_weights(notes)
        self.assertTrue(notes[0]["pitchExcluded"])
        self.assertNotIn("pitchExcluded", notes[1])
        self.assertEqual(notes[1]["pitchWeight"], 0.67)
        self.assertNotIn("pitchWeight", notes[2])


if __name__ == "__main__":
    unittest.main()
