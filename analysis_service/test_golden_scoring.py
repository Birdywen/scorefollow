"""Golden-sample regression for ScoreFollow scoring accuracy.

Synthetic audio with declared ground truth, fixed tolerances, no external
recordings and no network. Calls the real scoring path
(analysis_service.engine.analyze) with a matching minimal MusicXML.
"""
import sys
import unittest
from unittest.mock import patch

import numpy as np

from . import vamp_features
from .engine import analyze
from .golden_fixtures import (
    LONG_NOTE_COUNT,
    RANDOM_SEED,
    build_clean,
    build_detuned,
    build_late,
    build_long,
)

# Tolerance: pitch cents. Autocorrelation tracker uses a ~93 ms Hann window
# with parabolic lag interpolation; pure-sine probes measure within ~1 cent,
# so 10 cents comfortably covers detector jitter while keeping a 60-cent
# detune (4x the 15-cent correct/sharp boundary) unambiguously separable.
PITCH_CENTS_TOL = 10.0

# Tolerance: per-note timing ms. Tracker hop is ~12 ms plus envelope attack
# and drift-median alignment; clean probes measure within ~13 ms and the
# 200 ms late probe within ~11 ms, so 40 ms covers detection jitter while
# staying below the 80 ms correct/late status boundary (clean max 13 + 40
# < 80 < 200 - 40), keeping the two classes separable.
TIMING_MS_TOL = 40.0

# Tolerance: clean pitch floor. Builtin autocorrelation on pure sines scores
# 100; 95 allows float/BLAS nondeterminism without hiding a real regression
# (a single 60-cent wrong note already drops the score to ~89).
CLEAN_PITCH_SCORE_MIN = 95

# Tolerance: clean rhythm floor. Clean probes measure 96 on the builtin
# onset detector; 90 allows small jitter while the 200 ms late variant at
# 91/86 stays distinguishable via the strict ordering assertion below.
CLEAN_RHYTHM_SCORE_MIN = 90

# Tolerance: minimum pitch drop for the detuned variant. A single
# 60-cent wrong note drops pitchScore 100 -> 89 (delta 11); requiring >= 5
# proves the penalty fires without overfitting the exact number.
DETUNE_PITCH_DROP_MIN = 5

# Tolerance: minimum timing-accuracy drop for the late variant. A single
# 200 ms late note drops timingAccuracy 96 -> 77 (delta 19); requiring
# >= 5 proves the penalty fires without overfitting the exact number.
LATE_ACCURACY_DROP_MIN = 5


def _by_id(notes, note_id):
    for note in notes:
        if note["id"] == note_id:
            return note
    raise AssertionError(f"missing note {note_id}")


def _require_vamp_plugins(testcase):
    """Skip guard for the live-vamp tests: skip only when vamp is genuinely
    unavailable (python bridge or plugin .so files missing), with an explicit
    reason. Never silently passes: once plugins are proven present, callers
    must assert on live detector output."""
    try:
        import vamp
    except ImportError:
        testcase.skipTest("vamp python bridge not installed")
    required = ("pyin:pyin", "qm-vamp-plugins:qm-onsetdetector",
                "qm-vamp-plugins:qm-barbeattracker")
    found = [p for p in vamp.list_plugins() if p in required]
    if len(found) < len(required):
        testcase.skipTest(f"vamp plugins unavailable, found={sorted(found)}")
    return vamp


class GoldenScoringTests(unittest.TestCase):
    def setUp(self):
        # Deterministic: no unseeded randomness anywhere in this module.
        np.random.seed(RANDOM_SEED)

    def test_clean_in_tune_on_time(self):
        fix = build_clean()
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        summary = result["summary"]
        self.assertGreaterEqual(summary["pitchScore"], CLEAN_PITCH_SCORE_MIN)
        self.assertGreaterEqual(summary["rhythmScore"], CLEAN_RHYTHM_SCORE_MIN)
        self.assertEqual(summary["wrongPitchNotes"], 0)
        self.assertEqual(summary["correctPitchNotes"], 5)
        for truth in fix["ground_truth"]:
            note = _by_id(result["notes"], truth["id"])
            self.assertIsNotNone(note["pitchErrorCents"])
            self.assertAlmostEqual(note["pitchErrorCents"], 0.0, delta=PITCH_CENTS_TOL)
            self.assertEqual(note["pitchStatus"], "correct")
            if truth["id"] == "n1":
                # First note is the time-zero anchor and is never timing-scored.
                self.assertIsNone(note["timingErrorMs"])
                continue
            self.assertIsNotNone(note["timingErrorMs"])
            self.assertAlmostEqual(note["timingErrorMs"], 0.0, delta=TIMING_MS_TOL)
            self.assertEqual(note["timingStatus"], "correct")

    def test_single_note_detuned(self):
        fix = build_detuned()
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        summary = result["summary"]
        target = _by_id(result["notes"], fix["detuned_note_id"])
        # Per-note intonation lands on the known cent offset.
        self.assertAlmostEqual(target["pitchErrorCents"], fix["detune_cents"], delta=PITCH_CENTS_TOL)
        self.assertEqual(target["pitchStatus"], "sharp")
        self.assertEqual(target["status"], "wrong_pitch")
        self.assertEqual(summary["wrongPitchNotes"], 1)
        self.assertEqual(summary["correctPitchNotes"], 4)
        # Untouched notes stay in tune.
        for note in result["notes"]:
            if note["id"] == fix["detuned_note_id"]:
                continue
            self.assertAlmostEqual(note["pitchErrorCents"], 0.0, delta=PITCH_CENTS_TOL)
            self.assertEqual(note["pitchStatus"], "correct")

    def test_short_startup_beat_does_not_shift_pitch_or_hide_wrong_notes(self):
        # A spurious pickup before the first note is not a full beat. Keep
        # the subsequent pulse spacing, and still penalize a real detuning.
        for build in (build_clean, build_detuned):
            fix = build()
            first = fix["ground_truth"][0]["scoreOnsetSec"]
            beats = [first - 0.1] + [first + 0.2 + i for i in range(8)]
            result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"],
                             sync_mode="vamp-beat", beat_map=beats)
            self.assertEqual(result["summary"]["syncMode"], "vamp-beat")
            for truth in fix["ground_truth"]:
                note = _by_id(result["notes"], truth["id"])
                self.assertAlmostEqual(note["pitchErrorCents"], truth["renderedDetuneCents"],
                                       delta=PITCH_CENTS_TOL)
            if build is build_detuned:
                self.assertEqual(_by_id(result["notes"], fix["detuned_note_id"])["pitchStatus"], "sharp")

    def test_single_note_late(self):
        fix = build_late()
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        target = _by_id(result["notes"], fix["late_note_id"])
        # Per-note timing lands on the known millisecond offset.
        self.assertIsNotNone(target["timingErrorMs"])
        self.assertAlmostEqual(target["timingErrorMs"], fix["late_offset_ms"], delta=TIMING_MS_TOL)
        self.assertEqual(target["timingStatus"], "late")
        self.assertEqual(target["status"], "late")
        # Untouched timed notes stay on time.
        for note in result["notes"]:
            if note["id"] in ("n1", fix["late_note_id"]):
                continue
            self.assertIsNotNone(note["timingErrorMs"])
            self.assertAlmostEqual(note["timingErrorMs"], 0.0, delta=TIMING_MS_TOL)

    def test_clean_scores_strictly_better_than_variants(self):
        clean = analyze(**{k: v for k, v in build_clean().items() if k in ("wav", "xml", "bpm", "instrument")})
        detuned = analyze(**{k: v for k, v in build_detuned().items() if k in ("wav", "xml", "bpm", "instrument")})
        late = analyze(**{k: v for k, v in build_late().items() if k in ("wav", "xml", "bpm", "instrument")})
        # Ordering, not just absolute numbers: the same engine must rank
        # clean above each degraded variant on the affected axis.
        self.assertGreater(
            clean["summary"]["pitchScore"],
            detuned["summary"]["pitchScore"] + (DETUNE_PITCH_DROP_MIN - 1),
        )
        self.assertGreaterEqual(
            clean["summary"]["pitchScore"] - detuned["summary"]["pitchScore"],
            DETUNE_PITCH_DROP_MIN,
        )
        self.assertIsNotNone(clean["summary"]["timingAccuracyScore"])
        self.assertIsNotNone(late["summary"]["timingAccuracyScore"])
        self.assertGreaterEqual(
            clean["summary"]["timingAccuracyScore"] - late["summary"]["timingAccuracyScore"],
            LATE_ACCURACY_DROP_MIN,
        )
        self.assertGreater(clean["summary"]["rhythmScore"], late["summary"]["rhythmScore"])

    def test_long_fixture_extract_all_sensors_fire(self):
        _require_vamp_plugins(self)
        fix = build_long()
        pitch, onsets, beats = vamp_features.extract_all(fix["wav"])
        # Plugins proven present above: every sensor must produce output.
        self.assertTrue(pitch, "pYIN returned no note segments on the long fixture")
        self.assertTrue(onsets, "QM onset detector returned no onsets on the long fixture")
        self.assertTrue(beats, "QM beat tracker returned no beats on the long fixture")

    def test_long_fixture_vamp_beat_is_not_degraded(self):
        _require_vamp_plugins(self)
        fix = build_long()
        pitch, onsets, beats = vamp_features.extract_all(fix["wav"])
        self.assertTrue(pitch and onsets and beats)
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"],
                         sync_mode="vamp-beat", pitch_notes=pitch,
                         onset_hint=onsets, beat_map=beats)
        summary = result["summary"]
        self.assertEqual(summary["syncMode"], "vamp-beat")
        self.assertFalse(summary["degraded"])
        self.assertEqual(summary["degradedReasons"], [])
        self.assertIn("fused-pitch", summary["sensors"])
        self.assertIn("qm-onset", summary["sensors"])
        self.assertEqual(summary["noteCount"], LONG_NOTE_COUNT)
        self.assertGreaterEqual(summary["pitchScore"], CLEAN_PITCH_SCORE_MIN)

    def test_builtin_degraded_when_vamp_absent(self):
        # Real import-failure path: `import vamp` raises, each extractor
        # returns None and the engine falls back to builtin detectors.
        with patch.dict(sys.modules, {"vamp": None}):
            pitch, onsets, beats = vamp_features.extract_all(build_clean()["wav"])
        self.assertIsNone(pitch)
        self.assertIsNone(onsets)
        self.assertIsNone(beats)
        for builder in (build_clean, build_detuned, build_late):
            fix = builder()
            result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
            summary = result["summary"]
            # Legacy builtin path: no fused/qm sensors, degradation explicit.
            self.assertEqual(summary["syncMode"], "legacy")
            self.assertEqual(summary["sensors"], ["builtin"])
            self.assertTrue(summary["degraded"])
            self.assertIn("pitch:builtin", summary["degradedReasons"])
            self.assertIn("onset:builtin", summary["degradedReasons"])
            # Legacy timelines never consume a beat grid, so its absence is not a
            # fallback; vamp-beat requests still report beat:legacy.
            self.assertNotIn("beat:legacy", summary["degradedReasons"])


if __name__ == "__main__":
    unittest.main()
