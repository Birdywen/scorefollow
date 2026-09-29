import unittest

from .alignment import locate_excerpt, usable_events
from .engine import analyze, parse_score
from .test_engine import recording


PITCHES = (69, 71, 72, 74, 76, 77, 72, 69, 74, 71,
           77, 76, 69, 72, 71, 74, 77, 69, 76, 72)
NAMES = {69: ("A", 4), 71: ("B", 4), 72: ("C", 5), 74: ("D", 5),
         76: ("E", 5), 77: ("F", 5)}


def xml_for(pitches):
    return '<score-partwise><part id="P1">' + ''.join(
        f'<measure number="{i}"><attributes><divisions>1</divisions></attributes>'
        f'<note><pitch><step>{NAMES[p][0]}</step><octave>{NAMES[p][1]}</octave>'
        '</pitch><duration>1</duration></note></measure>'
        for i, p in enumerate(pitches, 1)) + '</part></score-partwise>'


class AlignmentTests(unittest.TestCase):
    def test_independent_beats_disambiguate_identical_pitch_sequences(self):
        phrase = PITCHES[:10]
        notes = parse_score(xml_for(phrase + phrase))
        for i, note in enumerate(notes):
            note["onsetBeat"] = i * 2.0 if i < 10 else 20.0 + i - 10
        events = [(i + .1, i + .8, float(m)) for i, m in enumerate(phrase)]
        with self.assertRaisesRegex(ValueError, "重复乐句"):
            locate_excerpt(notes, events)
        index, _ = locate_excerpt(notes, events, beat_map=[i + .1 for i in range(12)])
        self.assertEqual(index, 10)

    def test_missing_event_keeps_its_elapsed_time(self):
        notes = parse_score(xml_for(PITCHES))
        events = [(i + .1, i + .8, float(m)) for i, m in enumerate(PITCHES[7:18]) if i != 4]
        index, _ = locate_excerpt(notes, events, beat_map=[i + .1 for i in range(13)])
        self.assertEqual(index, 7)

    def test_nearby_identical_starts_are_not_unique(self):
        notes = [{"pitchMidi": 60 + 2 * (i % 2), "measure": i + 1} for i in range(10)]
        events = [(i * .2, i * .2 + .15, 60 + 2 * (i % 2)) for i in range(8)]
        with self.assertRaisesRegex(ValueError, "重复乐句"):
            locate_excerpt(notes, events)

    def test_filtered_opening_cannot_silently_move_time_anchor(self):
        segments = [(0., .2, 35.)] + [(i + .3, i + .9, float(m)) for i, m in enumerate(PITCHES[:10])]
        result = analyze(recording(PITCHES[:10]), xml_for(PITCHES), 60, "violin",
                         start_measure=0, pitch_notes=segments)
        self.assertAlmostEqual(result["notes"][0]["expectedSec"], .3, places=3)

    def test_sensor_order_and_nonfinite_values_are_rejected(self):
        for events in ([(0., 1., float("nan"))], [(1., 2., 60.), (0., .5, 62.)],
                       [(0., 1., 60.), (.5, 1.5, 62.)]):
            with self.assertRaises(ValueError):
                usable_events(events)

    def test_context_after_24_events_disambiguates_repeat(self):
        prefix = list(PITCHES) + list(PITCHES[:4])
        first = prefix + [69, 71, 72, 74, 76, 77, 69, 71] * 3
        second = prefix + [77, 74, 71, 69, 72, 76, 74, 72] * 3
        notes = parse_score(xml_for(first + second))
        events = [(i * .4, i * .4 + .3, float(m)) for i, m in enumerate(second)]
        index, _ = locate_excerpt(notes, events)
        self.assertEqual(index, len(first))

    def test_middle_excerpt_with_missing_audio_note_and_octave_confusion(self):
        notes = parse_score(xml_for(PITCHES))
        events = list(PITCHES[7:17])
        events.pop(4)
        events[2] -= 12
        segments = [(i * .43, i * .43 + .31, m + .06) for i, m in enumerate(events)]
        index, cost = locate_excerpt(notes, segments)
        self.assertEqual(index, 7)
        self.assertLess(cost, .7)

    def test_repeated_phrases_are_ambiguous(self):
        notes = parse_score(xml_for(PITCHES + PITCHES))
        segments = [(i * .4, i * .4 + .3, float(m)) for i, m in enumerate(PITCHES[:10])]
        with self.assertRaisesRegex(ValueError, "重复乐句"):
            locate_excerpt(notes, segments)

    def test_unrelated_excerpt_fails_closed(self):
        notes = parse_score(xml_for(PITCHES))
        segments = [(i * .4, i * .4 + .3, 60.0) for i in range(10)]
        with self.assertRaisesRegex(ValueError, "不吻合"):
            locate_excerpt(notes, segments)

    def test_auto_mode_uses_located_score_start_and_independent_grid(self):
        xml = xml_for(PITCHES)
        played = PITCHES[7:18]
        segments = [(i + .12, i + .85, float(m)) for i, m in enumerate(played)]
        result = analyze(recording(played), xml, 60, "violin", start_measure=0,
                         pitch_notes=segments, sync_mode="vamp-beat",
                         beat_map=[float(i) + .12 for i in range(len(played) + 1)])
        self.assertTrue(result["summary"]["autoLocated"])
        self.assertEqual(result["summary"]["startMeasure"], 8)
        self.assertEqual(result["notes"][0]["pitchMidi"], played[0])
        self.assertIsNotNone(result["summary"]["locationCost"])

    def test_without_pitch_sensor_auto_mode_explains_failure(self):
        with self.assertRaisesRegex(ValueError, "pYIN"):
            analyze(recording(PITCHES[:10]), xml_for(PITCHES), 60, "violin", start_measure=0)


if __name__ == "__main__":
    unittest.main()
