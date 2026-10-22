import unittest

from . import piano_engine, voice_fill
from .piano_score import parse_piano_score
from .test_engine import continuous_recording

STEP_MIDI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def n(step, octave, dur, voice, staff, extra=""):
    pitch = "<rest/>" if step is None else f"<pitch><step>{step}</step><octave>{octave}</octave></pitch>"
    return f"<note>{pitch}<duration>{dur}</duration><voice>{voice}</voice>{extra}<staff>{staff}</staff></note>"


def back(d):
    return f"<backup><duration>{d}</duration></backup>"


def score(bars, beats=2):
    attrs = (f"<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>{beats}</beats>"
             f"<beat-type>4</beat-type></time><staves>2</staves></attributes>")
    body = "".join(f'<measure number="{i + 1}">{attrs if i == 0 else ""}{b}</measure>' for i, b in enumerate(bars))
    return ('<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list>'
            '<score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
            f'<part id="P1">{body}</part></score-partwise>')



def shared_bar(b1, b2):
    """2/4: voice 6 strikes b1 and b2 on beats 1 and 2 (eighth rests unprinted); voice 5 shares the heads."""
    v1 = n("D", 5, 8, 1, 1)
    v5 = n(*b1, 1, 5, 2) + n("G", 3, 1, 5, 2) + n(None, 0, 2, 5, 2) + n(*b2, 1, 5, 2) + n("G", 3, 1, 5, 2) + n(None, 0, 2, 5, 2)
    v6 = n(*b1, 2, 6, 2) + n(*b2, 2, 6, 2)
    return v1 + back(8) + v5 + back(8) + v6


class VoiceFillTests(unittest.TestCase):
    def test_shared_noteheads_respace_the_voice_and_match_the_editor(self):
        xml = score([shared_bar(("B", 2), ("C", 3))])
        [v] = voice_fill.short_voices(xml)
        self.assertEqual((v.staff, v.voice, v.length), ("2", "6", 8))
        onsets = voice_fill.proposal(v)
        self.assertEqual(onsets, [0, 4])
        filled = voice_fill.fill(xml, v, onsets)
        self.assertIn("<forward><duration>2</duration><voice>6</voice><staff>2</staff></forward>", filled)
        self.assertEqual(filled.count("<rest/>"), xml.count("<rest/>"))
        c3 = lambda x: sorted(t["onsetBeat"] for t in parse_piano_score(x) if t["pitchMidi"] == 48)
        self.assertEqual(c3(xml), [0.5, 1.0])
        self.assertEqual(c3(filled), [1.0])
        self.assertEqual(voice_fill.short_voices(filled), [], "filled voice is no longer one packed run")

    def test_beam_group_is_never_split(self):
        bm = lambda t: f'<beam number="1">{t}</beam>'
        xml = score([n("C", 5, 2, 1, 1) + n("E", 5, 2, 1, 1) + n("G", 5, 2, 1, 1) + n("C", 6, 2, 1, 1) + back(8)
                     + n("E", 4, 1, 2, 1, bm("begin")) + n("G", 4, 1, 2, 1, bm("end"))])
        for v in voice_fill.short_voices(xml):
            r = voice_fill.place(v, lambda i, t: -10.0 if i == 1 and t == 6 else 0.0)  # even if the take "wants" a split
            self.assertEqual(r[0][1] - r[0][0], 1)

    def _take(self, bass_beat):
        """8 bars, 2/4 at 60 bpm. Treble: eighths. Bass voice 6: one eighth E3 written packed to the
        bar start; the pianist plays it on `bass_beat` (0 or 1). No shared notehead: only the take can tell."""
        bars, perf = [], []
        treble = [("C", 5), ("D", 5), ("E", 5), ("F", 5)]
        for m in range(8):
            v1 = "".join(n(s, o, 2, 1, 1) for s, o in treble)
            v5 = n("C", 3, 4, 5, 2) + n("G", 2, 4, 5, 2)
            v6 = n("E", 3, 2, 6, 2)
            bars.append(v1 + back(8) + v5 + back(8) + v6)
            t0 = 2.0 * m
            for k, (s, o) in enumerate(treble):
                perf.append((t0 + 0.5 * k, 12 * (o + 1) + STEP_MIDI[s]))
            perf += [(t0, 48), (t0 + 1.0, 43), (t0 + bass_beat, 52)]
        perf = sorted((float(on), float(on) + 0.3, float(p), 80.0) for on, p in perf)
        return score(bars), perf

    def test_take_places_a_voice_the_score_alone_cannot(self):
        xml, perf = self._take(bass_beat=1)
        self.assertTrue(all(voice_fill.proposal(v) is None for v in voice_fill.short_voices(xml)), "score alone: unclear")
        r = piano_engine.analyze_piano(continuous_recording(seconds=17), xml, 60, 1, perf=perf, trust=False)
        fixes = r["summary"]["voiceFixes"]
        self.assertEqual(len(fixes), 8)
        self.assertEqual({(f["staff"], f["voice"], tuple(f["from"]), tuple(f["to"])) for f in fixes}, {("2", "6", (0.0,), (1.0,))})
        self.assertIn("voice_filled", [e["kind"] for e in r["summary"]["scoreCheck"]["evidence"]])
        self.assertEqual(r["summary"]["missedNotes"] + r["summary"]["extraNotes"], 0)
        off = piano_engine.analyze_piano(continuous_recording(seconds=17), xml, 60, 1, perf=perf, trust=False, fill_voices=False)
        self.assertEqual(off["summary"]["voiceFixes"], [])
        self.assertGreater(off["summary"]["missedNotes"] + off["summary"]["extraNotes"]
                           + off["summary"]["wrongPitchNotes"], 0, "without the fill the take looks wrong")

    def test_take_as_written_changes_nothing(self):
        xml, perf = self._take(bass_beat=0)
        r = piano_engine.analyze_piano(continuous_recording(seconds=17), xml, 60, 1, perf=perf, trust=False)
        self.assertEqual(r["summary"]["voiceFixes"], [])
        self.assertNotIn("voice_filled", [e["kind"] for e in r["summary"]["scoreCheck"]["evidence"]])


if __name__ == "__main__":
    unittest.main()
