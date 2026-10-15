"""补救失败可诊断：每个移调尝试的真实结果进 summary.rescueAttempts（给用户的文案不变）。"""
import unittest
from unittest.mock import patch

import numpy as np

from .engine import OCTAVE_SEARCH_SHIFTS, analyze, _auto_measure_sync, parse_score
from .test_auto_rescue import PITCHES
from .test_engine import legato_recording, legato_score

REASONS = {"error", "boundary_unsupported", "unusable", "usable"}


class RescueAttemptsTests(unittest.TestCase):
    def test_failed_rescue_keeps_every_shift_reason(self):
        xml = legato_score(PITCHES)
        take = legato_recording([40, 41, 42, 43, 44, 45] * 3, 0.5)
        summary = analyze(take, xml, 120, "violin", start_measure=1)["summary"]
        self.assertFalse(summary["autoMeasureSync"])
        self.assertIn("手动小节同步", summary["syncAdvice"])
        attempts = summary.get("rescueAttempts")
        self.assertIsInstance(attempts, list)
        self.assertEqual([a["shift"] for a in attempts], list(OCTAVE_SEARCH_SHIFTS))
        for a in attempts:
            self.assertIn(a["reason"], REASONS)
            if a["reason"] == "error":
                self.assertTrue(a.get("detail"))

    def test_good_take_never_enters_rescue(self):
        summary = analyze(legato_recording(PITCHES, 0.5), legato_score(PITCHES),
                          120, "violin", start_measure=1)["summary"]
        self.assertNotIn("rescueAttempts", summary)


class RescueBpRoundTests(unittest.TestCase):
    """0.23: pYIN 事件对不上 (重复句/边界) 时救援用 BP 事件再试一轮。"""
    def test_bp_round_rescues_when_pyin_align_fails(self):
        played = [69, 71, 72, 74, 76, 76, 76, 76, 69, 69, 71, 71, 72, 74, 76, 74]
        xml = legato_score(played)
        score_notes = parse_score(xml)
        # pYIN 事件整体错位 (锚点门直接筛掉, 三 shift 全败)。
        bad_pyin = [(i * 0.5, i * 0.5 + 0.4, 40.0) for i in range(16)]
        # BP 事件干净 (0.5 s/拍, 与谱面四分音符对齐)。
        good_bp = [(i * 0.5, i * 0.5 + 0.4, float(played[i])) for i in range(8)]
        times = np.arange(0, 8.5, 0.012)
        energy = np.ones_like(times)
        pitches = np.full_like(times, 440.0)
        onsets = [0.1 + i * 0.5 for i in range(16)]
        with patch("analysis_service.engine._bp_locate_events", return_value=good_bp):
            plan = _auto_measure_sync(
                xml=xml, notes=score_notes, times=times, pitches=pitches,
                energy=energy, sec_per_beat=60.0 / 200, duration_sec=8.5,
                requested_start=1, score_last=4, rigid_start=0.0,
                onsets=onsets, pitch_notes=bad_pyin,
                signal=np.zeros(8), rate=22050)
        self.assertTrue(plan["markers"], plan.get("advice"))
        self.assertIn("tempo", plan["reasons"])
        tags = [a.get("events") for a in plan["attempts"]]
        self.assertIn("pyin", tags)
        self.assertIn("bp", tags)

    def test_bp_round_miss_keeps_pyin_advice(self):
        played = [69, 71, 72, 74, 76, 76, 76, 76, 69, 69, 71, 71, 72, 74, 76, 74]
        xml = legato_score(played)
        score_notes = parse_score(xml)
        bad = [(i * 0.5, i * 0.5 + 0.4, 40.0) for i in range(16)]
        times = np.arange(0, 8.5, 0.012)
        energy = np.ones_like(times)
        pitches = np.full_like(times, 440.0)
        onsets = [0.1 + i * 0.5 for i in range(16)]
        with patch("analysis_service.engine._bp_locate_events", return_value=None):
            plan = _auto_measure_sync(
                xml=xml, notes=score_notes, times=times, pitches=pitches,
                energy=energy, sec_per_beat=60.0 / 200, duration_sec=8.5,
                requested_start=1, score_last=4, rigid_start=0.0,
                onsets=onsets, pitch_notes=bad,
                signal=np.zeros(8), rate=22050)
        self.assertFalse(plan["markers"])
        self.assertTrue(plan["advice"])


if __name__ == "__main__":
    unittest.main()
