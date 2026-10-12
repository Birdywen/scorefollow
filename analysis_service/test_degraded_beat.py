import unittest

from . import vamp_features


class BeatRequestedDegradationTests(unittest.TestCase):
    """A beat grid is only required when beat following (vamp-beat) was requested."""
    PITCH = [{"start": 0.0, "end": 0.5, "midi": 50.0}]
    ONSETS = [0.1, 0.6]

    def test_legacy_timeline_without_beat_grid_is_not_degraded(self):
        self.assertEqual(vamp_features.degradation_reasons(self.PITCH, self.ONSETS, None, beat_requested=False), [])

    def test_vamp_beat_without_grid_is_still_degraded(self):
        self.assertEqual(vamp_features.degradation_reasons(self.PITCH, self.ONSETS, None, beat_requested=True), ["beat:legacy"])

    def test_missing_pitch_is_degraded_without_beat_request(self):
        self.assertEqual(vamp_features.degradation_reasons(None, self.ONSETS, None, beat_requested=False), ["pitch:builtin"])

    def test_default_keeps_old_contract(self):
        self.assertEqual(vamp_features.degradation_reasons(self.PITCH, self.ONSETS, None), ["beat:legacy"])


class RequestedBeatFallbackTests(unittest.TestCase):
    """vamp-beat requested but the grid is unusable: the engine falls back to
    legacy internally, which is a real degradation and must stay visible."""

    def test_vamp_beat_request_without_grid_reports_beat(self):
        from .engine import analyze
        from .test_golden_scoring import build_clean
        fix = build_clean()
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"],
                         sync_mode="vamp-beat", beat_map=[])
        self.assertTrue(result["summary"]["degraded"])
        self.assertIn("beat:legacy", result["summary"]["degradedReasons"])

    def test_legacy_request_without_grid_does_not_report_beat(self):
        from .engine import analyze
        from .test_golden_scoring import build_clean
        fix = build_clean()
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        self.assertNotIn("beat:legacy", result["summary"]["degradedReasons"])


if __name__ == "__main__":
    unittest.main()
