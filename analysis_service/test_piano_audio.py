"""piano-align-0.5: tuning, the audio check of disagreements, and score-reliability verdicts."""
import io
import unittest
import wave
from unittest.mock import patch

import numpy as np

from . import piano_engine
from .piano_audio import Spectra, blind_tuning, measure_tuning, retune
from .piano_score import parse_piano_score
from .test_piano_align import grand_xml, melody_measures, perform

RATE = 22050


def piano_audio(events, seconds, cents=0.0, detuned=None):
    """events: [(onset, midi)]. Decaying tones with six partials; detuned: {midi: extra cents}."""
    t_all = np.arange(int(seconds * RATE)) / RATE
    out = np.zeros_like(t_all)
    for on, m in events:
        i0 = int(on * RATE)
        t = t_all[: len(out) - i0]
        f0 = 440 * 2 ** ((m - 69) / 12 + (cents + (detuned or {}).get(m, 0.0)) / 1200)
        env = np.exp(-t / 0.9) * np.minimum(1, t * 200)
        tone = sum(np.sin(2 * np.pi * k * f0 * t) / k for k in range(1, 7) if k * f0 < RATE / 2)
        out[i0:] += env * tone
    out *= 0.3 / max(1e-9, np.abs(out).max())
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes((out * 32767).astype("<i2").tobytes())
    return buf.getvalue(), out


def take(notes, spb=0.5, start=0.5):
    return [(start + spb * n["onsetBeat"], n["pitchMidi"]) for n in notes]


class TuningTests(unittest.TestCase):
    def test_blind_tuning_and_retune(self):
        events = [(0.2 + 0.4 * i, 60 + (i * 5) % 19) for i in range(20)]
        _wav, sig = piano_audio(events, 9, cents=31)
        cents, conc = blind_tuning(sig, RATE)
        self.assertAlmostEqual(cents, 31, delta=4)
        self.assertGreater(conc, 0.5)
        fixed, ratio = retune(sig, RATE, -cents)
        self.assertAlmostEqual(blind_tuning(fixed, RATE)[0], 0, delta=4)
        self.assertAlmostEqual(ratio, 2 ** (-cents / 1200))

    def test_one_detuned_key_is_found_and_offset_is_global(self):
        keys = [55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74]
        events = [(0.2 + 0.5 * i, keys[i % len(keys)]) for i in range(36)]
        _wav, sig = piano_audio(events, 19, cents=-12, detuned={64: 22})
        tun = measure_tuning(Spectra(sig, RATE, -12), [(m, on, on + 0.45) for on, m in events])
        self.assertEqual([k["midi"] for k in tun["outOfTuneKeys"]], [64])
        self.assertAlmostEqual(tun["outOfTuneKeys"][0]["cents"], 22, delta=4)
        self.assertLess(abs(tun["offsetCents"]), 3)  # relative to the -12 cents reference


class AudioCheckTests(unittest.TestCase):
    def setUp(self):
        self.xml = grand_xml(melody_measures(14))
        self.notes = parse_piano_score(self.xml)
        self.events = take(self.notes)
        self.seconds = self.events[-1][0] + 2

    def analyze(self, wav, perf, xml=None):
        return piano_engine.analyze_piano(wav, xml or self.xml, 120, 1, perf=perf)

    def test_transcriber_misses_are_heard_ghosts_dropped_real_miss_confirmed(self):
        really_missed = 30                       # left out of the audio and the transcription
        transcriber_missed = {12, 45, 61}        # in the audio, not in the transcription
        audio_events = [e for i, e in enumerate(self.events) if i != really_missed]
        wav, _sig = piano_audio(audio_events, self.seconds)
        perf = [(on, on + 0.4, float(m), 80.0) for i, (on, m) in enumerate(self.events)
                if i != really_missed and i not in transcriber_missed]
        ghosts = [(self.events[20][0], self.events[20][1] + 3), (self.events[50][0], self.events[50][1] - 4)]
        perf += [(on, on + 0.3, float(m), 40.0) for on, m in ghosts]
        r = self.analyze(wav, sorted(perf))
        s = r["summary"]
        self.assertTrue(s["audioCheck"]["available"])
        self.assertEqual((s["audioRescuedNotes"], s["missedNotes"], s["extraNotes"], s["ghostExtras"]), (3, 1, 0, 2))
        self.assertEqual([r["notes"][i]["matchStatus"] for i in sorted(transcriber_missed)], ["audio"] * 3)
        miss = r["notes"][really_missed]
        self.assertEqual((miss["status"], miss["audioCheck"]["result"]), ("missed", "absent"))

    def test_piano_tuned_a_semitone_low_is_not_a_pitch_error(self):
        # A415-style instrument: everything sounds (and is transcribed) a semitone below the page.
        wav, _sig = piano_audio([(on, m - 1) for on, m in self.events], self.seconds, cents=-2)
        perf = [(on, on + 0.4, float(m - 1), 80.0) for on, m in self.events]
        s = self.analyze(wav, perf)["summary"]
        self.assertEqual(s["pitchScore"], 100)
        self.assertEqual(s["tuning"]["semitoneShift"], -1)
        self.assertAlmostEqual(s["tuning"]["offsetCents"], -102, delta=5)
        self.assertAlmostEqual(s["tuning"]["referenceHz"], 415.0, delta=2)

    def test_detuned_piano_is_retuned_before_transcription(self):
        wav, _sig = piano_audio(self.events, self.seconds, cents=38)
        seen = {}

        def fake_transcribe(audio):
            with wave.open(io.BytesIO(audio)) as w:
                sig = np.frombuffer(w.readframes(w.getnframes()), "<i2") / 32767
            seen["cents"] = blind_tuning(sig, RATE)[0]
            r = 2 ** (-38 / 1200)  # the retuned audio runs slower: times are scaled back by the engine
            return [(on / r, on / r + 0.4, float(m), 80.0) for on, m in self.events]

        with patch.object(piano_engine, "transcribe_notes", side_effect=fake_transcribe):
            r = piano_engine.analyze_piano(wav, self.xml, 120, 1)
        self.assertAlmostEqual(seen["cents"], 0, delta=4)
        s = r["summary"]
        self.assertTrue(s["tuning"]["retunedForTranscription"])
        self.assertAlmostEqual(s["tuning"]["offsetCents"], 38, delta=4)
        self.assertEqual(s["pitchScore"], 100)
        self.assertLess(max(abs(n["timingErrorMs"] or 0) for n in r["notes"]), 40)

    def test_lost_ottava_is_score_evidence_not_mistakes(self):
        # The page has measures 5-9 an octave too low (as if an 8va sign was lost); the player is right.
        played = [(on, m) for on, m in self.events]
        def wrong_page(*args, **kwargs):
            return [{**n, "pitchMidi": n["pitchMidi"] - 12 if 5 <= n["measure"] <= 9 and n["staff"] == 1 else n["pitchMidi"]}
                    for n in parse_piano_score(*args, **kwargs)]

        wav, _sig = piano_audio(played, self.seconds)
        perf = [(on, on + 0.4, float(m), 80.0) for on, m in played]
        with patch.object(piano_engine, "parse_piano_score", wrong_page):
            self.last = self.analyze(wav, perf)
        s = self.last["summary"]
        ev = [e for e in s["scoreCheck"]["evidence"] if e["kind"] == "octave_shift"]
        self.assertEqual(len(ev), 1)
        # Every flagged measure is a shifted one. Not all are found: this melody repeats its pitches so
        # densely that gap filling hands some played notes to neighbouring written ones.
        self.assertTrue(set(ev[0]["measures"]) <= {5, 6, 7, 8, 9} and ev[0]["count"] >= 4)
        self.assertIn("八度", ev[0]["zh"])
        self.assertEqual({n["excludedReason"] for n in self.last["notes"] if n["status"] == "excluded"}, {"octave"})

    def test_impossible_tempo_refuses_rhythm_with_evidence(self):
        # 14 measures of 4/4 played in 5 s: 670 quarter notes a minute, so the written rhythm is wrong.
        events = take(self.notes, spb=0.09)
        wav, _sig = piano_audio(events, events[-1][0] + 2)
        perf = [(on, on + 0.08, float(m), 80.0) for on, m in events]
        r = self.analyze(wav, perf)
        s = r["summary"]
        self.assertIsNone(s["rhythmScore"])
        self.assertEqual(s["scoreCheck"]["rhythm"], "refused")
        self.assertEqual(s["pitchScore"], 100)
        self.assertIn("tempo_implausible", [e["kind"] for e in s["scoreCheck"]["evidence"]])
        from .quality import assess_quality
        q = assess_quality(r)
        self.assertIn("score_unreliable", q["issues"])
        self.assertEqual(q["outcome"], "partial")  # pitch still scored


class ScoreParsingTests(unittest.TestCase):
    def test_same_pitch_slur_is_a_tie_and_bad_measures_are_reported(self):
        slur = lambda t: f'<notations><slur type="{t}" number="1"/></notations>'
        rh = [((60,), 2, slur("start")), ((60,), 2, slur("stop"))]          # one strike, 4 beats
        m2 = ([((62,), 2), ((64,), 2), ((65,), 1)], [((48,), 4)])           # 5 beats in 4/4
        issues = []
        notes = parse_piano_score(grand_xml([(rh, [((48,), 4)]), m2, (rh, [((48,), 4)])]), issues=issues)
        c4 = [n for n in notes if n["pitchMidi"] == 60]
        self.assertEqual([(n["measure"], n["durationBeat"]) for n in c4], [(1, 4), (3, 4)])
        self.assertEqual(issues, [{"measure": 2, "beats": 5.0, "expected": 4.0}])


if __name__ == "__main__":
    unittest.main()
