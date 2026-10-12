"""Broadband noise before the first note must not become the first onset.

The excerpt timeline is anchored on onsets[0]. If unpitched hiss (room noise,
bow preparation) counts as the start, every expected time shifts early and
notes are compared against their neighbours.
"""
import io
import math
import unittest
import wave

import numpy as np

from .engine import analyze
from .test_engine import score


def noisy_recording(pitches=(69, 71, 72, 74, 76), lead=0.62, noise=0.03, seed=0):
    rate = 22050
    audio = np.zeros(int((len(pitches) + lead + 0.25) * rate), dtype=np.float32)
    for index, midi in enumerate(pitches):
        start = int((lead + index) * rate)
        length = int(.78 * rate)
        t = np.arange(length) / rate
        hz = 440 * 2 ** ((midi - 69) / 12)
        envelope = np.minimum(1, t * 60) * np.minimum(1, (length / rate - t) * 30)
        audio[start:start + length] += 0.32 * envelope * np.sin(2 * math.pi * hz * t)
    audio += np.random.default_rng(seed).normal(0, noise, len(audio)).astype(np.float32)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return output.getvalue()


class NoiseLeadInTest(unittest.TestCase):
    def test_noise_before_first_note_is_not_the_start(self):
        for seed in (0, 1, 2):
            with self.subTest(seed=seed):
                result = analyze(noisy_recording(seed=seed), score(), 60, "violin")
                notes = result["notes"]
                first = notes[0]["performedSec"]
                self.assertIsNotNone(first)
                self.assertLess(abs(first - 0.62), 0.08, first)
                statuses = [n["status"] for n in notes]
                self.assertEqual(statuses.count("wrong_pitch"), 0, statuses)
                self.assertGreaterEqual(result["summary"]["pitchScore"], 95)


if __name__ == "__main__":
    unittest.main()
