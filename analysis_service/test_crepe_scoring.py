"""CREPE second opinion for scoring (string-mono-0.14, lazy + crop).

Gap-fill only, and only where pYIN missed: full pYIN coverage means zero
CREPE calls. A missing pYIN reading takes the CREPE median over its merged
crop window; an existing pYIN reading is always kept. Probe basis: full
model err 1-6c vs BP bend 23-60c on detuned sines (tiny 17x faster but
blind at A4-30c with 16c err, so crops stay on full).
"""
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

import numpy as np

import analysis_service.engine as E
from analysis_service.engine import _apply_crepe_opinion, _crepe_track, analyze
from .golden_fixtures import build_clean, build_detuned

CREPE_PYTHON = "/home/ubuntu/.local/share/scorefollow/crepevenv/bin/python3"

PITCH_CENTS_TOL = 10.0
CREPE_AUDIT_TOL = 12.0


def _track(times, midi, voicing):
    return (np.asarray(times, float), np.asarray(midi, float), np.asarray(voicing, float))


class CrepeOpinionTests(unittest.TestCase):
    def test_gap_fill_takes_crepe_median(self):
        out = _apply_crepe_opinion(None, None, 0.0, 69.0, (1.0, 2.0),
                                   _track([0.9, 1.2, 1.4, 1.6, 1.8, 2.1], [69.1] * 6, [0.9] * 6))
        self.assertEqual(out[0], 10.0)
        self.assertAlmostEqual(out[1], 69.1)
        self.assertEqual(out[2], 0.9)
        self.assertEqual(out[3], 10.0)

    def test_existing_pyin_reading_is_kept_with_audit(self):
        out = _apply_crepe_opinion(3.0, 69.03, 0.8, 69.0, (1.0, 2.0),
                                   _track([1.2, 1.5, 1.8, 2.0], [69.1] * 4, [0.9] * 4))
        self.assertEqual(out[:3], (3.0, 69.03, 0.8))
        self.assertEqual(out[3], 10.0)

    def test_unvoiced_or_few_frames_yields_no_opinion(self):
        silent = _track([1.2, 1.5, 1.8, 2.0], [69.1] * 4, [0.1] * 4)
        self.assertEqual(_apply_crepe_opinion(None, None, 0.0, 69.0, (1.0, 2.0), silent),
                         (None, None, 0.0, None))
        few = _track([1.2, 1.5], [69.1] * 2, [0.9] * 2)
        self.assertEqual(_apply_crepe_opinion(None, None, 0.0, 69.0, (1.0, 2.0), few),
                         (None, None, 0.0, None))

    def test_no_track_or_no_window_passes_through(self):
        self.assertEqual(_apply_crepe_opinion(5.0, 69.05, 0.7, 69.0, (1.0, 2.0), None),
                         (5.0, 69.05, 0.7, None))
        voiced = _track([1.2, 1.5, 1.8, 2.0], [69.1] * 4, [0.9] * 4)
        self.assertEqual(_apply_crepe_opinion(None, None, 0.0, 69.0, (None, None), voiced),
                         (None, None, 0.0, None))

    def test_no_env_returns_none(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SCOREFOLLOW_CREPE_PYTHON", None)
            self.assertIsNone(_crepe_track(np.zeros(22050, dtype=np.float32), 22050))

    def test_bad_interpreter_returns_none(self):
        with patch.dict(os.environ, {"SCOREFOLLOW_CREPE_PYTHON": "/nonexistent/sf-crepe-python"}):
            self.assertIsNone(_crepe_track(np.zeros(22050, dtype=np.float32), 22050))

    def test_cache_is_lru_capped(self):
        import json
        E._CREPE_CACHE.clear()
        self.addCleanup(E._CREPE_CACHE.clear)

        def fake_run(cmd, **kwargs):
            out_path = cmd[-1]
            n = 16
            with open(out_path, "w", encoding="utf-8") as handle:
                json.dump({"times": [round(i * 0.01, 4) for i in range(n)],
                           "midi": [69.0] * n, "voicing": [0.9] * n}, handle)
            return subprocess.CompletedProcess(cmd, 0)

        with patch.dict(os.environ, {"SCOREFOLLOW_CREPE_PYTHON": "/fake/sf-crepe-python"}), \
                patch("subprocess.run", side_effect=fake_run):
            first_key = None
            for i in range(E._CREPE_CACHE_CAP + 6):
                sig = (np.sin(2 * np.pi * 440 * np.arange(22050) / 22050) * (0.5 + i * 0.01)).astype(np.float32)
                if i == 0:
                    import hashlib
                    first_key = (hashlib.blake2b(np.ascontiguousarray(sig, dtype=np.float32).tobytes(),
                                                 digest_size=16).digest(), 22050)
                _crepe_track(sig, 22050)
            self.assertLessEqual(len(E._CREPE_CACHE), E._CREPE_CACHE_CAP)
            self.assertNotIn(first_key, E._CREPE_CACHE)


def _sine_wav(path, freq=440.0, seconds=1.0, rate=22050):
    n = int(rate * seconds)
    pcm = (0.5 * np.sin(2 * np.pi * freq * np.arange(n) / rate) * 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm)


class CrepeWorkerTests(unittest.TestCase):
    def test_worker_emits_track_schema(self):
        if not os.path.exists(CREPE_PYTHON):
            self.skipTest("crepevenv not installed")
        import json
        with tempfile.TemporaryDirectory(prefix="sf-crepe-test-") as tmp:
            wav_path = os.path.join(tmp, "in.wav")
            out_path = os.path.join(tmp, "out.json")
            _sine_wav(wav_path)
            worker = os.path.join(os.path.dirname(E.__file__), "crepe_worker.py")
            subprocess.run([CREPE_PYTHON, "-I", "-B", worker, wav_path, out_path],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=300, check=True)
            with open(out_path, encoding="utf-8") as handle:
                raw = json.load(handle)
        self.assertIn("times", raw)
        self.assertEqual(len(raw["times"]), len(raw["midi"]))
        self.assertEqual(len(raw["times"]), len(raw["voicing"]))
        self.assertGreater(len(raw["times"]), 100)
        mid = slice(len(raw["midi"]) // 4, 3 * len(raw["midi"]) // 4)
        med = float(np.median(np.asarray(raw["midi"])[mid]))
        self.assertAlmostEqual(med, 69.0, delta=0.25)


class CrepeEndToEndTests(unittest.TestCase):
    def test_detuned_pyin_unchanged_and_crepe_never_runs(self):
        E._CREPE_CACHE.clear()
        self.addCleanup(E._CREPE_CACHE.clear)
        fix = build_detuned()
        with patch.dict(os.environ, {"SCOREFOLLOW_CREPE_PYTHON": CREPE_PYTHON}), \
                patch.object(E, "_crepe_track",
                             side_effect=AssertionError("lazy: no gaps, no run")):
            result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        target = next(n for n in result["notes"] if n["id"] == "n3")
        self.assertAlmostEqual(target["pitchErrorCents"], 60.0, delta=PITCH_CENTS_TOL)
        self.assertTrue(all(n["crepeCents"] is None for n in result["notes"]))
        self.assertEqual(target["pitchStatus"], "sharp")

    def test_silenced_note_gap_filled_from_crop(self):
        import io as _io
        import wave as _wave
        from .golden_fixtures import (FIXTURE_PITCHES, NOMINAL_FIRST_ONSET_SEC,
                                      NOTE_LENGTH_SEC, NOTE_SPACING_SEC,
                                      SAMPLE_RATE, _encode_wav)
        E._CREPE_CACHE.clear()
        self.addCleanup(E._CREPE_CACHE.clear)
        fix = build_detuned()
        with _wave.open(_io.BytesIO(fix["wav"]), "rb") as handle:
            pcm = (np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")
                   .astype(np.float32) / 32767.0)
        gap_index = 2
        start = int((NOMINAL_FIRST_ONSET_SEC + gap_index * NOTE_SPACING_SEC) * SAMPLE_RATE)
        pcm[start:start + int(NOTE_LENGTH_SEC * SAMPLE_RATE)] = 0.0
        silenced = _encode_wav(pcm)
        calls = []

        def fake_crepe_track(signal, rate):
            calls.append(len(signal))
            n = max(8, int(len(signal) / rate * 172.0))
            times = np.arange(n, dtype=np.float64) / 172.0
            return (times, np.full(n, FIXTURE_PITCHES[gap_index] + 0.6),
                    np.full(n, 0.9))

        with patch.dict(os.environ, {"SCOREFOLLOW_CREPE_PYTHON": CREPE_PYTHON}), \
                patch.object(E, "_crepe_track", side_effect=fake_crepe_track):
            result = analyze(silenced, fix["xml"], fix["bpm"], fix["instrument"])
        self.assertEqual(len(calls), 1)
        self.assertLess(calls[0], len(pcm))
        target = next(n for n in result["notes"] if n["id"] == "n3")
        self.assertAlmostEqual(target["pitchErrorCents"], 60.0, delta=PITCH_CENTS_TOL)
        self.assertAlmostEqual(target["crepeCents"], 60.0, delta=PITCH_CENTS_TOL)
        self.assertEqual(target["matchStatus"], "matched")
        self.assertEqual(target["pitchStatus"], "sharp")
        others = [n for n in result["notes"] if n["id"] != "n3"]
        self.assertTrue(all(n["crepeCents"] is None for n in others))
        self.assertTrue(all(abs(n["pitchErrorCents"]) <= PITCH_CENTS_TOL for n in others))

    def test_no_env_is_013_parity(self):
        E._CREPE_CACHE.clear()
        self.addCleanup(E._CREPE_CACHE.clear)
        fix = build_detuned()
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SCOREFOLLOW_CREPE_PYTHON", None)
            result = analyze(fix["wav"], fix["xml"], fix["bpm"], fix["instrument"])
        self.assertTrue(all(n["crepeCents"] is None for n in result["notes"]))
        target = next(n for n in result["notes"] if n["id"] == "n3")
        self.assertAlmostEqual(target["pitchErrorCents"], 60.0, delta=PITCH_CENTS_TOL)


if __name__ == "__main__":
    unittest.main()
