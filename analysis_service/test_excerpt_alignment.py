"""Full-excerpt alignment: start + end + measure map, incl. partial takes."""
import unittest

from .alignment import align_excerpt
from .engine import analyze, parse_score
from .test_engine import recording


STEPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def name_of(midi):
    step = STEPS[midi % 12]
    alter = ""
    if step.endswith("#"):
        step, alter = step[0], "<alter>1</alter>"
    return step, alter, midi // 12 - 1


def xml_for(pitches, divisions=1, beats=4, beat_type=4, note_quarters=1.0):
    body = []
    duration = int(divisions * note_quarters)
    for i, p in enumerate(pitches):
        attrs = (f"<attributes><divisions>{divisions}</divisions>"
                 f"<time><beats>{beats}</beats><beat-type>{beat_type}</beat-type></time>"
                 "</attributes>") if i == 0 else ""
        step, alter, octave = name_of(p)
        body.append(
            f'<measure number="{i + 1}">{attrs}<note><pitch><step>{step}</step>{alter}'
            f"<octave>{octave}</octave></pitch><duration>{duration}</duration></note></measure>")
    return "<score-partwise><part id=\"P1\">" + "".join(body) + "</part></score-partwise>"


def melody(length, seed=48, step=7, span=40):
    return [seed + ((i * step) % span) for i in range(length)]


def segments_for(pitches, spacing=0.5, start=0.3, jitter=0.0):
    return [(start + i * spacing, start + (i + 0.7) * spacing, float(m))
            for i, m in enumerate(pitches)]


class ExcerptAlignmentTests(unittest.TestCase):
    def test_middle_excerpt_returns_start_end_and_measures(self):
        pitches = melody(40)
        notes = parse_score(xml_for(pitches))
        played = pitches[10:30]
        result = align_excerpt(notes, segments_for(played))
        self.assertEqual(result["start"], 10)
        self.assertEqual(result["end"], 29)
        self.assertTrue(result["confident"])
        self.assertEqual([m["measure"] for m in result["measureTimes"]],
                         list(range(11, 31)))
        self.assertAlmostEqual(result["quarterPeriod"], 0.5, delta=0.02)
        self.assertLess(result["residualMs"], 60)
        self.assertGreaterEqual(result["coverage"], 0.9)

    def test_full_take_beyond_64_events(self):
        pitches = melody(100)
        notes = parse_score(xml_for(pitches))
        result = align_excerpt(notes, segments_for(pitches))
        self.assertEqual(result["start"], 0)
        self.assertEqual(result["end"], 99)
        self.assertTrue(result["confident"])
        self.assertLess(result["cost"], 0.7)

    def test_rejected_tail_cannot_have_a_confident_projected_boundary(self):
        pitches = melody(40)
        events = segments_for(pitches)
        a, b, midi = events[-1]
        events[-1] = (a + 30, b + 30, midi)
        result = align_excerpt(parse_score(xml_for(pitches)), events)
        # Nearly all matches are perfect: the median residual alone passes.
        self.assertLess(result["residualMs"], 60)
        self.assertFalse(result["boundarySupported"])
        self.assertFalse(result["confident"])
        self.assertIsNone(result["endAudioSec"])
        self.assertEqual(result["matchedEndSec"], events[-1][1])
        from .engine import _usable_excerpt
        self.assertFalse(_usable_excerpt(result))

    def test_supported_rubato_end_uses_local_anchors_not_global_line(self):
        pitches = melody(40)
        events = [(a + i * i * .001, b + i * i * .001, midi)
                  for i, (a, b, midi) in enumerate(segments_for(pitches))]
        result = align_excerpt(parse_score(xml_for(pitches)), events)
        self.assertTrue(result["boundarySupported"])
        self.assertAlmostEqual(result["endAudioSec"], events[-1][0] + result["quarterPeriod"], delta=.002)

    def test_repeat_with_distinguishing_tail_disambiguates(self):
        phrase = melody(20)
        tail_a = [84, 83, 81, 79, 77, 76, 74, 72, 71, 69]
        tail_b = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64]
        score_pitches = phrase + tail_a + melody(30, seed=60, step=5, span=24) + phrase + tail_b
        notes = parse_score(xml_for(score_pitches))
        played = phrase + tail_b
        result = align_excerpt(notes, segments_for(played))
        self.assertEqual(result["start"], 60)
        self.assertEqual(result["end"], 89)
        self.assertTrue(result["confident"])

    def test_exact_repeat_fails_closed(self):
        phrase = melody(20)
        notes = parse_score(xml_for(phrase + phrase))
        with self.assertRaisesRegex(ValueError, "重复乐句"):
            align_excerpt(notes, segments_for(phrase))

    def test_long_score_short_recording_aligns_partially(self):
        # Repeat period (44) exceeds the score tail: the excerpt cannot also
        # live at +44 (only 16 notes remain there), so it is unambiguous.
        pitches = melody(60, seed=50, step=7, span=44)
        notes = parse_score(xml_for(pitches))
        result = align_excerpt(notes, segments_for(pitches[:20]))
        self.assertEqual(result["start"], 0)
        self.assertEqual(result["end"], 19)
        self.assertTrue(result["confident"])

    def test_middle_excerpt_with_missing_and_octave_shifted_notes(self):
        pitches = melody(40)
        notes = parse_score(xml_for(pitches))
        played = list(pitches[10:30])
        played.pop(4)
        played[2] -= 12
        result = align_excerpt(notes, segments_for(played))
        self.assertEqual(result["start"], 10)
        self.assertEqual(result["end"], 29)
        self.assertTrue(result["confident"])

    def test_compound_pulse_needs_no_unit_assumption(self):
        # 6/8 style: eighth-note durations (0.5 quarter each); beats may come
        # at dotted spacing. Eighth spacing 0.25s -> quarterPeriod 0.5.
        pitches = melody(40)
        notes = parse_score(xml_for(pitches, divisions=2, beats=6, beat_type=8,
                                    note_quarters=0.5))
        played = pitches[12:32]
        events = [(0.3 + i * 0.25, 0.3 + (i + 0.7) * 0.25, float(m))
                  for i, m in enumerate(played)]
        dotted = [0.3 + i * 0.75 for i in range(12)]
        for beat_map in (None, dotted):
            with self.subTest(beats="dotted" if beat_map else "none"):
                result = align_excerpt(notes, events, beat_map=beat_map)
                self.assertEqual(result["start"], 12)
                self.assertEqual(result["end"], 31)
                self.assertTrue(result["confident"])
                self.assertAlmostEqual(result["quarterPeriod"], 0.5, delta=0.03)

    def test_unrelated_excerpt_fails_closed(self):
        notes = parse_score(xml_for(melody(30)))
        events = [(i * 0.4, i * 0.4 + 0.3, 60.0) for i in range(12)]
        with self.assertRaisesRegex(ValueError, "不吻合"):
            align_excerpt(notes, events)

    def test_too_few_events_fails_closed(self):
        notes = parse_score(xml_for(melody(30)))
        with self.assertRaisesRegex(ValueError, "8"):
            align_excerpt(notes, segments_for(melody(30)[:5]))

    def test_engine_auto_mode_scores_partial_range(self):
        pitches = melody(40)
        xml = xml_for(pitches)
        played = pitches[10:30]
        # segments must match recording()'s onsets (1s spacing from 0.12s).
        segs = segments_for(played, spacing=1.0, start=0.12)
        result = analyze(recording(played), xml, 60, "violin",
                         start_measure=0, pitch_notes=segs)
        summary = result["summary"]
        self.assertTrue(summary["autoLocated"])
        self.assertEqual(summary["startMeasure"], 11)
        self.assertEqual(summary["endMeasure"], 30)
        self.assertEqual(summary["noteCount"], 20)
        self.assertEqual(len(result["measureIntervals"]), 20)
        self.assertAlmostEqual(result["measureIntervals"][0]["startSec"], 0.12, delta=0.08)
        self.assertGreaterEqual(summary["pitchScore"], 95)


if __name__ == "__main__":
    unittest.main()
