import unittest
from unittest import mock

import numpy as np

from . import engine as eng

RATE = 16000


def _entry():
    return {"pitchErrorCents": None, "crepeCents": None, "crepeOverride": False, "confidence": 0.0,
            "pitchStatus": "uncertain", "timingStatus": "correct", "matchStatus": "uncertain",
            "status": "uncertain", "rawPitchErrorCents": None, "pitchDisplaced": False,
            "displacedFromMeasure": None, "pitchMidi": 50.0}


def _fake_tracks(cents):
    def f(segs, rate):
        out = []
        for s in segs:
            t = np.arange(0, len(s) / rate, 0.01)
            out.append((t, np.full(len(t), 50.0 + cents / 100.0), np.ones(len(t))))
        return out
    return f


class CrepeFallbackTests(unittest.TestCase):
    """0.20: 无 pYIN 段兜底窗 / 无起音短音补测与主循环同 >200c 不指控规则。"""

    def run_one(self, cents, **flags):
        aligned = [_entry()]
        item = {"index": 0, "lo": 0.5, "hi": 0.8, "pitchMidi": 50.0, "kind": "gap", **flags}
        with mock.patch.object(eng, "_crepe_enabled", lambda: True), \
                mock.patch.object(eng, "_crepe_tracks", _fake_tracks(cents)):
            delta = eng._run_crepe_verdicts(aligned, [item], np.zeros(RATE * 2), RATE, 25.0)
        return aligned[0], delta

    def test_fallback_far_reading_is_not_accused(self):
        e, d = self.run_one(350.0, fallback=True, noOnsetShort=False)
        self.assertIsNone(e["pitchErrorCents"])
        self.assertEqual(d, 0)

    def test_fallback_close_reading_fills_and_marks(self):
        e, d = self.run_one(10.0, fallback=True, noOnsetShort=False)
        self.assertAlmostEqual(e["pitchErrorCents"], 10.0, delta=0.5)
        self.assertTrue(e.get("crepeFallback"))
        self.assertEqual(d, 1)

    def test_counted_gap_is_not_double_counted(self):
        e, d = self.run_one(10.0, fallback=False, noOnsetShort=True, counted=True)
        self.assertIsNotNone(e["pitchErrorCents"])
        self.assertEqual(d, 0)

    def test_regular_gap_keeps_far_reading(self):
        e, d = self.run_one(350.0, fallback=False, noOnsetShort=False)
        self.assertAlmostEqual(e["pitchErrorCents"], 350.0, delta=0.5)
        self.assertFalse(e.get("crepeFallback", False))
        self.assertEqual(d, 1)


if __name__ == "__main__":
    unittest.main()
