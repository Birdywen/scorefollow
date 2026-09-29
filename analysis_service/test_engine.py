import io
import math
import unittest
import wave

import numpy as np

from .engine import analyze, classify_pitch, measure_start_beats, parse_score, seconds_per_quarter, track


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


def compound_score(pitches=(69, 71, 72, 74, 76, 77)):
    notes = "".join(
        f'<note><pitch><step>{step}</step><octave>{octave}</octave></pitch>'
        '<duration>1</duration><type>eighth</type></note>'
        for pitch in pitches
        for step, octave in [{69: ("A", 4), 71: ("B", 4), 72: ("C", 5),
                              74: ("D", 5), 76: ("E", 5), 77: ("F", 5)}[pitch]]
    )
    return '<score-partwise><part id="P1"><measure number="1">' \
        '<attributes><divisions>2</divisions><time><beats>6</beats>' \
        '<beat-type>8</beat-type></time></attributes>' + notes + \
        '</measure></part></score-partwise>'


class EngineTests(unittest.TestCase):
    def test_compound_meter_uses_dotted_quarter_tempo(self):
        xml = compound_score()
        self.assertAlmostEqual(seconds_per_quarter(xml, 112), 60 / 112 * 2 / 3)
        self.assertAlmostEqual(seconds_per_quarter(score(), 112), 60 / 112)

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

    def test_octave_error_is_uncertain_not_wrong(self):
        # 演奏高八度(A4)而谱面写低八度(A3): 音名对、八度错是跟踪器局限, 不得计错音。
        xml = ('<score-partwise><part id="P1"><measure number="1">'
               '<attributes><divisions>1</divisions></attributes>'
               '<note><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration></note>'
               '</measure></part></score-partwise>')
        result = analyze(recording((69,)), xml, 60, "cello")
        self.assertEqual(result["notes"][0]["pitchStatus"], "octave")
        self.assertEqual(result["notes"][0]["status"], "octave_uncertain")
        self.assertEqual(result["summary"]["wrongPitchNotes"], 0)
        self.assertEqual(result["summary"]["octaveUncertainNotes"], 1)

    def test_classify_pitch_uses_cents_and_physics_range(self):
        self.assertEqual(classify_pitch(None, None), "uncertain")
        self.assertEqual(classify_pitch(0.0, 69.0), "correct")
        self.assertEqual(classify_pitch(50.0, 69.0), "correct")
        self.assertEqual(classify_pitch(51.0, 69.0), "sharp")
        self.assertEqual(classify_pitch(-51.0, 69.0), "flat")
        self.assertEqual(classify_pitch(1200.0, 69.0), "octave")
        self.assertEqual(classify_pitch(-1190.0, 48.0 - 11.9), "octave")
        # 大提琴最低 C2=36: 实测低于此是次谐波误判, 不得计错音。
        self.assertEqual(classify_pitch(-1866.0, 35.3), "uncertain")
        self.assertEqual(classify_pitch(1300.0, 97.0), "uncertain")

    def test_shift_slide_does_not_count_as_wrong(self):
        # E3 滑到 G3(差 3 半音): 前 0.15s 是滑音, 稳定段是准的, 应判 correct。
        rate = 22050
        pre, glide, hold = int(0.6 * rate), int(0.15 * rate), int(1.2 * rate)
        t = np.arange(pre + glide + hold) / rate
        freq = np.concatenate([np.full(pre, 440 * 2 ** ((52 - 69) / 12)),
                               np.linspace(440 * 2 ** ((52 - 69) / 12), 440 * 2 ** ((55 - 69) / 12), glide),
                               np.full(hold, 440 * 2 ** ((55 - 69) / 12))])
        audio = np.zeros(int(2.4 * rate), dtype=np.float32)
        start = int(0.12 * rate)
        audio[start:start + len(t)] = 0.32 * np.sin(2 * math.pi * np.cumsum(freq) / rate)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
            wav.writeframes((audio * 32767).astype("<i2").tobytes())
        xml = ('<score-partwise><part id="P1">'
               '<measure number="1"><attributes><divisions>1</divisions></attributes>'
               '<note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration></note></measure>'
               '<measure number="2">'
               '<note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration></note>'
               '</measure></part></score-partwise>')
        result = analyze(output.getvalue(), xml, 60, "cello")
        self.assertEqual(result["notes"][1]["pitchStatus"], "correct")
        self.assertEqual(result["summary"]["wrongPitchNotes"], 0)

    def test_grace_notes_are_skipped_not_rejected(self):
        xml = score().replace("<note><pitch>", "<note><grace slash=\"yes\"/><pitch><step>G</step><octave>4</octave></pitch></note><note><pitch>", 1)
        notes = parse_score(xml)
        self.assertEqual(len(notes), 5)
        self.assertEqual(notes[0]["pitchMidi"], 69)
        starts = measure_start_beats(xml)
        self.assertEqual(starts[1], 0.0)

    def test_mid_piece_meter_change_is_rejected(self):
        xml = score().replace('<measure number="1"><attributes><divisions>1</divisions></attributes>',
                              '<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>', 1)
        xml = xml.replace('<measure number="3"><attributes><divisions>1</divisions></attributes>',
                          '<measure number="3"><attributes><divisions>1</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes>', 1)
        with self.assertRaisesRegex(ValueError, "变拍"):
            parse_score(xml)

    def test_garbage_time_signature_is_rejected(self):
        xml = score().replace("<divisions>1</divisions>", "<divisions>1</divisions><time><beats>x</beats><beat-type>4</beat-type></time>", 1)
        with self.assertRaisesRegex(ValueError, "拍号"):
            seconds_per_quarter(xml, 112)

    def test_clipping_is_flagged_in_summary(self):
        data = recording()
        rate, buf = 22050, io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setparams((1, 2, rate, 22050, "NONE", "not compressed"))
            wav.writeframes((np.full(22050, 32767, dtype=np.int16)).tobytes())
        loud = analyze(buf.getvalue(), score((69,)), 60, "violin")
        self.assertTrue(loud["summary"]["clipped"])
        clean = analyze(data, score(), 60, "violin")
        self.assertFalse(clean["summary"]["clipped"])

    def test_leading_rest_does_not_shift_first_pitched_note(self):
        from .omr import restore_first_rest
        xml = restore_first_rest(score(), 4)
        result = analyze(recording(), xml, 60, "violin")
        self.assertEqual(result["notes"][0]["measure"], 2)
        self.assertLess(result["notes"][0]["expectedSec"], 0.3)
        self.assertEqual(result["summary"]["measureCount"], 6)


if __name__ == "__main__":
    unittest.main()
