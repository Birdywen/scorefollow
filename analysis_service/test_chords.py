import unittest

from .alignment import _extra_cost, _match_cost, _pitch_diff, align_excerpt, usable_events
from .engine import bp_chords, measure_start_beats, parse_score

NAMES = {48: ("C", 3), 52: ("E", 3), 55: ("G", 3), 57: ("A", 3), 59: ("B", 3), 60: ("C", 4),
         62: ("D", 4), 64: ("E", 4), 65: ("F", 4), 67: ("G", 4), 69: ("A", 4), 71: ("B", 4)}


def note(p, chord=False, dur=1, tie=None):
    return ('<note>' + ('<chord/>' if chord else '') +
            f'<pitch><step>{NAMES[p][0]}</step><octave>{NAMES[p][1]}</octave></pitch>'
            f'<duration>{dur}</duration>' + (f'<tie type="{tie}"/>' if tie else '') + '</note>')


def chord_xml(events):
    """events: list of pitch tuples, one quarter each, one measure per event."""
    return '<score-partwise><part id="P1">' + ''.join(
        f'<measure number="{i}"><attributes><divisions>1</divisions></attributes>' +
        note(ps[0]) + ''.join(note(p, chord=True) for p in ps[1:]) + '</measure>'
        for i, ps in enumerate(events, 1)) + '</part></score-partwise>'


class ParseChordTests(unittest.TestCase):
    def test_chord_tones_share_onset_and_keep_base_pitch(self):
        notes = parse_score(chord_xml([(48, 64), (60,), (55, 71, 62)]))
        self.assertEqual([n["onsetBeat"] for n in notes], [0, 1, 2])
        self.assertEqual([n["pitchMidi"] for n in notes], [48, 60, 55])
        self.assertEqual(notes[0]["chordMidi"], [48, 64])
        self.assertNotIn("chordMidi", notes[1])
        self.assertEqual(notes[2]["chordMidi"], [55, 62, 71])

    def test_measure_starts_ignore_chord_durations(self):
        starts = measure_start_beats(chord_xml([(48, 64), (60,), (55, 71, 62)]), include_end=True)
        self.assertEqual(starts, {1: 0.0, 2: 1.0, 3: 2.0, 4: 3.0})

    def test_tied_chord_tones_do_not_start_notes(self):
        xml = ('<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>' +
               note(48, tie="start") + note(64, chord=True, tie="start") + '</measure><measure number="2">' +
               note(48, tie="stop") + note(64, chord=True, tie="stop") + note(60) + '</measure></part></score-partwise>')
        notes = parse_score(xml)
        self.assertEqual([(n["pitchMidi"], n["onsetBeat"], n["durationBeat"]) for n in notes],
                         [(48, 0, 2.0), (60, 2, 1.0)])
        self.assertEqual(notes[0]["chordMidi"], [48, 64])


class MatchCostTests(unittest.TestCase):
    def test_single_vs_single_is_unchanged(self):
        for h, w in ((60, 60), (60.3, 60), (72, 60), (64, 60), (50, 60)):
            self.assertEqual(_match_cost(float(h), float(w)), _pitch_diff(float(h), float(w)))

    def test_single_pitch_matches_any_chord_tone(self):
        self.assertEqual(_match_cost(64.0, (48.0, 64.0)), 0.0)

    def test_heard_chord_costs(self):
        self.assertEqual(_match_cost((48.0, 55.0, 64.0), (48.0, 55.0, 64.0)), 0.0)
        missed_bass = _match_cost((55.0, 64.0), (48.0, 55.0, 64.0))
        wrong_tone = _match_cost((48.0, 57.0, 64.0), (48.0, 55.0, 64.0))
        self.assertGreater(missed_bass, 0.0)
        self.assertLess(missed_bass, wrong_tone)
        self.assertGreater(_match_cost((50.0, 59.0), (48.0, 55.0, 64.0)), 1.0)

    def test_chord_fragment_is_cheap_extra_only_next_to_a_chord(self):
        self.assertEqual(_extra_cost((43.0,), 43.0), 1.25)
        self.assertAlmostEqual(_extra_cost((43.0,), (43.0, 53.0, 59.0)), 0.1)
        self.assertEqual(_extra_cost((50.0, 66.0), (43.0, 53.0, 59.0)), 1.25)

    def test_usable_events_accepts_chords(self):
        ev = usable_events([(0.1, 0.5, (64.0, 48.0)), (0.6, 1.0, 60.0), (1.1, 1.5, (20.0, 62.0))])
        self.assertEqual(ev, [(0.1, 0.5, (48.0, 64.0)), (0.6, 1.0, 60.0), (1.1, 1.5, (62.0,))])


class BpChordTests(unittest.TestCase):
    def test_rolled_chord_groups_but_melody_does_not(self):
        raw = [(1.0, 1.1, 43), (1.0, 2.6, 53), (1.3, 2.5, 59),     # short bass + rolled top
               (3.0, 3.25, 60), (3.22, 3.5, 62), (3.48, 3.75, 64)]  # legato melody, slight overlap
        out = bp_chords(raw)
        self.assertEqual([e[2] for e in out], [(43.0, 53.0, 59.0), (60.0,), (62.0,), (64.0,)])
        self.assertEqual(out[0][0], 1.0)
        self.assertTrue(all(out[i][1] < out[i + 1][0] for i in range(len(out) - 1)))

    def test_head_onsets_dropped(self):
        self.assertEqual(bp_chords([(0.01, 0.5, 60), (0.6, 1.0, 62)]), [(0.6, 1.0, (62.0,))])


class ChordAlignmentTests(unittest.TestCase):
    CHORDS = [(48, 64), (55, 71), (52, 67), (57, 69), (48, 60), (55, 62), (52, 64), (59, 67),
              (48, 64), (57, 65), (55, 71), (52, 60), (48, 67), (59, 62), (57, 64), (55, 67)]

    def test_chord_events_locate_where_lowest_note_is_ambiguous(self):
        notes = parse_score(chord_xml(self.CHORDS))
        played = self.CHORDS[3:15]
        events = [(i * .5 + .2, i * .5 + .65, tuple(float(p) for p in ps)) for i, ps in enumerate(played)]
        r = align_excerpt(notes, events)
        self.assertEqual(r["start"], 3)
        self.assertEqual(r["end"], 14)
        self.assertTrue(r["confident"])
        self.assertLess(r["cost"], 0.05)


if __name__ == "__main__":
    unittest.main()
