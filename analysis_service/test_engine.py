import io
import math
import unittest
import wave

import numpy as np

from .engine import analyze, measure_start_beats, parse_score, track


def score(pitches=(69, 71, 72, 74, 76)):
    measures = []
    for n, pitch in enumerate(pitches, 1):
        # Each measure contains one quarter note. Enough distinct onsets to score rhythm.
        step, octave = {69: ("A", 4), 71: ("B", 4), 72: ("C", 5), 74: ("D", 5), 76: ("E", 5)}[pitch]
        measures.append(f'<measure number="{n}"><attributes><divisions>1</divisions></attributes>'
                        f'<note><pitch><step>{step}</step><octave>{octave}</octave></pitch>'
                        '<duration>1</duration></note></measure>')
    return '<score-partwise><part id="P1">' + ''.join(measures) + '</part></score-partwise>'


def recording(pitches=(69, 71, 72, 74, 76), detune=0, offsets=None):
    rate = 22050
    audio = np.zeros(int((len(pitches) + 0.25) * rate), dtype=np.float32)
    for index, midi in enumerate(pitches):
        start = int((0.12 + index + (offsets[index] if offsets else 0)) * rate)
        length = int(.78 * rate)
        t = np.arange(length) / rate
        hz = 440 * 2 ** ((midi + detune / 100 - 69) / 12)
        envelope = np.minimum(1, t * 60) * np.minimum(1, (length / rate - t) * 30)
        audio[start:start + length] = 0.32 * envelope * np.sin(2 * math.pi * hz * t)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
        wav.writeframes((audio * 32767).astype("<i2").tobytes())
    return output.getvalue()


def continuous_recording(midi=69, seconds=5.25):
    rate = 22050
    t = np.arange(int(seconds * rate)) / rate
    audio = np.zeros_like(t, dtype=np.float32)
    active = t >= .12
    audio[active] = .32 * np.sin(2 * math.pi * 440 * 2 ** ((midi - 69) / 12) * t[active])
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
        wav.writeframes((audio * 32767).astype("<i2").tobytes())
    return output.getvalue()


class EngineTests(unittest.TestCase):
    def test_parse_single_voice_and_reject_chords(self):
        self.assertEqual(len(parse_score(score())), 5)
        xml = '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' + score()
        self.assertEqual(len(parse_score(xml)), 5)
        with self.assertRaisesRegex(ValueError, "双音"):
            parse_score(score().replace("<note><pitch>", "<note><chord/><pitch>", 1))

    def test_differentiate_intonation_and_stable_rhythm(self):
        clean = analyze(recording(), score(), 60, "violin")
        sharp = analyze(recording(detune=65), score(), 60, "violin")
        self.assertGreaterEqual(clean["summary"]["voicedNotes"], 4)
        self.assertGreater(clean["summary"]["pitchScore"], sharp["summary"]["pitchScore"] + 20)
        self.assertIsNotNone(clean["summary"]["rhythmScore"])
        self.assertEqual(len(clean["notes"]), 5)

    def test_short_recording_scores_only_the_covered_excerpt(self):
        result = analyze(recording((69,)), score(), 60, "violin")
        self.assertEqual(result["summary"]["noteCount"], 1)
        self.assertEqual(result["summary"]["endMeasure"], 1)
        self.assertIsNone(result["summary"]["rhythmScore"])

    def test_single_pyin_note_falls_back_to_builtin_tracker(self):
        result = analyze(recording((69,)), score(), 60, "violin",
                         pitch_notes=[(0.12, 0.9, 69.0)])
        self.assertEqual(result["summary"]["noteCount"], 1)
        self.assertEqual(result["summary"]["sensors"], ["builtin"])

    def test_vamp_beat_without_beat_map_falls_back_to_legacy(self):
        result = analyze(recording(), score(), 60, "violin",
                         sync_mode="vamp-beat", beat_map=None)
        self.assertEqual(result["summary"]["syncMode"], "legacy")
        self.assertIsNone(result["summary"]["detectedBpm"])

    def test_start_from_later_measure(self):
        result = analyze(recording((72, 74, 76)), score(), 60, "violin", start_measure=3)
        self.assertEqual(result["summary"]["noteCount"], 3)
        self.assertEqual(result["summary"]["startMeasure"], 3)
        self.assertEqual(result["notes"][0]["measure"], 3)
        self.assertTrue(all(n["status"] == "correct" for n in result["notes"]))

    def test_decimal_accidentals_and_divisions(self):
        xml = score((69,)).replace("<divisions>1</divisions>", "<divisions>2.0</divisions>")
        xml = xml.replace("<step>A</step>", "<step>A</step><alter>-1.0</alter>")
        xml = xml.replace("<duration>1</duration>", "<duration>1.0</duration>")
        result = parse_score(xml)
        self.assertEqual(result[0]["pitchMidi"], 68)
        self.assertEqual(result[0]["durationBeat"], 0.5)
        with self.assertRaisesRegex(ValueError, "微分音"):
            parse_score(xml.replace("<alter>-1.0</alter>", "<alter>0.5</alter>"))

    def test_timing_variation_reduces_stability(self):
        steady = analyze(recording(), score(), 60, "violin")
        uneven = analyze(recording(offsets=(0, .16, -.13, .17, -.12)), score(), 60, "violin")
        self.assertIsNotNone(uneven["summary"]["rhythmScore"])
        self.assertGreater(steady["summary"]["rhythmScore"], uneven["summary"]["rhythmScore"])

    def test_pitch_score_penalizes_a_substantial_wrong_note_minority(self):
        target = score((69, 69, 69, 69, 69))
        clean = analyze(recording((69, 69, 69, 69, 69)), target, 60, "violin")
        wrong = analyze(recording((69, 69, 69, 71, 71)), target, 60, "violin")
        self.assertEqual(wrong["summary"]["wrongPitchNotes"], 2)
        self.assertEqual(wrong["summary"]["correctPitchNotes"], 3)
        self.assertGreater(clean["summary"]["pitchScore"], wrong["summary"]["pitchScore"] + 30)
        self.assertEqual([n["pitchStatus"] for n in wrong["notes"]][-2:], ["sharp", "sharp"])

    def test_intonation_detail_is_unavailable_when_every_pitch_is_wrong(self):
        target = score((69, 69, 69, 69, 69))
        wrong = analyze(recording((71, 71, 71, 71, 71)), target, 60, "violin")
        self.assertEqual(wrong["summary"]["wrongPitchNotes"], 5)
        self.assertIsNone(wrong["summary"]["intonationScore"])

    def test_consistent_lateness_reduces_timing_accuracy_not_stability(self):
        steady = analyze(recording(), score(), 60, "violin")
        late = analyze(recording(offsets=(0, .16, .16, .16, .16)), score(), 60, "violin")
        self.assertGreater(late["summary"]["timingOffsetMs"], 120)
        self.assertGreaterEqual(late["summary"]["rhythmStabilityScore"], 95)
        self.assertGreater(steady["summary"]["rhythmScore"], late["summary"]["rhythmScore"] + 30)
        self.assertTrue(all(n["timingStatus"] == "late" for n in late["notes"][1:]))

    def test_sustained_tone_does_not_claim_repeated_onsets_are_correct(self):
        result = analyze(continuous_recording(), score((69, 69, 69, 69, 69)), 60, "violin")
        self.assertEqual(result["summary"]["timedNotes"], 0)
        self.assertIsNone(result["summary"]["rhythmScore"])
        self.assertTrue(all(n["status"] == "timing_uncertain" for n in result["notes"][1:]))

    def test_pitch_tracker_covers_declared_range_and_uses_93ms_window(self):
        rate = 22050
        t = np.arange(rate) / rate
        for midi in (36, 69, 84, 88, 96):
            signal = .3 * np.sin(2 * math.pi * 440 * 2 ** ((midi - 69) / 12) * t)
            times, pitches, _, _ = track(signal, rate)
            self.assertAlmostEqual(float(np.nanmedian(pitches)), midi, delta=.12)
            self.assertAlmostEqual(float(times[0]), .093 / 2, delta=.001)

    def test_measure_downbeats_include_rest_measures(self):
        self.assertEqual(measure_start_beats(score()), {1: 0.0, 2: 1.0, 3: 2.0, 4: 3.0, 5: 4.0})

    def test_metronome_anchor_survives_leading_silence(self):
        # Same audio through two different anchors must land on different timelines.
        early = analyze(recording((72, 74, 76)), score(), 60, "violin",
                        start_measure=3, first_beat_audio_sec=0.5, sync_mode="metronome")
        late = analyze(recording((72, 74, 76)), score(), 60, "violin",
                       start_measure=3, first_beat_audio_sec=1.5, sync_mode="metronome")
        self.assertEqual(early["summary"]["syncMode"], "metronome")
        self.assertEqual(early["summary"]["noteCount"], 3)
        self.assertAlmostEqual(early["notes"][0]["expectedSec"] + 1.0, late["notes"][0]["expectedSec"], places=2)
        self.assertIsNotNone(early["summary"]["estimatedLatencyMs"])
        self.assertLessEqual(abs(early["summary"]["estimatedLatencyMs"]), 150)

    def test_metronome_anchor_rejects_bad_input(self):
        with self.assertRaisesRegex(ValueError, "0–20"):
            analyze(recording(), score(), 60, "violin", first_beat_audio_sec=21, sync_mode="metronome")
        with self.assertRaisesRegex(ValueError, "需要 firstBeatAudioSec"):
            analyze(recording(), score(), 60, "violin", sync_mode="metronome")
        with self.assertRaisesRegex(ValueError, "不应携带"):
            analyze(recording(), score(), 60, "violin", first_beat_audio_sec=0.5, sync_mode="legacy")

    def test_leading_rest_does_not_shift_first_pitched_note(self):
        from .omr import restore_first_rest
        xml = restore_first_rest(score(), 4)
        result = analyze(recording(), xml, 60, "violin")
        self.assertEqual(result["notes"][0]["measure"], 2)
        self.assertLess(result["notes"][0]["expectedSec"], 0.3)
        self.assertEqual(result["summary"]["measureCount"], 6)


if __name__ == "__main__":
    unittest.main()
