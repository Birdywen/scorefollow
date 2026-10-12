"""Measure time map must follow tempo drift (rubato), not one global line."""
import math
import unittest

from . import alignment as A
from .alignment import align_excerpt
from .engine import parse_score
from .test_excerpt_alignment import melody, xml_for


def rubato_segments(pitches, start=0.3, amp=0.08):
    """One quarter per measure; period drifts 0.52..0.68 s like a real take."""
    t, segs, onsets = start, [], []
    for i, m in enumerate(pitches):
        period = 0.6 + amp * math.sin(i / 5.0)
        onsets.append(t)
        segs.append((round(t, 4), round(t + 0.7 * period, 4), float(m)))
        t += period
    return segs, onsets


class RubatoMeasureMapTests(unittest.TestCase):
    def test_measure_times_follow_tempo_drift(self):
        pitches = melody(40)
        notes = parse_score(xml_for(pitches))
        segs, onsets = rubato_segments(pitches[8:32])
        result = align_excerpt(notes, segs)
        self.assertEqual(result["start"], 8)
        self.assertTrue(result["confident"])
        truth = {9 + i: t for i, t in enumerate(onsets)}
        worst = max(abs(m["audioSec"] - truth[m["measure"]]) for m in result["measureTimes"])
        self.assertLess(worst, 0.05, f"worst measure error {worst:.3f}s")

    def test_anchor_time_interpolates_and_extrapolates(self):
        anchors = [[0.0, 1.0], [1.0, 1.5], [2.0, 2.5]]
        self.assertAlmostEqual(A.anchor_time(anchors, 0.5, 0.6), 1.25)
        self.assertAlmostEqual(A.anchor_time(anchors, 1.5, 0.6), 2.0)
        self.assertAlmostEqual(A.anchor_time(anchors, 3.0, 0.6), 3.1)
        self.assertAlmostEqual(A.anchor_time(anchors, -1.0, 0.6), 0.4)
        self.assertIsNone(A.anchor_time([], 1.0, 0.6))


if __name__ == "__main__":
    unittest.main()
