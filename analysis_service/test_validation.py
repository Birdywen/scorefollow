"""Unit tests for validation module."""
import unittest
import io
import wave
import numpy as np
import xml.etree.ElementTree as ET

from .validation import (
    validate_wav_audio,
    validate_musicxml,
    validate_instrument,
    validate_bpm,
)
from .error_messages import AudioValidationError, ScoreValidationError


def _make_wav(duration_sec: float, rate: int = 22050, peak: float = 0.5, nchannels: int = 1) -> bytes:
    """Generate minimal valid WAV bytes."""
    frames = int(duration_sec * rate)
    signal = (np.sin(2 * np.pi * 440 * np.arange(frames) / rate) * peak * 32767).astype('<i2')
    if nchannels == 2:
        signal = np.column_stack([signal, signal]).flatten()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(nchannels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(signal.tobytes())
    return buf.getvalue()


class TestWavValidation(unittest.TestCase):
    def test_valid_mono_wav(self):
        wav = _make_wav(2.0)
        signal, rate = validate_wav_audio(wav)
        self.assertEqual(rate, 22050)
        self.assertIsInstance(signal, np.ndarray)
        self.assertEqual(signal.dtype, np.float32)
        self.assertGreater(len(signal), 0)

    def test_stereo_rejected(self):
        wav = _make_wav(2.0, nchannels=2)
        with self.assertRaises(AudioValidationError):
            validate_wav_audio(wav)

    def test_too_short(self):
        wav = _make_wav(0.3)
        with self.assertRaises(AudioValidationError) as cm:
            validate_wav_audio(wav)
        self.assertIn("不足", str(cm.exception))

    def test_too_long(self):
        with self.assertRaises(AudioValidationError) as cm:
            validate_wav_audio(_make_wav(2.0), max_duration=1.0)
        self.assertIn("超过", str(cm.exception))

    def test_low_signal(self):
        wav = _make_wav(2.0, peak=0.001)
        with self.assertRaises(AudioValidationError) as cm:
            validate_wav_audio(wav)
        self.assertIn("太弱", str(cm.exception))

    def test_clipping(self):
        wav = _make_wav(2.0, peak=1.0)
        signal, _ = validate_wav_audio(wav)
        self.assertGreaterEqual(float(np.max(np.abs(signal))), 0.999)
        with wave.open(io.BytesIO(wav), 'rb') as source:
            expected = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2').astype(np.float32) / 32768
        np.testing.assert_array_equal(signal, expected)

    def test_short_quiet_recording_remains_supported(self):
        signal, _ = validate_wav_audio(_make_wav(0.4, peak=0.006))
        self.assertEqual(len(signal), 8820)

    def test_sample_rate_range(self):
        for rate in (8000, 16000, 44100, 48000):
            with self.subTest(rate=rate):
                self.assertEqual(validate_wav_audio(_make_wav(0.5, rate=rate))[1], rate)
        for rate in (4000, 96000):
            with self.subTest(rate=rate), self.assertRaises(AudioValidationError):
                validate_wav_audio(_make_wav(0.5, rate=rate))

    def test_invalid_format(self):
        with self.assertRaises(AudioValidationError):
            validate_wav_audio(b"not a wav file")


class TestMusicXMLValidation(unittest.TestCase):
    def test_valid_musicxml(self):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1"><measure number="1"></measure></part>
</score-partwise>"""
        root = validate_musicxml(xml)
        self.assertIsInstance(root, ET.Element)
        self.assertEqual(root.tag.split('}')[-1], 'score-partwise')

    def test_xxe_entity_blocked(self):
        xml = """<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<score-partwise>&xxe;</score-partwise>"""
        with self.assertRaises(ScoreValidationError) as cm:
            validate_musicxml(xml)
        self.assertIn("实体", str(cm.exception))

    def test_too_large(self):
        xml = "<score-partwise>" + "x" * 2_000_000 + "</score-partwise>"
        with self.assertRaises(ScoreValidationError) as cm:
            validate_musicxml(xml)
        self.assertIn("过大", str(cm.exception))

    def test_malformed_xml(self):
        with self.assertRaises(ScoreValidationError):
            validate_musicxml('<score-partwise><part id="P1"><measure><unclosed>')

    def test_namespace_prefix(self):
        root = validate_musicxml('<m:score-partwise xmlns:m="urn:musicxml"><m:part id="P1"><m:measure/></m:part></m:score-partwise>')
        self.assertEqual(root.tag, '{urn:musicxml}score-partwise')

    def test_internal_subset_after_xml_declaration(self):
        with self.assertRaisesRegex(ScoreValidationError, "实体"):
            validate_musicxml('<?xml version="1.0"?><!DOCTYPE score-partwise [<!ELEMENT score-partwise ANY>]><score-partwise/>')


class TestInstrumentValidation(unittest.TestCase):
    def test_valid_instrument(self):
        validate_instrument("violin", ["violin", "viola", "cello"])

    def test_invalid_instrument(self):
        with self.assertRaises(ValueError) as cm:
            validate_instrument("trumpet", ["violin", "viola"])
        self.assertIn("不支持", str(cm.exception))


class TestBPMValidation(unittest.TestCase):
    def test_valid_bpm(self):
        validate_bpm(120, 30, 200)

    def test_too_low(self):
        with self.assertRaises(ValueError) as cm:
            validate_bpm(20, 30, 200)
        self.assertIn("超出", str(cm.exception))

    def test_too_high(self):
        with self.assertRaises(ValueError) as cm:
            validate_bpm(250, 30, 200)
        self.assertIn("超出", str(cm.exception))


if __name__ == '__main__':
    unittest.main()
