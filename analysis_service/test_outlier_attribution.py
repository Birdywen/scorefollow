import math
import unittest

import numpy as np

from .engine import verify_target, pitch_weight, _assign_pitch_weights

RATE = 22050


def tone(*midis, sec=0.4, odd_only=False, amps=(1.0, 0.7, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15)):
    """Harmonic tone(s), 8 partials each; a little noise so the floor is realistic."""
    t = np.arange(int(sec * RATE)) / RATE
    x = np.zeros_like(t)
    for m in midis:
        f = 440 * 2 ** ((m - 69) / 12)
        for k, a in enumerate(amps, start=1):
            if f * k < RATE / 2 and not (odd_only and k % 2 == 0):
                x += a * np.sin(2 * math.pi * f * k * t)
    rng = np.random.default_rng(0)
    return (0.2 * x / np.max(np.abs(x)) + 1e-4 * rng.standard_normal(len(t))).astype(np.float32)


def check(sig, target, detected):
    return verify_target(sig, RATE, 0.0, len(sig) / RATE, target, detected)


class VerifyTargetTest(unittest.TestCase):
    def test_tracker_picked_octave_harmonic(self):
        v = check(tone(48), 48, 60)  # played C3, tracker read C4
        self.assertEqual(v["check"], "confirmed")
        self.assertAlmostEqual(v["recovered"][1], 0.0, delta=5)

    def test_tracker_picked_twelfth(self):
        v = check(tone(50), 50, 69)  # 3rd partial of D3
        self.assertEqual(v["check"], "confirmed")

    def test_tracker_subharmonic(self):
        v = check(tone(57), 57, 45)
        self.assertEqual(v["check"], "confirmed")

    def test_really_played_octave_high(self):
        self.assertEqual(check(tone(60), 48, 60)["check"], "wrong-note")

    def test_really_played_octave_low(self):
        self.assertEqual(check(tone(45), 57, 45)["check"], "wrong-note")

    def test_really_played_wrong_note(self):
        v = check(tone(64), 60, 64)
        self.assertEqual(v["check"], "wrong-note")
        self.assertIsNone(v["recovered"])

    def test_caught_string_keeps_target_intonation(self):
        sig = tone(55.2, 50)  # target G3 played 20c sharp, open D rings
        v = check(sig, 55, 50)
        self.assertEqual(v["check"], "two-series")
        self.assertAlmostEqual(v["recovered"][1], 20.0, delta=6)

    def test_faint_target_residual_is_wrong_note(self):
        t = tone(60)
        sig = t + 0.03 * tone(55)  # wrong note E4-ish played, faint target G3 reverb
        v = check(sig.astype(np.float32), 55, 60)
        self.assertEqual(v["check"], "wrong-note")
        self.assertLess(v["margin"], -10)

    def test_twelfth_beyond_six_partials_still_shared(self):
        v = check(tone(48), 48, 67)  # tracker on 3rd partial; its 4th-6th exceed target's 6
        self.assertEqual(v["check"], "confirmed")

    def test_noise_is_unclear(self):
        sig = (0.05 * np.random.default_rng(1).standard_normal(int(0.4 * RATE))).astype(np.float32)
        self.assertEqual(check(sig, 60, 66)["check"], "unclear")

    def test_short_window_skipped(self):
        self.assertIsNone(verify_target(tone(60), RATE, 0.0, 0.03, 60, 64))


class PitchWeightTest(unittest.TestCase):
    def test_weights(self):
        self.assertEqual(pitch_weight(120.0), 1.0)
        self.assertEqual(pitch_weight(400.0, "wrong-note"), 1.0)
        self.assertEqual(pitch_weight(375.0, "unclear"), 0.5)
        self.assertEqual(pitch_weight(590.0), 0.3)
        self.assertEqual(pitch_weight(650.0, "wrong-note"), 0.0)

    def test_assign_marks_excluded_only_at_zero(self):
        notes = [{"pitchStatus": "sharp", "pitchErrorCents": 700.0},
                 {"pitchStatus": "sharp", "pitchErrorCents": 300.0, "targetCheck": "unclear"},
                 {"pitchStatus": "uncertain", "pitchErrorCents": None}]
        _assign_pitch_weights(notes)
        self.assertTrue(notes[0]["pitchExcluded"])
        self.assertNotIn("pitchExcluded", notes[1])
        self.assertEqual(notes[1]["pitchWeight"], 0.67)
        self.assertNotIn("pitchWeight", notes[2])


if __name__ == "__main__":
    unittest.main()
