"""An on-time wrong note that happens to equal a neighbour's pitch is a wrong note.

Displacement attribution (_displaced_match) exists for notes whose pitch window
lands on a neighbour because the player is early/late. When the onset sits on
the note's own grid position the window measured this note: report wrong_pitch.
"""
import unittest

from .engine import analyze
from .test_engine import recording, score


class DisplacedOnTimeTest(unittest.TestCase):
    def test_on_time_wrong_note_equal_to_next_pitch_is_wrong(self):
        # score 69 71 72 74 76; third note played as 74 (= next note), on time.
        result = analyze(recording((69, 71, 74, 74, 76)), score(), 60, "violin")
        notes = result["notes"]
        self.assertEqual(notes[2]["status"], "wrong_pitch", [n["status"] for n in notes])
        self.assertFalse(notes[2]["pitchDisplaced"])
        self.assertLess(result["summary"]["pitchScore"], 100)

    def test_clean_take_stays_clean(self):
        result = analyze(recording(), score(), 60, "violin")
        statuses = [n["status"] for n in result["notes"]]
        self.assertEqual(statuses.count("wrong_pitch"), 0, statuses)
        self.assertEqual(result["summary"]["pitchScore"], 100)


if __name__ == "__main__":
    unittest.main()
