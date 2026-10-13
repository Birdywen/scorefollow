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

    def test_bp_skipped_when_pyin_align_confident(self):
        with patch(BP) as bp_mock, patch(FUSED, return_value=None):
            summary = run(GOOD)['summary']
        bp_mock.assert_not_called()
        self.assertEqual(summary['startMeasure'], 8)
        self.assertNotIn('bp-locate', summary['sensors'])

    def test_bp_runs_when_pyin_path_fails(self):
        with patch(BP, return_value=GOOD) as bp_mock, patch(FUSED, return_value=None):
            summary = run(BAD)['summary']
        bp_mock.assert_called_once()
        self.assertTrue(summary['autoLocated'])
        self.assertIn('bp-locate', summary['sensors'])

    def test_pyin_locate_preferred_over_bp_hit_in_fallback(self):
        with patch('analysis_service.engine.align_excerpt', side_effect=ValueError('no align')), \
                patch(BP, return_value=GOOD), patch(FUSED, return_value=None):
            summary = run(GOOD)['summary']
        self.assertEqual(summary['startMeasure'], 8)
        self.assertNotIn('bp-locate', summary['sensors'])


class BpCacheTests(unittest.TestCase):
    def test_lru_evicts_oldest_beyond_cap(self):
        import hashlib
        import pathlib
        from . import engine as E
        E._BP_CACHE.clear()
        self.addCleanup(E._BP_CACHE.clear)

        def fake_run(cmd, **kwargs):
            pathlib.Path(cmd[5]).write_text('{"notes": [[0.1, 0.5, 60]]}')
            return 0

        with patch.dict(os.environ, {'SCOREFOLLOW_BP_PYTHON': '/fake/sf-bp-python'}), \
                patch('subprocess.run', side_effect=fake_run):
            first_key = None
            for i in range(E._BP_CACHE_CAP + 6):
                sig = np.full(2205, 0.1 + i * 0.001, dtype=np.float32)
                self.assertEqual(
                    E._bp_locate_events(sig, 22050), [(0.1, 0.5, 60)])
                if i == 0:
                    raw = np.ascontiguousarray(sig, dtype=np.float32).tobytes()
                    first_key = (hashlib.blake2b(raw, digest_size=16).digest(), 22050)
        self.assertLessEqual(len(E._BP_CACHE), E._BP_CACHE_CAP)
        self.assertNotIn(first_key, E._BP_CACHE)


if __name__ == '__main__':
    unittest.main()
