"""string-mono-0.29: 网格局部微调 (Dotzauer No.20) 与弦乐前置高通 (No.23 s1)."""
import unittest

import numpy as np

from .engine import _local_grid_refine, string_highpass

SPN = 0.12  # 每音 0.12 s, 每小节 8 音
PATTERN = [55, 54, 55, 54, 55, 57, 59, 60]


def _notes(measures):
    out = []
    for m in range(measures):
        for k, p in enumerate(PATTERN):
            i = m * 8 + k
            out.append({"measure": m + 1, "onsetBeat": i * 0.25, "pitchMidi": float(p),
                        "expectedSec": 1 + i * SPN, "expectedEndSec": 1 + (i + 1) * SPN})
    return out


def _track(notes, lag):
    times = np.arange(0, 1 + len(notes) * SPN + 2, 0.012)
    pitches = np.full(len(times), np.nan)
    for n in notes:
        d = lag(n["measure"])
        k = (times >= n["expectedSec"] + d) & (times < n["expectedEndSec"] + d)
        pitches[k] = n["pitchMidi"]
    return times, pitches


class LocalRefineTests(unittest.TestCase):
    def test_late_half_is_shifted(self):
        notes = _notes(16)
        lag = lambda m: 0.0 if m <= 8 else 0.36  # 第 9 小节起演奏晚 3 个音
        times, pitches = _track(notes, lag)
        bounds = {m + 1: m * 2.0 for m in range(17)}
        markers = _local_grid_refine(notes, bounds, times, pitches, float(times[-1]))
        self.assertEqual([m["measure"] for m in markers], list(range(1, 18)))
        self.assertAlmostEqual(markers[2]["audioSec"], 1 + 2 * 8 * SPN, delta=0.035)
        self.assertAlmostEqual(markers[12]["audioSec"], 1 + 12 * 8 * SPN + 0.36, delta=0.035)

    def test_steady_grid_returns_nothing(self):
        notes = _notes(12)
        times, pitches = _track(notes, lambda m: 0.0)
        bounds = {m + 1: m * 2.0 for m in range(13)}
        self.assertEqual(_local_grid_refine(notes, bounds, times, pitches, float(times[-1])), [])

    def test_highpass_removes_rumble_keeps_c2(self):
        rate = 22050
        t = np.arange(rate * 2) / rate
        rumble, c2 = np.sin(2 * np.pi * 25 * t), np.sin(2 * np.pi * 65.4 * t)
        rms = lambda x: float(np.sqrt(np.mean(x[rate // 2:-rate // 2] ** 2)))
        self.assertLess(rms(string_highpass(rumble.astype(np.float32), rate)), 0.2 * rms(rumble))
        self.assertGreater(rms(string_highpass(c2.astype(np.float32), rate)), 0.7 * rms(c2))


if __name__ == "__main__":
    unittest.main()
