"""Grid-phase voter tests: pure-python, no audio, no vamp needed.

Geometry mirrors the Dotzauer case: eighth-note score figures over
quarter-pulse QM beats (beat_quarters=1.0, med=quarter).
"""
import unittest

import numpy as np

from analysis_service.engine import _select_grid_phase

HEAD = [45, 48, 52, 57, 60, 57, 52, 57, 52, 48, 52, 48]


def _notes(pitches, onset_step=0.5, dur=0.5):
    return [{"onsetBeat": i * onset_step, "durationBeat": dur, "pitchMidi": p}
            for i, p in enumerate(pitches)]


def _segs(starts, midis, length=0.19):
    return [(s, s + length, m) for s, m in zip(starts, midis)]


class GridPhaseTest(unittest.TestCase):
    def test_half_pulse_offbeat_start(self):
        # quarter pulses on-beat, true eighths start a half-pulse late
        med = 0.5
        beats = np.arange(0.0, 10.0, med)
        pitches = HEAD
        starts = [0.25 + i * 0.25 + 0.03 for i in range(len(pitches))]
        notes = _notes(pitches)
        got = _select_grid_phase(beats, med, 0, notes, 0.0,
                                 _segs(starts, pitches), 1.0)
        self.assertEqual(got, 0.5)

    def test_full_pulse_missed_leading_beat(self):
        # QM missed the downbeat: pulses start one pulse late
        med = 0.5
        beats = np.arange(0.5, 10.0, med)
        pitches = HEAD[:10]
        starts = [i * 0.25 + 0.03 for i in range(len(pitches))]
        notes = _notes(pitches)
        got = _select_grid_phase(beats, med, 0, notes, 0.0,
                                 _segs(starts, pitches), 1.0)
        self.assertEqual(got, -1.0)

    def test_correct_phase_stays(self):
        med = 0.5
        beats = np.arange(0.0, 10.0, med)
        pitches = HEAD
        starts = [i * 0.25 + 0.03 for i in range(len(pitches))]
        notes = _notes(pitches)
        got = _select_grid_phase(beats, med, 0, notes, 0.0,
                                 _segs(starts, pitches), 1.0)
        self.assertEqual(got, 0.0)

    def test_abstain_short(self):
        med = 0.5
        beats = np.arange(0.0, 10.0, med)
        notes = _notes([60, 62, 64])
        segs = _segs([0.25, 0.5, 0.75], [60, 62, 64])
        self.assertEqual(
            _select_grid_phase(beats, med, 0, notes, 0.0, segs, 1.0), 0.0)

    def test_abstain_garbage_pitch(self):
        # performer plays tritone away everywhere: no phase reaches 0.6
        med = 0.5
        beats = np.arange(0.0, 10.0, med)
        pitches = HEAD[:10]
        starts = [i * 0.25 + 0.03 for i in range(len(pitches))]
        wrong = [p + 6 for p in pitches]
        notes = _notes(pitches)
        self.assertEqual(
            _select_grid_phase(beats, med, 0, notes, 0.0,
                               _segs(starts, wrong), 1.0), 0.0)


if __name__ == "__main__":
    unittest.main()
