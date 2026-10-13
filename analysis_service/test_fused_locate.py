import unittest
from unittest.mock import patch

from .engine import analyze
from .test_alignment import PITCHES, xml_for
from .test_engine import recording


PLAYED = PITCHES[7:18]
GOOD = [(i + .12, i + .85, float(m)) for i, m in enumerate(PLAYED)]
# Varied (not single-note) but far below the score's 69-77 range: no candidate start
# survives, so locate fails closed with the "不足以定位" error (empty-candidate path).
BAD = [(i + .12, i + .85, float(55 + (i * 5) % 7)) for i in range(len(PLAYED))]
TARGET = "analysis_service.engine._fused_locate_events"


def run(pitch_notes):
    return analyze(recording(PLAYED), xml_for(PITCHES), 60, "violin", start_measure=0,
                   pitch_notes=pitch_notes)


class FusedLocateFallbackTests(unittest.TestCase):
    def test_fused_events_rescue_failed_locate_and_are_labelled(self):
        with patch(TARGET, return_value=GOOD) as fused:
            result = run(BAD)
        self.assertTrue(fused.called)
        summary = result["summary"]
        self.assertTrue(summary["autoLocated"])
        self.assertEqual(summary["startMeasure"], 8)
        self.assertIn("fused-locate", summary["sensors"])
        self.assertIsNotNone(summary["locationCost"])

    def test_unavailable_fused_events_keep_original_error(self):
        with patch(TARGET, return_value=None):
            with self.assertRaisesRegex(ValueError, "不足以定位"):
                run(BAD)

    def test_fused_failure_reraises_first_error(self):
        with patch(TARGET, return_value=None):
            with self.assertRaises(ValueError) as plain:
                run(BAD)
        with patch(TARGET, return_value=BAD):
            with self.assertRaises(ValueError) as retried:
                run(BAD)
        self.assertEqual(str(retried.exception), str(plain.exception))

    def test_successful_locate_never_calls_fused(self):
        with patch(TARGET, return_value=BAD) as fused:
            result = run(GOOD)
        fused.assert_not_called()
        self.assertEqual(result["summary"]["startMeasure"], 8)
        self.assertNotIn("fused-locate", result["summary"]["sensors"])


if __name__ == "__main__":
    unittest.main()
