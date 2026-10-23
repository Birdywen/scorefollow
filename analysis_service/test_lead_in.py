"""string-mono-0.30: 跳过开头调音 (Dotzauer No.03/No.17 s0 整段录音)."""
import unittest

from .engine import detect_lead_in

OPENING = [55, 54, 52, 50, 55, 54, 52, 50, 62, 59, 57, 55, 55, 54, 52, 50]
NOTES = [{"measure": 1 + i // 8, "pitchMidi": float(p)} for i, p in enumerate(OPENING)]


def _play(t0, pitches, step=0.25):
    return [(t0 + i * step, t0 + (i + 1) * step - 0.02, float(p)) for i, p in enumerate(pitches)]


TUNING = [(0.1, 1.8, 38.0), (2.5, 3.9, 38.0), (4.3, 5.8, 42.0), (6.5, 7.3, 38.0), (9.4, 12.6, 43.0),
          (13.0, 14.5, 57.0), (15.0, 16.2, 50.0)]


class LeadInTest(unittest.TestCase):
    def test_tuning_lead_in_is_skipped(self):
        start = detect_lead_in(TUNING + _play(18.2, OPENING), NOTES)
        self.assertAlmostEqual(start, 18.2, places=2)

    def test_clean_start_is_kept(self):
        self.assertIsNone(detect_lead_in(_play(1.0, OPENING), NOTES))

    def test_short_squeak_is_kept(self):
        squeak = [(1.0, 1.2, 84.0), (1.3, 1.5, 83.0)]
        self.assertIsNone(detect_lead_in(squeak + _play(2.0, OPENING), NOTES))

    def test_unrelated_audio_is_kept(self):
        self.assertIsNone(detect_lead_in(_play(1.0, [70, 72, 74, 76] * 6), NOTES))


if __name__ == "__main__":
    unittest.main()
