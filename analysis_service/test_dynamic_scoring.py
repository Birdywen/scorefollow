"""动态评分四件套: 极端音剔除 / 节奏优先归因 / 小节动态窗口 / 自动 sync 标注。"""
import unittest

from .engine import (_displaced_match, _drop_player_outliers, _measure_scores,
                     _suggest_measure_sync, analyze)
from .test_engine import recording, score


def aligned_note(measure, cents, status=None, expected=1.0, performed=1.0):
    return {"measure": measure, "onsetBeat": float(measure), "pitchMidi": 69.0,
            "expectedSec": expected,
            "performedSec": performed,
            "pitchErrorCents": cents,
            "pitchStatus": status or ("correct" if cents is not None and abs(cents) <= 25
                                      else "sharp" if cents is not None and cents > 0 else "flat"),
            "status": "correct"}


class DropOutliersTest(unittest.TestCase):
    def test_good_player_extreme_dropped(self):
        notes = [aligned_note(1, 5.0, expected=float(i), performed=float(i)) for i in range(12)]
        notes.append(aligned_note(1, 400.0, expected=12.0, performed=12.0))
        self.assertTrue(_drop_player_outliers(notes, 25.0))
        dropped = [n for n in notes if n["pitchStatus"] == "dropped"]
        self.assertEqual(len(dropped), 1)
        self.assertEqual(dropped[0]["status"], "dropped-outlier")
        self.assertEqual(dropped[0]["pitchErrorCents"], 400.0)

    def test_bad_player_gate_closed(self):
        notes = [aligned_note(1, 80.0, expected=float(i), performed=float(i)) for i in range(12)]
        notes.append(aligned_note(1, 400.0, expected=12.0, performed=12.0))
        self.assertFalse(_drop_player_outliers(notes, 25.0))
        self.assertEqual(sum(n["pitchStatus"] == "dropped" for n in notes), 0)

    def test_too_few_notes_no_trim(self):
        notes = [aligned_note(1, 5.0, expected=float(i), performed=float(i)) for i in range(5)]
        notes.append(aligned_note(1, 500.0, expected=5.0, performed=5.0))
        self.assertFalse(_drop_player_outliers(notes, 25.0))

    def test_cap_respected(self):
        notes = [aligned_note(1, 5.0, expected=float(i), performed=float(i)) for i in range(30)]
        for i in range(5):
            notes.append(aligned_note(1, 300.0 + i * 10, expected=30.0 + i, performed=30.0 + i))
        _drop_player_outliers(notes, 25.0)
        self.assertLessEqual(sum(n["pitchStatus"] == "dropped" for n in notes), 3)


class DisplacedMatchTest(unittest.TestCase):
    def test_neighbor_match(self):
        notes = [{"onsetBeat": 0.0, "pitchMidi": 69.0, "measure": 1},
                 {"onsetBeat": 1.0, "pitchMidi": 71.0, "measure": 1},
                 {"onsetBeat": 2.0, "pitchMidi": 72.0, "measure": 2}]
        hit = _displaced_match(0, notes, 71.0, 25.0)
        self.assertIsNotNone(hit)
        self.assertAlmostEqual(hit[0], 0.0)
        self.assertEqual(hit[1], 1)

    def test_no_match(self):
        notes = [{"onsetBeat": 0.0, "pitchMidi": 69.0, "measure": 1},
                 {"onsetBeat": 1.0, "pitchMidi": 71.0, "measure": 1}]
        self.assertIsNone(_displaced_match(0, notes, 76.0, 25.0))

    def test_far_measure_excluded(self):
        notes = [{"onsetBeat": 0.0, "pitchMidi": 69.0, "measure": 1}]
        for i in range(1, 6):
            notes.append({"onsetBeat": 10.0 + i, "pitchMidi": 76.0, "measure": 5})
        self.assertIsNone(_displaced_match(0, notes, 76.0, 25.0))


class MeasureScoresTest(unittest.TestCase):
    def test_borrow_softens_single_bad_note(self):
        notes = [aligned_note(1, 100.0), aligned_note(1, 5.0),
                 aligned_note(2, 5.0), aligned_note(2, 8.0)]
        scores = _measure_scores(notes, 25.0)
        lone = _measure_scores([aligned_note(1, 100.0)], 25.0)
        self.assertEqual([s["measure"] for s in scores], [1, 2])
        self.assertGreater(scores[0]["pitchScore"], lone[0]["pitchScore"])
        self.assertGreaterEqual(scores[1]["pitchScore"], 95)

    def test_empty_measure_none(self):
        notes = [aligned_note(1, None, status="uncertain")]
        scores = _measure_scores(notes, 25.0)
        self.assertIsNone(scores[0]["pitchScore"])


class SuggestSyncTest(unittest.TestCase):
    def test_global_shift_recovered(self):
        notes = [aligned_note(1 + i // 2, 5.0, expected=float(i), performed=float(i) + 0.2)
                 for i in range(8)]
        intervals = [{"measure": m, "startSec": float(2 * (m - 1)), "endSec": float(2 * m)}
                     for m in range(1, 5)]
        suggestion, shifted, markers = _suggest_measure_sync(notes, intervals, 8.5)
        self.assertAlmostEqual(suggestion["appliedOffsetSec"], 0.2, places=1)
        self.assertEqual(len(suggestion["candidates"]), 3)
        labels = [n["syncMeasure"] for n in notes]
        self.assertEqual(labels, sorted(labels))
        secs = [m["audioSec"] for m in markers]
        self.assertTrue(all(b > a for a, b in zip(secs, secs[1:])))
        self.assertTrue(all(0 <= s <= 8.5 for s in secs))

    def test_zero_shift_no_jitter(self):
        notes = [aligned_note(1 + i // 2, 5.0, expected=float(i), performed=float(i))
                 for i in range(8)]
        intervals = [{"measure": m, "startSec": float(2 * (m - 1)), "endSec": float(2 * m)}
                     for m in range(1, 5)]
        suggestion, shifted, _ = _suggest_measure_sync(notes, intervals, 8.5)
        self.assertEqual(suggestion["appliedOffsetSec"], 0.0)
        self.assertEqual([i["startSec"] for i in shifted],
                         [i["startSec"] for i in intervals])

    def test_uncertain_note_gets_candidates(self):
        notes = [aligned_note(1, 5.0, expected=0.5, performed=0.5),
                 {**aligned_note(2, None, status="uncertain", expected=2.5, performed=2.5),
                  "performedSec": None}]
        intervals = [{"measure": 1, "startSec": 0.0, "endSec": 2.0},
                     {"measure": 2, "startSec": 2.0, "endSec": 4.0}]
        _suggest_measure_sync(notes, intervals, 4.0)
        self.assertIsNotNone(notes[1]["syncCandidates"])
        self.assertIn(notes[1]["syncMeasure"], notes[1]["syncCandidates"])


class DynamicEndToEndTest(unittest.TestCase):
    def test_clean_take_new_keys_sane(self):
        result = analyze(recording(), score(), 60, "violin")
        self.assertIn("measureScores", result)
        self.assertIn("syncSuggestion", result)
        self.assertIn("suggestedMeasureSync", result)
        self.assertEqual(result["summary"]["droppedOutlierNotes"], 0)
        self.assertFalse(result["summary"]["outlierTrimActive"])
        self.assertEqual(result["syncSuggestion"]["appliedOffsetSec"], 0.0)
        labels = [n["syncMeasure"] for n in result["notes"]]
        self.assertEqual(labels, sorted(labels))
        self.assertTrue(all(isinstance(n["syncCandidates"], (list, type(None)))
                            for n in result["notes"]))


if __name__ == "__main__":
    unittest.main()
