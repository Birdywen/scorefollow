import io
import unittest
import wave

import numpy as np

from . import piano_engine
from .engine import parse_score
from .test_engine import recording, score


def fake_perf(*events):
    return [(float(o), float(o) + 0.4, float(m), 80.0) for o, m in events]


class PianoTests(unittest.TestCase):
    def test_perfect_take_scores_full(self):
        piano_engine.transcribe_notes = lambda wav: fake_perf(
            (0.12, 69), (1.12, 71), (2.12, 72), (3.12, 74), (4.12, 76))
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        self.assertEqual(result["summary"]["noteCount"], 5)
        self.assertEqual(result["summary"]["correctPitchNotes"], 5)
        self.assertEqual(result["summary"]["missedNotes"], 0)
        self.assertEqual(result["summary"]["sensors"], ["piano-transcribe"])
        self.assertTrue(all(n["status"] == "correct" for n in result["notes"]))

    def test_wrong_and_missed_notes(self):
        piano_engine.transcribe_notes = lambda wav: fake_perf(
            (0.12, 69), (1.12, 71), (2.12, 73), (3.12, 74))
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        by_id = {n["id"]: n for n in result["notes"]}
        self.assertEqual(by_id["n3"]["status"], "missed")
        self.assertEqual(by_id["n5"]["status"], "missed")
        self.assertEqual(result["summary"]["missedNotes"], 2)
        # stray C#5 (73) matches nothing -> extra
        self.assertEqual(result["summary"]["extraNotes"], 1)

    def test_extras_outside_excerpt_window_are_ignored(self):
        piano_engine.transcribe_notes = lambda wav: fake_perf(
            (0.12, 69), (1.12, 71), (2.12, 72), (3.12, 74), (4.12, 76),
            # far-away resonance doubles: before start and past the excerpt
            (-2.0, 40), (30.0, 40))
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        self.assertEqual(result["summary"]["extraNotes"], 0)
        self.assertEqual(result["summary"]["correctPitchNotes"], 5)

    def test_pedal_blur_tie_goes_to_stronger_strike(self):
        # Blur pair sits on note 2 (note 1 anchors the grid, so no tie is possible there).
        piano_engine.transcribe_notes = lambda wav: [
            (0.12, 0.5, 69.0, 80.0),
            (1.10, 1.5, 71.0, 30.0),   # weak resonance blur, 20 ms early
            (1.14, 1.5, 71.0, 90.0),   # real strike, 20 ms late (exact tie)
            (2.12, 2.5, 72.0, 80.0),
            (3.12, 3.5, 74.0, 80.0), (4.12, 4.5, 76.0, 80.0)]
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        self.assertAlmostEqual(result["notes"][1]["performedSec"], 1.14, places=2)
        self.assertEqual(result["notes"][1]["status"], "correct")

    def test_failed_transcription_raises_chinese_error(self):
        piano_engine.transcribe_notes = lambda wav: None
        try:
            with self.assertRaisesRegex(ValueError, "钢琴转录失败"):
                piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes


if __name__ == "__main__":
    unittest.main()
