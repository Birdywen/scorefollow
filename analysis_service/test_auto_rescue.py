"""自动对齐补救回归：八度错位 / 速度错位 / 中途停顿 / 无传感器定位。

约定：补救只在刚性网格解释失败时触发（好片段零行为变化）；触发后
summary 必带 autoMeasureSync/octaveShift/rescueReasons/detectedBpm，
失败时必带 syncAdvice（绝不静默零分）。
"""
import unittest

import numpy as np

from .engine import analyze
from .test_engine import legato_recording, legato_score

PITCHES = [69, 71, 72, 74, 76, 74, 72, 71] * 2


def _gapped_recording(pitches, spacing, gap_after, gap_sec):
    """第 gap_after 个音后插入 gap_sec 秒静音（中途停顿），其余连奏。"""
    import io
    import wave

    import numpy as np

    rate = 22050
    starts = []
    t = 0.12
    for i in range(len(pitches)):
        starts.append(t)
        t += spacing
        if i == gap_after:
            t += gap_sec
    audio = np.zeros(int((t + 0.3) * rate), dtype=np.float32)
    n = int(spacing * rate)
    frame = np.arange(n) / rate
    envelope = np.minimum(1, frame * 60) * np.minimum(1, (spacing - frame) * 80)
    for s, midi in zip(starts, pitches):
        o = int(s * rate)
        audio[o:o + n] += 0.32 * envelope * np.sin(2 * np.pi * 440 * 2 ** ((midi - 69) / 12) * frame)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return output.getvalue()


class AutoRescueTests(unittest.TestCase):
    def test_octave_shifted_score_is_rescued(self):
        # 谱面整体高八度（Lully Gavotte 实案）：录音低八度演奏。
        # 刚性网格下音高全错（修复前 pitchScore 为空）；补救后按相对音高打分。
        xml = legato_score(PITCHES)
        take = legato_recording([p - 12 for p in PITCHES], 0.5)
        result = analyze(take, xml, 120, "violin", start_measure=1)
        summary = result["summary"]
        self.assertTrue(summary["autoMeasureSync"])
        self.assertEqual(summary["octaveShift"], -12)
        self.assertIn("octave", summary["rescueReasons"])
        self.assertGreaterEqual(summary["pitchScore"], 90)
        self.assertTrue(any("八度" in text for text in result["limitations"]))

    def test_wrong_panel_tempo_is_refit(self):
        # 面板 80、实测 ~128（比例 1.6 出带）：按实测重对齐而不是零分。
        xml = legato_score(PITCHES)
        take = legato_recording(PITCHES, 60 / 80 / 1.6)
        result = analyze(take, xml, 80, "violin", start_measure=1)
        summary = result["summary"]
        self.assertTrue(summary["autoMeasureSync"])
        self.assertIn("tempo", summary["rescueReasons"])
        self.assertAlmostEqual(summary["detectedBpm"], 128.0, delta=6)
        self.assertTrue(summary["tempoMismatch"])
        self.assertGreaterEqual(summary["pitchScore"], 90)
        self.assertGreaterEqual(summary["rhythmScore"] or 0, 60)

    def test_wrong_slow_panel_tempo_keeps_full_score_with_either_sensor(self):
        xml = legato_score(PITCHES)
        take = legato_recording(PITCHES, 60 / 80 / 1.6)
        events = [(.12 + i * .46875, .12 + (i + .9) * .46875, float(m))
                  for i, m in enumerate(PITCHES)]
        for sensor in (None, events):
            with self.subTest(sensor="builtin" if sensor is None else "external"):
                result = analyze(take, xml, 80, "violin", start_measure=1, pitch_notes=sensor)
                summary = result["summary"]
                self.assertTrue(summary["autoMeasureSync"])
                self.assertEqual(summary["noteCount"], len(PITCHES))
                self.assertEqual(summary["endMeasure"], 4)
                self.assertEqual(result["notes"][-1]["pitchMidi"], PITCHES[-1])
                self.assertEqual("fused-pitch" in summary["sensors"], sensor is not None)

    def test_partial_take_does_not_extrapolate_missing_score_measures(self):
        pitches = [69, 71, 72, 74, 76, 74, 71, 69, 72, 76, 71, 74, 69, 76, 72, 71]
        events = [(.12 + i * .5, .12 + (i + .9) * .5, float(m))
                  for i, m in enumerate(pitches[:10])]
        from .engine import _auto_measure_sync, parse_score
        plan = _auto_measure_sync(xml=legato_score(pitches), notes=parse_score(legato_score(pitches)),
                                  times=np.array([0., 5.4]), pitches=np.array([69., 76.]),
                                  energy=np.ones(2), sec_per_beat=.75, duration_sec=5.4,
                                  requested_start=1, score_last=4, rigid_start=.12,
                                  onsets=[.12], pitch_notes=events)
        self.assertIn("range", plan["reasons"])
        self.assertEqual([m["measure"] for m in plan["markers"]], [1, 2, 3])
        self.assertLess(plan["markers"][-1]["audioSec"], 5.0)

    def test_supported_mid_measure_crop_preserves_note_range_at_wrong_tempo(self):
        pitches = [69, 71, 72, 74, 76, 74, 71, 69, 72, 76, 71, 74, 69, 76, 72, 71]
        played = pitches[2:12]
        events = [(.12 + i * .5, .12 + (i + .9) * .5, float(m))
                  for i, m in enumerate(played)]
        for bpm in (80, 200):
            with self.subTest(bpm=bpm):
                result = analyze(legato_recording(played, .5), legato_score(pitches),
                                 bpm, "violin", start_measure=0, pitch_notes=events)
                self.assertTrue(result["summary"]["autoLocated"])
                self.assertFalse(result["summary"]["autoMeasureSync"])
                self.assertEqual(result["summary"]["startMeasure"], 1)
                self.assertEqual(result["summary"]["noteCount"], len(played))
                self.assertEqual(result["notes"][0]["pitchMidi"], played[0])

    def test_rejected_sensor_grid_refits_global_tempo_without_washing_wrong_notes(self):
        played = list(PITCHES)
        played[5] += 1
        played[13] += 1
        events = [(.12 + i * .5, .12 + (i + .9) * .5, float(m))
                  for i, m in enumerate(played)]
        result = analyze(legato_recording(played, .5), legato_score(PITCHES), 80,
                         "violin", start_measure=0, pitch_notes=events,
                         sync_mode="vamp-beat", beat_map=[.12 + i * .5 for i in range(17)])
        summary = result["summary"]
        self.assertTrue(summary["tempoMismatch"])
        self.assertIn("tempo", summary["rescueReasons"])
        self.assertAlmostEqual(summary["detectedBpm"], 120., delta=1.)
        self.assertEqual(summary["noteCount"], len(PITCHES))
        self.assertGreaterEqual(summary["wrongPitchNotes"], 2)
        self.assertLess(summary["pitchScore"], 100)

    def test_in_band_slow_tempo_stays_reported_as_late(self):
        # 带内慢 10% 是演奏偏差不是输入错误：必须照实报 late，不准补救。
        xml = legato_score(PITCHES)
        take = legato_recording(PITCHES, 0.5 * 1.10)
        result = analyze(take, xml, 120, "violin", start_measure=1)
        summary = result["summary"]
        self.assertFalse(summary["autoMeasureSync"])
        self.assertIsNone(summary["octaveShift"])
        self.assertGreaterEqual(summary["pitchScore"], 90)
        late = sum(n["timingStatus"] == "late" for n in result["notes"])
        self.assertGreaterEqual(late, 5)

    def test_big_pause_degrades_gracefully_without_rescue(self):
        # 中途 2 s 停顿但音高速度都对：刚性网本就能体面降级（离群点剔除 + 漂移
        # 跟随），不需要补救——补救只处理"解释失败"，不碰这种诚实的中等分。
        xml = legato_score(PITCHES)
        take = _gapped_recording(PITCHES, 0.5, 7, 2.0)
        result = analyze(take, xml, 120, "violin", start_measure=1)
        summary = result["summary"]
        self.assertFalse(summary["autoMeasureSync"])
        self.assertGreaterEqual(summary["pitchScore"], 80)
        self.assertGreaterEqual(summary["rhythmScore"] or 0, 70)

    def test_pause_reason_and_markers_unit(self):
        # 停顿补救 machinery 本体（白盒）：gap 证据 → pause 原因 + 单调连续 markers。
        import numpy as np

        from .engine import (_anchor_tempo, _auto_measure_sync, _interior_silence_gaps,
                             _usable_excerpt, detect_builtin_onsets, parse_score, read_wav,
                             segment_builtin_events, track, NORMALIZED_PEAK)
        from .alignment import align_excerpt

        xml = legato_score(PITCHES)
        take = _gapped_recording(PITCHES, 0.5, 7, 2.0)
        sig, rate = read_wav(take)
        # 与 analyze 一致：峰值归一化后再跟踪（能量门限是绝对值）。
        sig = (sig * (NORMALIZED_PEAK / float(np.max(np.abs(sig))))).astype(np.float32)
        times, pitches, energy, _ = track(sig, rate)
        onsets = detect_builtin_onsets(times, pitches, energy)
        events = segment_builtin_events(times, pitches, energy)
        notes = parse_score(xml)
        excerpt = align_excerpt(notes, events)
        self.assertTrue(_usable_excerpt(excerpt))
        gaps = _interior_silence_gaps(times, energy, onsets, float(times[-1]))
        self.assertTrue(any(b - a > 0.5 for a, b in gaps))
        # 全局斜率被停顿污染，分段锚点速度才是真速度。
        self.assertGreater(excerpt["quarterPeriod"], 0.6)
        self.assertAlmostEqual(_anchor_tempo(excerpt["anchors"], excerpt["quarterPeriod"]), 0.5, delta=0.05)
        plan = _auto_measure_sync(xml=xml, notes=notes, times=times, pitches=pitches,
                                  energy=energy, sec_per_beat=0.5,
                                  duration_sec=float(times[-1]),
                                  requested_start=1, score_last=4,
                                  rigid_start=onsets[0], onsets=onsets)
        self.assertIn("pause", plan["reasons"])
        self.assertNotIn("tempo", plan["reasons"])
        markers = plan["markers"]
        self.assertGreaterEqual(len(markers), 3)
        self.assertEqual([m["measure"] for m in markers], list(range(1, markers[-1]["measure"] + 1)))
        self.assertTrue(all(b["audioSec"] > a["audioSec"] for a, b in zip(markers, markers[1:])))

    def test_garbage_take_fails_with_advice_not_silence(self):
        # 毫不相关的录音：不对齐、不编分，但给出可操作的 advice。
        xml = legato_score(PITCHES)
        take = legato_recording([40, 41, 42, 43, 44, 45] * 3, 0.5)
        result = analyze(take, xml, 120, "violin", start_measure=1)
        summary = result["summary"]
        self.assertFalse(summary["autoMeasureSync"])
        self.assertIsNotNone(summary["syncAdvice"])
        self.assertIn("手动小节同步", summary["syncAdvice"])

    def test_auto_locate_works_without_external_sensor(self):
        # 无 pYIN 时退回内置分段定位（原来直接报错）。
        result = analyze(legato_recording(PITCHES, 0.5), legato_score(PITCHES),
                         120, "violin", start_measure=0)
        self.assertTrue(result["summary"]["autoLocated"])
        self.assertEqual(result["summary"]["startMeasure"], 1)
        self.assertGreaterEqual(result["summary"]["pitchScore"], 90)


if __name__ == "__main__":
    unittest.main()
