"""Opt-in real-file regression; no recordings are checked into the repository.

SF_ALIGNMENT_MP3=/path/to/Dotzauer.mp3 SF_ALIGNMENT_XML=/path/to/score.musicxml
python3 -m unittest analysis_service.test_alignment_real -v
The fixture is specifically the previously investigated 90-second demonstration.
"""
import io
import os
from pathlib import Path
import subprocess
import unittest
import wave

from .engine import analyze
from .vamp_features import extract_all


@unittest.skipUnless(os.getenv("SF_ALIGNMENT_MP3") and os.getenv("SF_ALIGNMENT_XML"),
                     "Real Dotzauer fixtures not configured")
class RealAlignmentTests(unittest.TestCase):
    def test_42_second_crop_keeps_exact_note_anchor(self):
        pcm = subprocess.run([
            "ffmpeg", "-v", "error", "-ss", "42", "-i", os.environ["SF_ALIGNMENT_MP3"],
            "-t", "18", "-ac", "1", "-ar", "22050", "-f", "s16le", "pipe:1",
        ], capture_output=True, check=True, timeout=60).stdout
        self.assertEqual(len(pcm), 18 * 22050 * 2)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as writer:
            writer.setparams((1, 2, 22050, len(pcm) // 2, "NONE", "not compressed"))
            writer.writeframes(pcm)
        audio = buffer.getvalue()
        pitches, onsets, beats = extract_all(audio)
        self.assertIsNotNone(pitches, "Real replay requires pYIN")
        self.assertIsNotNone(beats, "Real replay requires QM beat tracking")
        result = analyze(audio, Path(os.environ["SF_ALIGNMENT_XML"]).read_text(),
                         112, "cello", start_measure=0, sync_mode="vamp-beat",
                         pitch_notes=pitches, onset_hint=onsets, beat_map=beats)
        self.assertEqual(result["notes"][0]["id"], "n177")
        self.assertTrue(result["summary"]["autoLocated"])
        self.assertGreaterEqual(result["summary"]["pitchScore"], 60)
