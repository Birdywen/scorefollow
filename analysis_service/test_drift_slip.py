"""The legacy tempo trend must not follow onsets stolen from a neighbour.

With fast notes and onset jitter two attacks can merge; the next note then
takes its neighbour's onset. If that mismatch (measured as a wrong pitch or a
displaced match) feeds predicted_drift, every later search window moves one
slot further and the slip accumulates to the end of the take.
"""
import io
import math
import unittest
import wave

import numpy as np

from .engine import analyze, seconds_per_quarter

NAMES = [("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0), ("F", 1), ("G", 0), ("G", 1), ("A", 0), ("A", 1), ("B", 0)]
PATTERN = [50, 53, 57, 62, 57, 53, 50, 53, 52, 55, 59, 64, 59, 55, 52, 55,
           53, 57, 60, 65, 60, 57, 53, 57, 55, 59, 62, 67, 62, 59, 55, 59,
           57, 60, 64, 69, 64, 60, 57, 60, 55, 59, 62, 67, 62, 59, 55, 50]
BPM = 180


def eighth_score(pitches=PATTERN):
    measures = []
    for m in range(0, len(pitches), 8):
        attrs = ('<attributes><divisions>2</divisions><time><beats>4</beats>'
                 '<beat-type>4</beat-type></time></attributes>') if m == 0 else ''
        body = ''
        for x in pitches[m:m + 8]:
            step, alter = NAMES[x % 12]
            body += ('<note><pitch><step>%s</step>%s<octave>%d</octave></pitch>'
                     '<duration>1</duration><type>eighth</type></note>') % (
                step, '<alter>1</alter>' if alter else '', x // 12 - 1)
        measures.append('<measure number="%d">%s%s</measure>' % (m // 8 + 1, attrs, body))
    return '<score-partwise><part id="P1">' + ''.join(measures) + '</part></score-partwise>'


def jittered_take(pitches, spacing, jitter, seed, lead=0.5):
    rate = 22050
    rng = np.random.default_rng(seed)
    onsets = [lead + i * spacing + (rng.normal(0, jitter) if jitter else 0) for i in range(len(pitches))]
    audio = np.zeros(int((lead + len(pitches) * spacing + 0.6) * rate), dtype=np.float32)
    for t0, midi in zip(onsets, pitches):
        d = 0.9 * spacing
        t = np.arange(int(d * rate)) / rate
        env = np.minimum(1, t * 80) * np.minimum(1, (d - t) * 40)
        hz = 440 * 2 ** ((midi - 69) / 12)
        tone = sum(a * np.sin(2 * math.pi * hz * k * t) for k, a in ((1, 1.0), (2, 0.5), (3, 0.3), (4, 0.15)))
        s = int(max(0, t0) * rate)
        seg = (0.3 / 1.95) * env * tone
        audio[s:s + len(seg)] += seg[:len(audio) - s]
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(audio), "NONE", "not compressed"))
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return output.getvalue(), onsets


def slips(result, onsets, limit=0.12):
    bad = run = longest = 0
    for k, note in enumerate(result["notes"]):
        p = note.get("performedSec")
        off = p is not None and k < len(onsets) and abs(p - onsets[k]) > limit
        bad += off
        run = run + 1 if off else 0
        longest = max(longest, run)
    return bad, longest


class DriftSlipTest(unittest.TestCase):
    def setUp(self):
        self.xml = eighth_score()
        self.spacing = seconds_per_quarter(self.xml, BPM) / 2

    def test_steady_take_has_no_slips(self):
        wav, onsets = jittered_take(PATTERN, self.spacing, 0.0, 0)
        result = analyze(wav, self.xml, BPM, "cello", start_measure=1)
        self.assertEqual(slips(result, onsets), (0, 0))

    def test_jittered_fast_take_does_not_slip_cumulatively(self):
        longest = {}
        for seed in range(16):
            wav, onsets = jittered_take(PATTERN, self.spacing, 0.04, seed)
            result = analyze(wav, self.xml, BPM, "cello", start_measure=1)
            longest[seed] = slips(result, onsets)[1]
            if seed == 12:
                self.assertGreaterEqual(result["summary"]["rhythmScore"] or 0, 60, result["summary"])
        self.assertLessEqual(max(longest.values()), 6, longest)


if __name__ == "__main__":
    unittest.main()
