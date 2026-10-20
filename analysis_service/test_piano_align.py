"""piano-align-0.4: polyphonic score parsing and tempo-free alignment."""
import unittest
from collections import Counter

from . import piano_engine
from .piano_score import parse_piano_score
from .test_engine import continuous_recording

NAMES = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"]


def pitch_xml(midi: int) -> str:
    step = NAMES[midi % 12]
    alter = "<alter>1</alter>" if midi % 12 in (1, 3, 6, 8, 10) else ""
    return f"<pitch><step>{step}</step>{alter}<octave>{midi // 12 - 1}</octave></pitch>"


def notes_xml(events, staff: int, voice: int) -> str:
    """events: [(pitches tuple or (), quarters, extra_xml)]"""
    out = []
    for ev in events:
        pitches, q = ev[0], ev[1]
        extra = ev[2] if len(ev) > 2 else ""
        if not pitches:
            out.append(f"<note><rest/><duration>{q}</duration><voice>{voice}</voice><staff>{staff}</staff></note>")
        for k, p in enumerate(pitches):
            chord = "<chord/>" if k else ""
            out.append(f"<note>{chord}{pitch_xml(p)}<duration>{q}</duration><voice>{voice}</voice>"
                       f"<staff>{staff}</staff>{extra}</note>")
    return "".join(out)


def grand_xml(measures, beats=4, barlines=None):
    """measures: [(rh_events, lh_events)]; barlines: {measure_index: xml} added to that measure."""
    body = []
    for i, (rh, lh) in enumerate(measures):
        attrs = ("<attributes><divisions>1</divisions><key><fifths>0</fifths></key>"
                 f"<time><beats>{beats}</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>") if i == 0 else ""
        rh_len = sum(e[1] for e in rh)
        body.append(f'<measure number="{i + 1}">{attrs}{(barlines or {}).get(i, "")}{notes_xml(rh, 1, 1)}'
                    f"<backup><duration>{rh_len}</duration></backup>{notes_xml(lh, 2, 5)}</measure>")
    return ('<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>'
            f'</score-part></part-list><part id="P1">{"".join(body)}</part></score-partwise>')


def melody_measures(n_measures, seed=0):
    """4/4: RH four quarter notes (varied), LH one whole-note bass."""
    out = []
    for m in range(n_measures):
        rh = [((60 + (m * 5 + k * 3 + seed) % 17,), 1) for k in range(4)]
        out.append((rh, [((36 + (m * 7) % 12,), 4)]))
    return out


def perform(notes, beat_to_sec, skip=(), repitch=None, shift=None, vel=80.0):
    perf = []
    for i, n in enumerate(notes):
        if i in skip:
            continue
        t = beat_to_sec(n["onsetBeat"]) + (shift or {}).get(i, 0.0)
        perf.append((t, t + 0.3, float(n["pitchMidi"] + (repitch or {}).get(i, 0)), vel))
    return sorted(perf)


class PianoScoreTests(unittest.TestCase):
    def test_grand_staff_chords_ties_and_shared_noteheads(self):
        rh = [((60, 64, 67), 2), ((72,), 2, '<tie type="start"/>')]
        lh = [((48,), 4)]
        m2 = ([((72,), 2, '<tie type="stop"/>'), ((74,), 2)], [((48,), 2), ((50,), 2)])
        notes = parse_piano_score(grand_xml([(rh, lh), m2]))
        at0 = sorted(n["pitchMidi"] for n in notes if n["onsetBeat"] == 0)
        self.assertEqual(at0, [48, 60, 64, 67])                      # LH after <backup> starts at beat 0
        tied = [n for n in notes if n["pitchMidi"] == 72]
        self.assertEqual((len(tied), tied[0]["durationBeat"]), (1, 4))  # tie = one strike
        self.assertEqual({n["staff"] for n in notes}, {1, 2})
        # The same pitch written in two voices at once is one key press.
        dup = grand_xml([([((60,), 4)], [((60,), 4)])])
        self.assertEqual(len(parse_piano_score(dup)), 1)

    def test_repeats_and_volta_endings_unfold(self):
        ms = melody_measures(4)
        bar = {0: '<barline location="left"><repeat direction="forward"/></barline>',
               1: '<barline location="left"><ending number="1" type="start"/></barline>'
                  '<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>',
               2: '<barline location="left"><ending number="2" type="start"/></barline>'
                  '<barline location="right"><ending number="2" type="stop"/></barline>'}
        spans = []
        parse_piano_score(grand_xml(ms, barlines=bar), spans=spans)
        self.assertEqual([m for m, _b, _e in spans], [1, 2, 1, 3, 4])
        self.assertEqual(len(parse_piano_score(grand_xml(ms, barlines=bar), unfold=False)), 4 * 5)


class PianoAlignTests(unittest.TestCase):
    def analyze(self, xml, perf, start=1, bpm=100, seconds=None):
        seconds = seconds or perf[-1][0] + 1.0
        return piano_engine.analyze_piano(continuous_recording(seconds=seconds), xml, bpm, start, perf=perf)

    def test_accelerando_is_not_a_rhythm_error(self):
        xml = grand_xml(melody_measures(12))
        notes = parse_piano_score(xml)
        # 0.6 s per beat slowing to 0.4 s: a 33% tempo change over the piece.
        perf = perform(notes, lambda b: 0.5 + 0.6 * b - 0.2 * b * b / 96)
        s = self.analyze(xml, perf)["summary"]
        self.assertEqual((s["correctPitchNotes"], s["missedNotes"], s["extraNotes"]), (len(notes), 0, 0))
        self.assertGreaterEqual(s["rhythmScore"], 95)

    def test_uneven_note_is_late_and_wrong_note_reports_played_pitch(self):
        xml = grand_xml(melody_measures(10))
        notes = parse_piano_score(xml)
        late = next(i for i, n in enumerate(notes) if n["measure"] == 5 and n["staff"] == 1)
        wrong = next(i for i, n in enumerate(notes) if n["measure"] == 7 and n["staff"] == 1)
        perf = perform(notes, lambda b: 0.5 + 0.5 * b, shift={late: 0.18}, repitch={wrong: 1}, skip={3})
        r = self.analyze(xml, perf)
        by = {(n["onsetBeat"], n["pitchMidi"]): n for n in r["notes"]}
        self.assertEqual(by[(notes[late]["onsetBeat"], notes[late]["pitchMidi"])]["status"], "late")
        w = by[(notes[wrong]["onsetBeat"], notes[wrong]["pitchMidi"])]
        self.assertEqual((w["status"], w["playedMidi"]), ("wrong_pitch", notes[wrong]["pitchMidi"] + 1))
        self.assertEqual(r["summary"]["missedNotes"], 1)
        self.assertEqual(len(r["measureIntervals"]), 10)

    def test_auto_locate_finds_the_excerpt(self):
        xml = grand_xml(melody_measures(24, seed=3))
        notes = parse_piano_score(xml)
        part = [n for n in notes if 9 <= n["measure"] <= 14]
        b0 = part[0]["onsetBeat"]
        perf = perform(part, lambda b: 1.0 + 0.45 * (b - b0))
        s = self.analyze(xml, perf, start=0)["summary"]
        self.assertTrue(s["autoLocated"])
        self.assertEqual((s["startMeasure"], s["endMeasure"]), (9, 14))
        self.assertEqual(s["missedNotes"], 0)

    def test_repeat_skipped_in_the_take_is_not_missed(self):
        ms = melody_measures(4)
        bar = {0: '<barline location="left"><repeat direction="forward"/></barline>',
               1: '<barline location="right"><repeat direction="backward"/></barline>'}
        xml = grand_xml(ms, barlines=bar)
        printed = parse_piano_score(xml, unfold=False)
        s = self.analyze(xml, perform(printed, lambda b: 0.5 + 0.5 * b))["summary"]
        self.assertEqual((s["missedNotes"], s["repeatsUnfolded"]), (0, False))
        unfolded = parse_piano_score(xml)
        s = self.analyze(xml, perform(unfolded, lambda b: 0.5 + 0.5 * b))["summary"]
        self.assertEqual((s["missedNotes"], s["noteCount"], s["repeatsUnfolded"]), (0, len(unfolded), True))

    def test_consistent_wrong_pitch_is_flagged_as_score_suspect(self):
        xml = grand_xml(melody_measures(16))
        notes = parse_piano_score(xml)
        # The commonest pitch always played a semitone higher: what a missed key change or
        # accidental in an OMR score looks like.
        common = Counter(n["pitchMidi"] for n in notes).most_common(1)[0][0]
        rep = {i: 1 for i, n in enumerate(notes) if n["pitchMidi"] == common}
        s = self.analyze(xml, perform(notes, lambda b: 0.5 + 0.5 * b, repitch=rep))["summary"]
        self.assertGreaterEqual(len(rep), 4)
        self.assertIn((common % 12, 1), {(x["pitchClass"], x["semitones"]) for x in s["scoreSuspects"]})

    def test_split_chord_counts_as_uneven(self):
        ms = [([((60, 64, 67), 4)], [((48,), 4)]) for _ in range(8)]
        xml = grand_xml(ms)
        notes = parse_piano_score(xml)
        top = {i: 0.09 for i, n in enumerate(notes) if n["pitchMidi"] == 67 and n["measure"] == 4}
        s = self.analyze(xml, perform(notes, lambda b: 0.5 + 0.5 * b, shift=top))["summary"]
        self.assertEqual(s["unevenChords"], 1)
        self.assertEqual(s["unevenChordMeasures"], [4])


if __name__ == "__main__":
    unittest.main()
