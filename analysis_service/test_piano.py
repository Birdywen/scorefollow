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

    def test_failed_transcription_raises_chinese_error(self):
        piano_engine.transcribe_notes = lambda wav: None
        try:
            with self.assertRaisesRegex(ValueError, "钢琴转录失败"):
                piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes


if __name__ == "__main__":
    unittest.main()
