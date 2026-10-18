import math
import unittest

import numpy as np

from .chord_pitch import BP_FPS, buried, chord_cents, measure_chord, sounding_run
from .engine import _pitch_items, _score_chord_tones

RATE = 22050


def tone(midi, cents, sec, rate=RATE, partials=10, vib=4.0, seed=0):
    """String-like tone: 1/k partial amplitudes, 5.5 Hz vibrato of +-vib cents."""
    t = np.arange(int(sec * rate)) / rate
    f0 = 440 * 2 ** ((midi + cents / 100 - 69) / 12)
    dev = 2 ** (vib / 1200 * np.sin(2 * math.pi * 5.5 * t))
    phase = 2 * math.pi * np.cumsum(f0 * dev) / rate
    rng = np.random.default_rng(seed)
    return sum(np.sin(k * phase + rng.uniform(0, 6)) / k for k in range(1, partials + 1) if k * f0 < rate / 2)


def mix(parts, sec, seed=1):
    x = sum(tone(m, c, sec, seed=i) for i, (m, c) in enumerate(parts))
    return (x / np.abs(x).max() * 0.5 + np.random.default_rng(seed).normal(0, 0.003, len(x))).astype(np.float32)


def activation(spans, sec):
    """Fake Basic Pitch activation: {midi: (lo, hi)} sounding spans."""
    act = np.zeros((int(sec * BP_FPS) + 1, 88), np.float32)
    for m, (lo, hi) in spans.items():
        act[int(lo * BP_FPS):int(hi * BP_FPS), m - 21] = 0.8
    return act


class ChordCentsTests(unittest.TestCase):
    def test_dyads_recover_each_tone(self):
        for low, high in ((48, 55), (50, 59), (43, 52), (45, 61), (55, 59)):
            x = mix([(low, -8), (high, 12)], 1.2)
            got = chord_cents(x, RATE, [low, high], 0.2, 1.1)
            self.assertAlmostEqual(got[low], -8, delta=3, msg=(low, high))
            self.assertAlmostEqual(got[high], 12, delta=3, msg=(low, high))

    def test_triad(self):
        x = mix([(43, 5), (53, -10), (59, 15)], 1.4)
        got = chord_cents(x, RATE, [43, 53, 59], 0.2, 1.3)
        for m, c in ((43, 5), (53, -10), (59, 15)):
            self.assertAlmostEqual(got[m], c, delta=4, msg=m)

    def test_octave_above_a_chord_tone_is_not_guessed(self):
        self.assertTrue(buried(60, [48, 52, 60]))
        self.assertFalse(buried(52, [48, 52, 60]))
        x = mix([(48, 0), (52, 0), (60, 20)], 1.2)
        self.assertIsNone(chord_cents(x, RATE, [48, 52, 60], 0.2, 1.1)[60])


class MeasureChordTests(unittest.TestCase):
    def test_states_follow_activation(self):
        sec = 3.0
        x = np.concatenate([np.zeros(int(1.0 * RATE), np.float32), mix([(48, 6), (55, -4)], 2.0)])
        states = measure_chord(x, RATE, activation({48: (1.0, 1.4), 55: (1.0, 2.9)}, sec), [48, 55, 64], 1.0, 2.9)
        by = {t["midi"]: t for t in states}
        self.assertEqual(by[64]["state"], "missing")          # written, not played
        self.assertEqual(by[48]["state"], "measured")         # short rolled bass still measured
        self.assertEqual(by[55]["state"], "measured")
        self.assertAlmostEqual(by[55]["cents"], -4, delta=3)

    def test_chord_cut_by_recording_start_is_unchecked(self):
        x = mix([(55, 0), (62, 0)], 1.5)
        states = measure_chord(x, RATE, activation({62: (0.0, 1.5)}, 1.5), [55, 62], 0.1, 1.4)
        self.assertEqual({t["midi"]: t["state"] for t in states}, {55: "unchecked", 62: "measured"})

    def test_sounding_run_picks_longest(self):
        act = activation({60: (0.5, 0.7)}, 3.0)
        act[int(1.0 * BP_FPS):int(2.0 * BP_FPS), 60 - 21] = 0.5
        lo, hi = sounding_run(act, 60, 0.0, 3.0)
        self.assertAlmostEqual(lo, 1.0, delta=0.02)
        self.assertAlmostEqual(hi, 2.0, delta=0.02)


class EngineChordScoringTests(unittest.TestCase):
    def note(self, **kw):
        base = {"pitchMidi": 48, "performedSec": 1.0, "expectedSec": 1.0, "expectedEndSec": 2.9,
                "timingStatus": "correct", "pitchErrorCents": None, "pitchStatus": "uncertain"}
        return {**base, **kw}

    def test_chord_tones_scored_individually(self):
        x = np.concatenate([np.zeros(RATE, np.float32), mix([(48, 6), (55, -40)], 2.0)])
        aligned = [self.note(chordMidi=[48, 55, 64])]
        _score_chord_tones(aligned, x, RATE, activation({48: (1.0, 2.9), 55: (1.0, 2.9)}, 3.0), 25.0)
        n = aligned[0]
        self.assertEqual(n["pitchStatus"], "flat")             # worst measured tone drives the note
        self.assertAlmostEqual(n["pitchErrorCents"], -40, delta=4)
        self.assertEqual(n["status"], "wrong_pitch")
        self.assertEqual([t["state"] for t in n["chordTones"]], ["measured", "measured", "missing"])
        n["pitchWeight"] = 1.0
        items = _pitch_items(aligned + [{"pitchWeight": 1.0, "pitchStatus": "correct", "pitchErrorCents": -3.0}])
        self.assertEqual(len(items), 3)                        # two chord tones + one single note

    def test_without_activation_nothing_changes(self):
        aligned = [self.note(chordMidi=[48, 55], pitchErrorCents=5.0, pitchStatus="correct")]
        _score_chord_tones(aligned, np.zeros(RATE * 3, np.float32), RATE, None, 25.0)
        self.assertEqual(aligned[0]["pitchErrorCents"], 5.0)
        self.assertNotIn("chordTones", aligned[0])


if __name__ == "__main__":
    unittest.main()
