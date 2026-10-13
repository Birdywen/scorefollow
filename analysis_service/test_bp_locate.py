import os
import unittest
from unittest.mock import patch

import numpy as np

from .engine import _bp_locate_events, analyze, bp_monophonic
from .test_alignment import PITCHES, xml_for
from .test_engine import recording


PLAYED = PITCHES[7:18]
GOOD = [(i + .12, i + .85, float(m)) for i, m in enumerate(PLAYED)]
# Far below the score's range: no candidate start survives (same as test_fused_locate).
BAD = [(i + .12, i + .85, float(55 + (i * 5) % 7)) for i in range(len(PLAYED))]
BP = 'analysis_service.engine._bp_locate_events'
FUSED = 'analysis_service.engine._fused_locate_events'


def run(pitch_notes):
    return analyze(recording(PLAYED), xml_for(PITCHES), 60, 'violin', start_measure=0,
                   pitch_notes=pitch_notes)


def rounded(events):
    return [tuple(round(v, 6) for v in row) for row in events]


class BpMonophonicTests(unittest.TestCase):
    def test_groups_keep_lowest_trim_overlap_and_drop_head(self):
        raw = [(0.01, 0.4, 60), (0.5, 1.2, 74), (0.53, 1.0, 62), (1.1, 1.6, 64),
               (1.0, 0.9, 65), (2.0, 2.8, 67), (2.5, 3.0, 69)]
        self.assertEqual(rounded(bp_monophonic(raw)),
                         [(0.53, 1.0, 62.0), (1.1, 1.6, 64.0), (2.0, 2.499, 67.0), (2.5, 3.0, 69.0)])

    def test_bad_rows_are_skipped(self):
        self.assertEqual(bp_monophonic([None, ('x', 1, 2), (0.2, float('nan'), 60)]), [])


class BpLocateEventsTests(unittest.TestCase):
    def test_unconfigured_returns_none(self):
        with patch.dict(os.environ, {}):
            os.environ.pop('SCOREFOLLOW_BP_PYTHON', None)
            self.assertIsNone(_bp_locate_events(np.full(2205, 0.1, dtype=np.float32), 22050))

    def test_broken_interpreter_returns_none(self):
        with patch.dict(os.environ, {'SCOREFOLLOW_BP_PYTHON': '/nonexistent/sf-bp-python'}):
            self.assertIsNone(_bp_locate_events(np.full(2205, 0.2, dtype=np.float32), 22050))


class BpLocateTests(unittest.TestCase):
    def test_bp_events_locate_when_pyin_cannot_and_are_labelled(self):
        with patch(BP, return_value=GOOD), patch(FUSED, return_value=None):
            summary = run(BAD)['summary']
        self.assertTrue(summary['autoLocated'])
        self.assertEqual(summary['startMeasure'], 8)
        self.assertIn('bp-locate', summary['sensors'])
        self.assertNotIn('fused-locate', summary['sensors'])

    def test_pyin_wins_when_bp_events_do_not_fit(self):
        with patch(BP, return_value=BAD):
            summary = run(GOOD)['summary']
        self.assertEqual(summary['startMeasure'], 8)
        self.assertNotIn('bp-locate', summary['sensors'])

    def test_unavailable_bp_keeps_previous_behaviour(self):
        with patch(BP, return_value=None):
            summary = run(GOOD)['summary']
        self.assertEqual(summary['startMeasure'], 8)
        self.assertNotIn('bp-locate', summary['sensors'])

    def test_all_routes_failing_keep_original_error(self):
        with patch(BP, return_value=BAD), patch(FUSED, return_value=None):
            with self.assertRaisesRegex(ValueError, '不足以定位'):
                run(BAD)


if __name__ == '__main__':
    unittest.main()
