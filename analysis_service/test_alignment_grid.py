import unittest

from .engine import _alignment_grid


def notes(measures, beats_per=4):
    return [{"measure": m, "onsetBeat": float(m * beats_per)} for m in measures]


def alignment(times, confident=True):
    return {"confident": confident, "quarterPeriod": 0.5,
            "measureTimes": [{"measure": m, "audioSec": t} for m, t in times]}


class AlignmentGridTest(unittest.TestCase):
    def test_grid_that_agrees_is_kept(self):
        # fixed grid: 0.5 s per beat, measure m starts at 2m s; alignment agrees within 0.1 s
        al = alignment([(0, 0.0), (1, 2.05), (2, 4.1)])
        self.assertIsNone(_alignment_grid(al, notes([0, 1, 2]), 0.0, 0.5, 0.0, None))

    def test_half_speed_grid_switches_to_measure_map(self):
        # grid runs at 1.0 s per beat; alignment says 0.5 s -> 4 s apart by measure 2
        al = alignment([(0, 0.0), (1, 2.0), (2, 4.0)])
        f = _alignment_grid(al, notes([0, 1, 2]), 0.0, 1.0, 0.0, None)
        self.assertIsNotNone(f)
        self.assertAlmostEqual(f(4.0), 2.0)
        self.assertAlmostEqual(f(6.0), 3.0)   # inside a measure: linear between measure starts
        self.assertAlmostEqual(f(10.0), 5.0)  # past the last anchor: alignment tempo

    def test_unconfident_alignment_never_switches(self):
        al = alignment([(0, 0.0), (1, 2.0), (2, 4.0)], confident=False)
        self.assertIsNone(_alignment_grid(al, notes([0, 1, 2]), 0.0, 1.0, 0.0, None))

    def test_live_grid_is_compared_relative_to_base_beat(self):
        al = alignment([(1, 10.0), (2, 12.0)])
        live = lambda rel: 10.0 + rel * 0.5  # noqa: E731 - beat grid anchored at measure 1
        self.assertIsNone(_alignment_grid(al, notes([1, 2]), 4.0, 0.5, 0.0, live))


if __name__ == "__main__":
    unittest.main()
