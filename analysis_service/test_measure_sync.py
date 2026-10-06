"""Manual measure maps are the timeline, not a pitch-driven alignment guess."""
import io
import unittest
import wave
import numpy as np

from .engine import analyze, validate_measure_sync
from .test_engine import score, recording


class MeasureSyncTests(unittest.TestCase):
    def test_manual_boundaries_override_bpm_and_exclude_unmarked_tail(self):
        markers = [{"measure": i + 1, "audioSec": .12 + i} for i in range(4)]
        for bpm in (60, 200):
            result = analyze(recording(), score(), bpm, "violin", sync_mode="manual-measures", measure_sync=markers)
            self.assertEqual([n["measure"] for n in result["notes"]], [1, 2, 3])
            self.assertEqual([n["expectedSec"] for n in result["notes"]], [.12, 1.12, 2.12])
            self.assertEqual(result["summary"]["pitchScore"], 100)
            self.assertIsNone(result["summary"]["rhythmScore"])
            self.assertEqual(result["summary"]["timingCandidateNotes"], 0)
            self.assertTrue(all(n["timingStatus"] == "unscored" and n["timingErrorMs"] is None for n in result["notes"]))
            self.assertEqual(result["measureIntervals"][-1]["endSec"], 3.12)

    def test_varying_tempo_within_measure_notes_use_local_interpolation(self):
        bounds = [.2, 1.8, 4.2, 5.4]
        pitches = [69, 71, 72, 74, 76, 74]
        names = {69: ("A", 4), 71: ("B", 4), 72: ("C", 5), 74: ("D", 5), 76: ("E", 5)}
        measures = []
        rate = 22050
        audio = np.zeros(rate * 6)
        expected = []
        for i in range(3):
            body = ""
            for j in range(2):
                midi = pitches[i * 2 + j]; step, octave = names[midi]
                body += f'<note><pitch><step>{step}</step><octave>{octave}</octave></pitch><duration>1</duration></note>'
                sec = bounds[i] + (bounds[i+1] - bounds[i]) * j / 2
                expected.append(sec)
                length = int((bounds[i+1] - bounds[i]) * .35 * rate)
                t = np.arange(length) / rate
                audio[int(sec*rate):int(sec*rate)+length] = .3 * np.sin(2*np.pi*440*2**((midi-69)/12)*t)
            measures.append(f'<measure number="{i+1}"><attributes><divisions>1</divisions></attributes>{body}</measure>')
        xml = '<score-partwise><part id="P1">' + ''.join(measures) + '</part></score-partwise>'
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setparams((1, 2, rate, len(audio), "NONE", "not compressed")); w.writeframes((audio*32767).astype('<i2').tobytes())
        markers = [{"measure": i+1, "audioSec": sec} for i, sec in enumerate(bounds)]
        result = analyze(buf.getvalue(), xml, 200, "violin", sync_mode="manual-measures", measure_sync=markers)
        self.assertEqual([n["expectedSec"] for n in result["notes"]], [round(t, 3) for t in expected])
        self.assertEqual(result["summary"]["timingCandidateNotes"], 3)
        self.assertEqual(result["summary"]["pitchScore"], 100)
        self.assertEqual([n["timingStatus"] for n in result["notes"]][::2], ["unscored"] * 3)

    def test_invalid_maps_and_conflicting_modes_rejected(self):
        valid = [{"measure": 1, "audioSec": .12}, {"measure": 2, "audioSec": 1.12}]
        for markers in (None, [], valid[:1], [valid[0], {"measure": 3, "audioSec": 2}],
                        [valid[0], {"measure": 2, "audioSec": .12}],
                        [valid[0], {"measure": 2, "audioSec": float('nan')}],
                        [valid[0], {"measure": 2, "audioSec": 9}],
                        [{"measure": True, "audioSec": 0}, valid[1]]):
            with self.subTest(markers=markers), self.assertRaises(ValueError):
                validate_measure_sync(markers, score(), 5.25, 1)
        for kwargs in ({"sync_mode": "legacy"}, {"sync_mode": "manual-measures", "start_measure": 0},
                       {"sync_mode": "manual-measures", "first_beat_audio_sec": .12}):
            with self.assertRaises(ValueError):
                analyze(recording(), score(), 60, "violin", measure_sync=valid, **kwargs)

    def test_nonfirst_measure_and_leading_rest(self):
        markers = [{"measure": 3, "audioSec": .12}, {"measure": 4, "audioSec": 1.12}, {"measure": 5, "audioSec": 2.12}]
        result = analyze(recording((72, 74, 76)), score(), 200, "violin", start_measure=3, sync_mode="manual-measures", measure_sync=markers)
        self.assertEqual([n['measure'] for n in result['notes']], [3, 4])
        xml = score().replace('<note>', '<note><rest/><duration>1</duration></note><note>', 1)
        markers = [{"measure": 1, "audioSec": 0}, {"measure": 2, "audioSec": 2.24}]
        result = analyze(recording((69, 69, 71, 72, 74, 76)), xml, 200, "violin", sync_mode="manual-measures", measure_sync=markers)
        self.assertEqual(result['notes'][0]['expectedSec'], 1.12)
        self.assertEqual(result['measureIntervals'][0]['startSec'], 0)
        self.assertEqual(result['summary']['timingCandidateNotes'], 1)
        self.assertNotEqual(result['notes'][0]['timingStatus'], 'unscored')
