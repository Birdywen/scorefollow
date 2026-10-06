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


def rest_note_score(pitches=(69, 72, 74, 76)):
    # 每小节 = 四分休止 + 四分音符 (2/4)，第一个发声在小节第 2 拍。
    names = {69: ("A", 4), 71: ("B", 4), 72: ("C", 5), 74: ("D", 5), 76: ("E", 5)}
    measures = []
    for n, pitch in enumerate(pitches, 1):
        step, octave = names[pitch]
        attrs = ('<attributes><divisions>1</divisions><time><beats>2</beats>'
                 '<beat-type>4</beat-type></time></attributes>') if n == 1 else ''
        measures.append(f'<measure number="{n}">{attrs}<note><rest/><duration>1</duration></note>'
                        f'<note><pitch><step>{step}</step><octave>{octave}</octave></pitch>'
                        '<duration>1</duration></note></measure>')
    return '<score-partwise><part id="P1">' + ''.join(measures) + '</part></score-partwise>'


def timed_recording(events, seconds):
    rate = 22050
    audio = np.zeros(int(seconds * rate), dtype=np.float32)
    for start_sec, midi in events:
        start = int(start_sec * rate)
        length = int(.78 * rate)
        t = np.arange(length) / rate
        hz = 440 * 2 ** ((midi - 69) / 12)
        envelope = np.minimum(1, t * 60) * np.minimum(1, (length / rate - t) * 30)
        audio[start:start + length] = 0.32 * envelope * np.sin(2 * math.pi * hz * t)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
        wav.writeframes((audio * 32767).astype("<i2").tobytes())
    return output.getvalue()


LEGATO_NAMES = {69: ("A", 4), 71: ("B", 4), 72: ("C", 5), 74: ("D", 5), 76: ("E", 5)}


def legato_score(pitches):
    measures = []
    for m in range(0, len(pitches), 4):
        attrs = ('<attributes><divisions>1</divisions><time><beats>4</beats>'
                 '<beat-type>4</beat-type></time></attributes>') if m == 0 else ''
        body = ''.join('<note><pitch><step>%s</step><octave>%d</octave></pitch>'
                       '<duration>1</duration></note>' % LEGATO_NAMES[x] for x in pitches[m:m + 4])
        measures.append('<measure number="%d">%s%s</measure>' % (m // 4 + 1, attrs, body))
    return '<score-partwise><part id="P1">' + ''.join(measures) + '</part></score-partwise>'


def legato_recording(pitches, spacing):
    # 音与音之间无空隙的连奏, spacing 秒一个音。
    rate = 22050
    audio = np.zeros(int((0.12 + len(pitches) * spacing + 0.3) * rate), dtype=np.float32)
    n = int(spacing * rate)
    t = np.arange(n) / rate
    envelope = np.minimum(1, t * 60) * np.minimum(1, (spacing - t) * 80)
    for i, midi in enumerate(pitches):
        s = int((0.12 + i * spacing) * rate)
        audio[s:s + n] += 0.32 * envelope * np.sin(2 * math.pi * 440 * 2 ** ((midi - 69) / 12) * t)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return output.getvalue()


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

    def test_key_signature_applies_to_bare_notes(self):
        # D 大调: 无 alter 的 F/C 按 F#/C# 读。
        xml = ('<score-partwise><part id="P1">'
               '<measure number="1"><attributes><divisions>1</divisions>'
               '<key><fifths>2</fifths></key></attributes>'
               '<note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration></note>'
               '<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note>'
               '<note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note>'
               '</measure></part></score-partwise>')
        result = parse_score(xml)
        self.assertEqual([n["pitchMidi"] for n in result], [66, 73, 67])

    def test_explicit_natural_carries_within_measure_then_key_returns(self):
        # 同小节内还原号延续, 过小节线回到调号。
        xml = ('<score-partwise><part id="P1">'
               '<measure number="1"><attributes><divisions>1</divisions>'
               '<key><fifths>2</fifths></key></attributes>'
               '<note><pitch><step>F</step><alter>0</alter><octave>4</octave></pitch><duration>1</duration></note>'
               '<note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration></note>'
               '</measure><measure number="2">'
               '<note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration></note>'
               '</measure></part></score-partwise>')
        result = parse_score(xml)
        self.assertEqual([n["pitchMidi"] for n in result], [65, 65, 66])

    def test_mid_piece_key_change(self):
        xml = ('<score-partwise><part id="P1">'
               '<measure number="1"><attributes><divisions>1</divisions></attributes>'
               '<note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration></note>'
               '</measure><measure number="2"><attributes>'
               '<key><fifths>1</fifths></key></attributes>'
               '<note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration></note>'
               '</measure></part></score-partwise>')
        result = parse_score(xml)
        self.assertEqual([n["pitchMidi"] for n in result], [65, 66])

    def test_invalid_key_signature_is_rejected(self):
        xml = score((69,)).replace("<divisions>1</divisions>",
                                    "<divisions>1</divisions><key><fifths>8</fifths></key>")
        with self.assertRaisesRegex(ValueError, "调号"):
            parse_score(xml)

    def test_key_signature_end_to_end_scores_matching_audio(self):
        # 回归用户场景: D 大调谱 + 对应录音, 不应再大面积错音。
        xml = ('<score-partwise><part id="P1">'
               '<measure number="1"><attributes><divisions>1</divisions>'
               '<key><fifths>2</fifths></key></attributes>'
               + "".join(f'<note><pitch><step>{s}</step><octave>4</octave></pitch><duration>1</duration></note>'
                           for s in ("D", "E", "F", "G", "A")) +
               '</measure></part></score-partwise>')
        result = analyze(recording((62, 64, 66, 67, 69)), xml, 60, "violin")
        self.assertTrue(all(n["status"] == "correct" for n in result["notes"]))

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

    def test_vamp_beat_later_measure_with_leading_rest_keeps_grid_phase(self):
        # 指定起始小节且该小节以休止开头: 首个发声对齐的是首个谱面音符, 不是小节线。
        audio = timed_recording([(0.12, 72), (2.12, 74), (4.12, 76)], 5.25)
        segments = [(0.13, 0.89, 72.0), (2.13, 2.89, 74.0), (4.13, 4.89, 76.0)]
        for pitch_notes in (None, segments):
            with self.subTest(pyin=pitch_notes is not None):
                result = analyze(audio, rest_note_score(), 60, "violin", start_measure=2,
                                 sync_mode="vamp-beat", pitch_notes=pitch_notes,
                                 beat_map=[0.12 + i for i in range(6)])
                self.assertEqual(result["summary"]["syncMode"], "vamp-beat")
                self.assertEqual(result["summary"]["noteCount"], 3)
                self.assertLess(abs(result["notes"][0]["expectedSec"] - 0.12), 0.05)
                self.assertEqual([n["status"] for n in result["notes"]], ["correct"] * 3)

    def test_vamp_beat_grid_with_wrong_beat_unit_falls_back_to_legacy(self):
        # 拍点跟踪器锁在双倍速: 网格单位不是四分音符, 不能拿它评分。
        segments = [(0.13 + i, 0.89 + i, float(m)) for i, m in enumerate((69, 71, 72, 74, 76))]
        for pitch_notes in (None, segments):
            with self.subTest(pyin=pitch_notes is not None):
                result = analyze(recording(), score(), 60, "violin", sync_mode="vamp-beat",
                                 pitch_notes=pitch_notes, beat_map=[0.12 + 0.5 * i for i in range(11)])
                self.assertEqual(result["summary"]["syncMode"], "legacy")
                self.assertTrue(result["summary"]["tempoMismatch"])
                self.assertEqual(result["summary"]["detectedBpm"], 120.0)
                self.assertEqual([n["status"] for n in result["notes"]], ["correct"] * 5)

    def test_vamp_beat_grid_near_panel_tempo_is_kept(self):
        result = analyze(recording(), score(), 60, "violin", sync_mode="vamp-beat",
                         beat_map=[0.12 + i for i in range(6)])
        self.assertEqual(result["summary"]["syncMode"], "vamp-beat")
        self.assertFalse(result["summary"]["tempoMismatch"])

    def _compound_audio(self, eighth_sec):
        rate = 22050
        audio = np.zeros(int((6 * eighth_sec + 0.5) * rate), dtype=np.float32)
        for index, midi in enumerate((69, 71, 72, 74, 76, 77)):
            start = int((0.12 + index * eighth_sec) * rate)
            length = int(0.9 * eighth_sec * rate)
            t = np.arange(length) / rate
            hz = 440 * 2 ** ((midi - 69) / 12)
            envelope = np.minimum(1, t * 60) * np.minimum(1, (length / rate - t) * 30)
            audio[start:start + length] = 0.32 * envelope * np.sin(2 * math.pi * hz * t)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
            wav.writeframes((audio * 32767).astype("<i2").tobytes())
        segments = [(0.12 + i * eighth_sec, 0.12 + (i + 0.92) * eighth_sec, float(m))
                    for i, m in enumerate((69, 71, 72, 74, 76, 77))]
        return output.getvalue(), segments

    def test_vamp_beat_compound_meter_selects_quarter_pulse(self):
        # 用户实案：6/8 慢速四分脉冲，面板按四分口径填 108。r=1.5 进二选一，
        # 起音证据必须投给 1:1，锁住且全对，detectedBpm 与面板同口径。
        wav_bytes, segments = self._compound_audio(60 / 108 / 2)
        beats = [0.12 + (60 / 108) * i for i in range(6)]
        result = analyze(wav_bytes, compound_score(), 108, "violin", sync_mode="vamp-beat",
                         pitch_notes=segments, beat_map=beats)
        self.assertEqual(result["summary"]["syncMode"], "vamp-beat")
        self.assertFalse(result["summary"]["tempoMismatch"])
        self.assertAlmostEqual(result["summary"]["detectedBpm"], 108.0, delta=2)
        self.assertEqual([n["status"] for n in result["notes"]], ["correct"] * 6)

    def test_vamp_beat_compound_meter_selects_dotted_pulse(self):
        # 6/8 快速附点脉冲，面板附点口径 120：r=1.5 进二选一，证据投给 /1.5。
        wav_bytes, segments = self._compound_audio(60 / 120 / 1.5 / 2)
        beats = [0.12 + 0.5 * i for i in range(4)]
        result = analyze(wav_bytes, compound_score(), 120, "violin", sync_mode="vamp-beat",
                         pitch_notes=segments, beat_map=beats)
        self.assertEqual(result["summary"]["syncMode"], "vamp-beat")
        self.assertFalse(result["summary"]["tempoMismatch"])
        self.assertAlmostEqual(result["summary"]["detectedBpm"], 120.0, delta=1)
        self.assertEqual([n["status"] for n in result["notes"]], ["correct"] * 6)

    def test_vamp_beat_compound_meter_rejects_garbage_pulse(self):
        # 6/8 里出现 0.9s 脉冲 (r=2.7)：两种读法都对不上，必须退回并标出。
        wav_bytes, _ = self._compound_audio(60 / 108 / 2)
        result = analyze(wav_bytes, compound_score(), 108, "violin", sync_mode="vamp-beat",
                         beat_map=[0.12 + 0.9 * i for i in range(4)])
        self.assertEqual(result["summary"]["syncMode"], "legacy")
        self.assertTrue(result["summary"]["tempoMismatch"])

    def test_steady_slow_tempo_is_reported_as_late_not_wrong_pitch(self):
        # 连奏音阶整体慢 5%/10%: 误差逐音累积, 不能把速度问题判成错音。
        pitches = [69, 71, 72, 74, 76, 74, 72, 71] * 2
        for slow in (1.05, 1.10):
            with self.subTest(slow=slow):
                result = analyze(legato_recording(pitches, 0.5 * slow), legato_score(pitches), 120, "violin")
                statuses = [n["status"] for n in result["notes"]]
                self.assertEqual(statuses.count("wrong_pitch"), 0, statuses)
                self.assertGreaterEqual(result["summary"]["pitchScore"], 90)
                late = sum(n["timingStatus"] == "late" for n in result["notes"])
                self.assertGreaterEqual(late, 5, statuses)

    def test_semitone_legato_onsets_are_detected(self):
        # 半音连奏 (B<->C) 2 帧音高差只有 ~0.8 半音, 低于 0.85 阈值, 起音漏检 (#11)。
        pitches = [69, 71, 72, 74, 76, 74, 72, 71] * 2
        result = analyze(legato_recording(pitches, 0.5), legato_score(pitches), 120, "violin")
        statuses = [n["status"] for n in result["notes"]]
        self.assertEqual(statuses.count("timing_uncertain"), 0, statuses)
        self.assertEqual(result["summary"]["timedNotes"], len(pitches) - 1)

    def test_steady_slow_tempo_costs_accuracy_not_stability(self):
        # 稳定地慢: 扣准确度, 不扣稳定性 (产品决定 2026-10-01)。
        pitches = [69, 71, 72, 74, 76, 74, 72, 71] * 2
        steady = analyze(legato_recording(pitches, 0.5), legato_score(pitches), 120, "violin")["summary"]
        slow = analyze(legato_recording(pitches, 0.5 * 1.05), legato_score(pitches), 120, "violin")["summary"]
        self.assertGreaterEqual(slow["rhythmStabilityScore"], 85)
        self.assertLessEqual(slow["timingAccuracyScore"], steady["timingAccuracyScore"] - 20)

    def test_large_timing_errors_are_scored_not_dropped(self):
        # 幸存者偏差 (#5): ±300 ms 的偏差落在 ±220 ms 搜索窗外, 被记成 timing_uncertain,
        # 节奏越乱可判起音越少, 最终不出分。偏差大的音必须计入节奏统计。
        result = analyze(recording(offsets=(0, .3, .3, -.3, -.3)), score(), 60, "violin")
        summary = result["summary"]
        statuses = [n["status"] for n in result["notes"]]
        self.assertEqual(summary["timedNotes"], 4, statuses)
        self.assertIsNotNone(summary["rhythmScore"])
        self.assertEqual(statuses.count("wrong_pitch"), 0, statuses)
        self.assertEqual([n["timingStatus"] for n in result["notes"][1:]], ["late", "late", "early", "early"])

    def test_quiet_recording_is_analyzed_like_a_normal_one(self):
        # 绝对能量阈值 (#6): 峰值 0.012 (-38 dBFS) 的录音报"无法检测到演奏", 且 0.02~0.32 间
        # 节奏分随电平漂移。结果必须与录音电平无关, 低电平也不能被标成削波。
        pitches = [69, 71, 72, 74, 76, 74, 72, 71] * 2
        xml = legato_score(pitches)
        loud_wav = legato_recording(pitches, 0.5)
        with wave.open(io.BytesIO(loud_wav)) as w:
            params = w.getparams()
            pcm = np.frombuffer(w.readframes(params.nframes), dtype="<i2").astype(np.float32)
        output = io.BytesIO()
        with wave.open(output, "wb") as w:
            w.setparams(params)
            w.writeframes(np.round(pcm * (0.012 / 0.32)).astype("<i2").tobytes())
        loud = analyze(loud_wav, xml, 120, "violin")["summary"]
        quiet = analyze(output.getvalue(), xml, 120, "violin")["summary"]
        self.assertEqual(quiet["voicedNotes"], loud["voicedNotes"])
        self.assertEqual(quiet["timedNotes"], loud["timedNotes"])
        self.assertEqual(quiet["pitchScore"], loud["pitchScore"])
        self.assertLessEqual(abs(quiet["rhythmScore"] - loud["rhythmScore"]), 3)
        self.assertFalse(quiet["clipped"])

    def test_missing_note_with_pyin_hint_is_uncertain_not_wrong_pitch(self):
        # 漏奏 (#7): pYIN 段间静音曾被填上邻音音高 (置信 0.9), 漏奏的音判成 +200 音分错音。
        audio = recording()
        with wave.open(io.BytesIO(audio)) as w:
            params = w.getparams()
            pcm = np.frombuffer(w.readframes(params.nframes), dtype="<i2").copy()
        pcm[int(2.05 * 22050):int(3.05 * 22050)] = 0
        output = io.BytesIO()
        with wave.open(output, "wb") as w:
            w.setparams(params)
            w.writeframes(pcm.tobytes())
        segments = [(0.13 + i, 0.89 + i, float(m)) for i, m in enumerate((69, 71, 72, 74, 76)) if i != 2]
        result = analyze(output.getvalue(), score(), 60, "violin", pitch_notes=segments)
        self.assertEqual([n["status"] for n in result["notes"]],
                         ["correct", "correct", "uncertain", "correct", "correct"])

    def test_unsorted_pitch_hint_is_rejected_without_auto_location(self):
        # 指定小节路径也必须校验传感器事件 (#7), 与自动定位一致。
        segments = [(0.13 + i, 0.89 + i, float(m)) for i, m in enumerate((69, 71, 72, 74, 76))]
        with self.assertRaises(ValueError):
            analyze(recording(), score(), 60, "violin", pitch_notes=segments[::-1])

    def test_one_badly_timed_note_lowers_accuracy(self):
        # 中位数掩盖 (#9): 4 个计时音里 1 个 +400 ms, 中位数式准确度仍有 90; 必须明显扣分。
        steady = analyze(recording(), score(), 60, "violin")["summary"]
        one_bad = analyze(recording(offsets=(0, 0, 0, .4, 0)), score(), 60, "violin")["summary"]
        self.assertEqual(one_bad["timedNotes"], 4)
        self.assertGreaterEqual(steady["timingAccuracyScore"], 90)
        self.assertLessEqual(one_bad["timingAccuracyScore"], steady["timingAccuracyScore"] - 15)


if __name__ == "__main__":
    unittest.main()
