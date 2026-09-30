import io
import unittest
import wave
from unittest.mock import patch

import numpy as np

from . import piano_engine
from .engine import parse_score
from .test_engine import continuous_recording, recording, score


def fake_perf(*events):
    return [(float(o), float(o) + 0.4, float(m), 80.0) for o, m in events]


class PianoTests(unittest.TestCase):
    def setUp(self):
        # Existing fixtures assign/delete the sensor; always restore the real
        # function so later tests cannot accidentally lose the service adapter.
        sensor_patch = patch.object(piano_engine, "transcribe_notes")
        sensor_patch.start()
        self.addCleanup(sensor_patch.stop)

    def test_wrong_notes_reduce_f1(self):
        with patch.object(piano_engine, "transcribe_notes", return_value=fake_perf(
                *[(i + .12, 69 if i < 6 else 71) for i in range(10)])):
            result = piano_engine.analyze_piano(recording((69,) * 10), score((69,) * 10), 60)
        summary = result["summary"]
        self.assertEqual((summary["missedNotes"], summary["extraNotes"]), (4, 4))
        self.assertEqual(summary["pitchScore"], 60)
        self.assertEqual(summary["pitchScoreMethod"], "note-f1")

    def test_audio_end_clips_score_but_silent_tail_does_not(self):
        events = fake_perf((.12, 69), (1.12, 71))
        with patch.object(piano_engine, "transcribe_notes", return_value=events):
            short = piano_engine.analyze_piano(recording((69, 71)), score(), 60)
            # Same first two notes, but five seconds of actual recorded audio:
            # the remaining silence must not be treated as an early file end.
            short_wav = recording((69, 71))
            with wave.open(io.BytesIO(short_wav), "rb") as source:
                pcm = source.readframes(source.getnframes())
            output = io.BytesIO()
            with wave.open(output, "wb") as target:
                target.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
                target.writeframes(pcm + bytes(3 * 22050 * 2))
            long = piano_engine.analyze_piano(output.getvalue(), score(), 60)
        # 2.25s includes the expected third attack at 2.12s.
        self.assertEqual(short["summary"]["noteCount"], 3)
        self.assertEqual(short["summary"]["missedNotes"], 1)
        self.assertTrue(short["summary"]["truncatedByAudioEnd"])
        self.assertEqual(long["summary"]["noteCount"], 5)
        self.assertEqual(long["summary"]["missedNotes"], 3)
        self.assertEqual(long["summary"]["pitchScore"], 57)
        self.assertEqual(long["summary"]["coveredSec"], 5.25)

    def test_exact_file_end_excludes_next_note(self):
        with patch.object(piano_engine, "transcribe_notes", return_value=fake_perf((.12, 69), (1.12, 71))):
            result = piano_engine.analyze_piano(continuous_recording(seconds=2.12), score(), 60)
        self.assertEqual(result["summary"]["noteCount"], 2)
        self.assertEqual(result["summary"]["pitchScore"], 100)

    def test_late_same_pitch_cannot_match_outside_window(self):
        with patch.object(piano_engine, "transcribe_notes", return_value=fake_perf((.12, 69), (1.8, 71))):
            result = piano_engine.analyze_piano(recording(), score(), 60)
        self.assertEqual(result["notes"][1]["status"], "missed")
        self.assertEqual(result["summary"]["extraNotes"], 1)

    def test_invalid_wav_rejected_before_transcription(self):
        with patch.object(piano_engine, "transcribe_notes") as sensor:
            with self.assertRaises(ValueError):
                piano_engine.analyze_piano(b"not WAV", score(), 60)
            sensor.assert_not_called()

    def test_perfect_take_scores_full(self):
        piano_engine.transcribe_notes = lambda wav: fake_perf(
            (0.12, 69), (1.12, 71), (2.12, 72), (3.12, 74), (4.12, 76))
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        self.assertEqual(result["summary"]["noteCount"], 5)
        self.assertEqual(result["summary"]["correctPitchNotes"], 5)
        self.assertEqual(result["summary"]["missedNotes"], 0)
        self.assertEqual(result["summary"]["pitchScore"], 100)
        self.assertEqual(result["summary"]["timedNotes"], 4)
        self.assertIsNone(result["notes"][0]["timingErrorMs"])
        self.assertEqual(result["summary"]["sensors"], ["piano-transcribe"])
        self.assertTrue(all(n["status"] == "correct" for n in result["notes"]))

    def test_wrong_and_missed_notes(self):
        piano_engine.transcribe_notes = lambda wav: fake_perf(
            (0.12, 69), (1.12, 71), (2.12, 73), (3.12, 74))
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        by_id = {n["id"]: n for n in result["notes"]}
        self.assertEqual(by_id["n3"]["status"], "missed")
        self.assertEqual(by_id["n5"]["status"], "missed")
        self.assertEqual(result["summary"]["missedNotes"], 2)
        # stray C#5 (73) matches nothing -> extra
        self.assertEqual(result["summary"]["extraNotes"], 1)

    def test_extras_outside_excerpt_window_are_ignored(self):
        piano_engine.transcribe_notes = lambda wav: fake_perf(
            (0.12, 69), (1.12, 71), (2.12, 72), (3.12, 74), (4.12, 76),
            # far-away resonance doubles: before start and past the excerpt
            (-2.0, 40), (30.0, 40))
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        self.assertEqual(result["summary"]["extraNotes"], 0)
        self.assertEqual(result["summary"]["correctPitchNotes"], 5)

    def test_pedal_blur_tie_goes_to_stronger_strike(self):
        # Blur pair sits on note 2 (note 1 anchors the grid, so no tie is possible there).
        piano_engine.transcribe_notes = lambda wav: [
            (0.12, 0.5, 69.0, 80.0),
            (1.10, 1.5, 71.0, 30.0),   # weak resonance blur, 20 ms early
            (1.14, 1.5, 71.0, 90.0),   # real strike, 20 ms late (exact tie)
            (2.12, 2.5, 72.0, 80.0),
            (3.12, 3.5, 74.0, 80.0), (4.12, 4.5, 76.0, 80.0)]
        try:
            result = piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes
        self.assertAlmostEqual(result["notes"][1]["performedSec"], 1.14, places=2)
        self.assertEqual(result["notes"][1]["status"], "correct")

    def test_parse_midi_round_trip(self):
        import io as _io
        import mido
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        track.append(mido.Message("note_on", note=69, velocity=90, time=0))
        track.append(mido.Message("note_off", note=69, velocity=0, time=480))
        track.append(mido.Message("note_on", note=72, velocity=70, time=0))
        track.append(mido.Message("note_on", note=72, velocity=0, time=240))
        mid.tracks.append(track)
        buf = _io.BytesIO()
        mid.save(file=buf)
        notes = piano_engine._parse_midi(buf.getvalue())
        self.assertEqual(len(notes), 2)
        self.assertEqual([int(n[2]) for n in notes], [69, 72])
        self.assertGreater(notes[0][1], notes[0][0])

    def test_failed_transcription_raises_chinese_error(self):
        piano_engine.transcribe_notes = lambda wav: None
        try:
            with self.assertRaisesRegex(ValueError, "钢琴转录失败"):
                piano_engine.analyze_piano(recording(), score(), 60, 1)
        finally:
            del piano_engine.transcribe_notes


if __name__ == "__main__":
    unittest.main()
