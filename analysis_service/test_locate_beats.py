"""Beats-for-locate tests (0.23): pure-python, no audio, no vamp needed.

The coarse panel-tempo gate drops the beat grid before locate, but beat
positions are tempo-unit-agnostic: with beats, locate_excerpt must resolve
to the true (second) occurrence of a repeated phrase; without beats the
same input stays fail-closed ambiguous. Mirrors no16 fast (panel 112
fallback vs a ~146 take: beat-less locate m6, beat-assisted locate m8).
"""
import unittest

from analysis_service.alignment import locate_excerpt

# Same 8 pitches twice: even quarters at beats 0-7, dotted rhythm later.
# Beat positions are relative, so identical rhythms stay tied; the dotted
# copy is what beat timing can tell apart.
_P = [55, 57, 59, 57, 60, 62, 64, 65]
SCORE = [{"onsetBeat": float(b), "durationBeat": 1.0, "pitchMidi": p}
         for b, p in (list(zip(range(8), _P))
                       + list(zip([20, 21.5, 22, 23.5, 24, 25.5, 26, 27.5], _P)))]

# Audio events sing the SECOND copy on a 0.5 s beat grid from 10 s.
_T = [10.0, 10.75, 11.0, 11.75, 12.0, 12.75, 13.0, 13.75]
EVENTS = [(t, t + 0.2, float(m)) for t, m in zip(_T, _P)]
BEATS = [round(10.0 + i * 0.5, 3) for i in range(12)]


class LocateBeatsTests(unittest.TestCase):
    def test_beats_resolve_repeat_to_true_copy(self):
        index, _cost = locate_excerpt(SCORE, EVENTS, beat_map=BEATS)
        self.assertEqual(index, 8)

    def test_beatless_repeat_stays_fail_closed(self):
        with self.assertRaises(ValueError):
            locate_excerpt(SCORE, EVENTS)

    def test_garbage_beats_degrade_to_beatless(self):
        # All-equal beats (med 0) must not move the needle vs no beats;
        # either both raise or both agree.
        try:
            plain = locate_excerpt(SCORE, EVENTS)
        except ValueError:
            plain = None
        try:
            garbage = locate_excerpt(SCORE, EVENTS, beat_map=[5.0] * 8)
        except ValueError:
            garbage = None
        self.assertEqual(
            None if plain is None else plain[0],
            None if garbage is None else garbage[0])


if __name__ == "__main__":
    unittest.main()
