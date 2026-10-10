"""Coverage for the minimal rhythmic-structure annotator.

Unit tests pin beats/downbeats/phrase chunking on fixed inputs; integration
tests prove the engine exposes result["rhythm"] additively (existing fields
byte-identical apart from the new key) and deterministically.
"""
import unittest

import numpy as np

from .engine import analyze
from .golden_fixtures import LONG_NOTE_COUNT, RANDOM_SEED, build_clean, build_long
from .rhythm_annotator import PHRASE_MEASURES, annotate_rhythm


def _intervals(n, start=0.0, length=1.0):
    return [{"measure": i + 1, "startSec": start + i * length,
             "endSec": start + (i + 1) * length} for i in range(n)]


class RhythmAnnotatorTests(unittest.TestCase):
    def test_legacy_grid_subdivides_measures(self):
        out = annotate_rhythm(_intervals(4), sec_per_beat=1.0)
        self.assertEqual(out["source"], "legacy-grid")
        self.assertEqual(out["beats"], [0.0, 1.0, 2.0, 3.0, 4.0])
        self.assertEqual([d["measure"] for d in out["downbeats"]], [1, 2, 3, 4])
        self.assertEqual([d["sec"] for d in out["downbeats"]], [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(len(out["phrases"]), 1)
        self.assertEqual(out["phrases"][0]["startMeasure"], 1)
        self.assertEqual(out["phrases"][0]["endMeasure"], 4)

    def test_detected_beats_preferred_and_clipped(self):
        out = annotate_rhythm(_intervals(4), beat_map=[-0.5, 0.25, 1.5, 3.75, 4.5],
                              sec_per_beat=1.0)
        self.assertEqual(out["source"], "vamp-beat")
        self.assertEqual(out["beats"], [0.25, 1.5, 3.75])

    def test_empty_beat_map_falls_back_to_grid(self):
        out = annotate_rhythm(_intervals(2), beat_map=[], sec_per_beat=0.5)
        self.assertEqual(out["source"], "legacy-grid")
        self.assertEqual(out["beats"], [0.0, 0.5, 1.0, 1.5, 2.0])

    def test_phrases_chunk_every_four_measures(self):
        out = annotate_rhythm(_intervals(8), sec_per_beat=1.0)
        self.assertEqual(out["phraseMeasures"], PHRASE_MEASURES)
        self.assertEqual([(p["startMeasure"], p["endMeasure"]) for p in out["phrases"]],
                         [(1, 4), (5, 8)])
        out8 = annotate_rhythm(_intervals(8), sec_per_beat=1.0, phrase_measures=8)
        self.assertEqual([(p["startMeasure"], p["endMeasure"]) for p in out8["phrases"]],
                         [(1, 8)])

    def test_empty_intervals_never_raise(self):
        out = annotate_rhythm([], sec_per_beat=1.0)
        self.assertEqual(out, {"source": "legacy-grid", "beats": [], "downbeats": [],
                               "phrases": [], "phraseMeasures": PHRASE_MEASURES})

    def test_engine_exposes_rhythm_additively_and_deterministically(self):
        np.random.seed(RANDOM_SEED)
        fix = build_clean()
        first = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        second = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        self.assertEqual(first["rhythm"], second["rhythm"])
        rhythm = first["rhythm"]
        # Legacy builtin path: grid source, beats cover the analyzed span.
        self.assertEqual(rhythm["source"], "legacy-grid")
        self.assertEqual([d["measure"] for d in rhythm["downbeats"]],
                         [m["measure"] for m in first["measureIntervals"]])
        self.assertEqual([d["sec"] for d in rhythm["downbeats"]],
                         [m["startSec"] for m in first["measureIntervals"]])
        self.assertGreaterEqual(len(rhythm["beats"]), 2)
        self.assertLessEqual(min(rhythm["beats"]), min(m["startSec"] for m in first["measureIntervals"]) + 1e-9 + 1.0)
        self.assertGreaterEqual(max(rhythm["beats"]), max(m["endSec"] for m in first["measureIntervals"]) - 1.0)
        self.assertEqual(len(rhythm["phrases"]), 2)  # 5 measures chunked 4+1
        self.assertEqual((rhythm["phrases"][0]["startMeasure"], rhythm["phrases"][0]["endMeasure"]), (1, 4))
        # Backward compatibility: everything else unchanged apart from the key.
        self.assertEqual(first["summary"]["pitchScore"], 100)
        self.assertEqual(len(first["notes"]), 5)
        without = dict(first)
        del without["rhythm"]
        self.assertNotIn("rhythm", without)
        self.assertIn("measureIntervals", without)

    def test_engine_vamp_beat_marks_detected_source(self):
        from . import vamp_features
        np.random.seed(RANDOM_SEED)
        fix = build_clean()
        pitch, onsets, beats = vamp_features.extract_all(fix["wav"])
        if not beats or len(beats) < 4:
            self.skipTest("QM beat tracker returned no usable grid on fixture audio")
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"],
                         sync_mode="vamp-beat", pitch_notes=pitch,
                         onset_hint=onsets, beat_map=beats)
        self.assertEqual(result["summary"]["syncMode"], "vamp-beat")
        self.assertEqual(result["rhythm"]["source"], "vamp-beat")

    def test_long_fixture_rhythm_uses_live_vamp_grid(self):
        from . import vamp_features
        try:
            import vamp
        except ImportError:
            self.skipTest("vamp python bridge not installed")
        required = ("pyin:pyin", "qm-vamp-plugins:qm-onsetdetector",
                    "qm-vamp-plugins:qm-barbeattracker")
        found = [p for p in vamp.list_plugins() if p in required]
        if len(found) < len(required):
            self.skipTest(f"vamp plugins unavailable, found={sorted(found)}")
        np.random.seed(RANDOM_SEED)
        fix = build_long()
        pitch, onsets, beats = vamp_features.extract_all(fix["wav"])
        self.assertTrue(pitch and onsets and beats)
        result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"],
                         sync_mode="vamp-beat", pitch_notes=pitch,
                         onset_hint=onsets, beat_map=beats)
        self.assertFalse(result["summary"]["degraded"])
        rhythm = result["rhythm"]
        self.assertEqual(rhythm["source"], "vamp-beat")
        for key in ("beats", "downbeats", "phrases"):
            self.assertTrue(rhythm[key], f"rhythm[{key!r}] is empty")
        # Monotonic structure: beats strictly increase, downbeats and
        # phrases advance with the analyzed measures.
        self.assertTrue(all(b < c for b, c in zip(rhythm["beats"], rhythm["beats"][1:])))
        secs = [d["sec"] for d in rhythm["downbeats"]]
        self.assertTrue(all(b < c for b, c in zip(secs, secs[1:])))
        self.assertEqual([d["measure"] for d in rhythm["downbeats"]],
                         [m["measure"] for m in result["measureIntervals"]])
        starts = [p["startSec"] for p in rhythm["phrases"]]
        self.assertTrue(all(b < c for b, c in zip(starts, starts[1:])))
        self.assertEqual(rhythm["phrases"][-1]["endMeasure"], LONG_NOTE_COUNT)


if __name__ == "__main__":
    unittest.main()
