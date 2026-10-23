"""string-mono-0.27: 低音区快速跨弦 (Dotzauer No.31 E31 实案).

1. 自相关跟踪器: 落在搜索边界的读数是截断值 (恒为 MIDI 96.9), 不是音高。
2. 大跳音的常规测量窗锚在期望时刻、跳过前 35%, 低音稍晚进入时几乎不剩帧;
   起音已测到时改在 [本起音, 下一起音] 内重测, 不再判 "没听清"。
修复前: 120-132 BPM 十六分音符只听清 36-54/64 个音, 132 BPM 不出音准分。
"""
import io
import unittest
import wave

import numpy as np

from .engine import analyze, track

RATE = 22050
NAMES = {43: ("G", 2), 45: ("A", 2), 47: ("B", 2), 48: ("C", 3), 50: ("D", 3), 55: ("G", 3), 57: ("A", 3)}
# 低音与空弦交替 (跨弦), 每个低音都是大跳。
CROSSING = [43, 55, 45, 55, 47, 55, 48, 55, 50, 57, 48, 57, 47, 57, 45, 57] * 4


def _tone(midi, n, partials=(1, .6, .4, .25)):
    t = np.arange(n) / RATE
    f = 440 * 2 ** ((midi - 69) / 12)
    return sum(a * np.sin(2 * np.pi * f * (k + 1) * t) for k, a in enumerate(partials))


def _score(pitches):
    measures = []
    for m in range(0, len(pitches), 16):
        attrs = ('<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time>'
                 '<clef><sign>F</sign><line>4</line></clef></attributes>') if m == 0 else ''
        body = ''.join('<note><pitch><step>%s</step><octave>%d</octave></pitch><duration>1</duration>'
                       '<type>16th</type></note>' % NAMES[x] for x in pitches[m:m + 16])
        measures.append('<measure number="%d">%s%s</measure>' % (m // 16 + 1, attrs, body))
    return '<score-partwise><part id="P1">' + ''.join(measures) + '</part></score-partwise>'


def _take(pitches, spacing, late):
    """十六分音符跨弦: 低音晚 late 秒进入, 前一音仍有残响 (衰减到 35%)。"""
    audio = np.zeros(int((0.8 + len(pitches) * spacing) * RATE), np.float32)
    for i, midi in enumerate(pitches):
        o = int((0.3 + i * spacing + (late if i % 2 == 0 else 0)) * RATE)
        n = int(2 * spacing * RATE)
        t = np.arange(n) / RATE
        audio[o:] *= 0.35
        seg = audio[o:o + n]
        seg += (0.25 * np.minimum(1, t * 80) * np.exp(-t * 6) * _tone(midi, n))[:len(seg)]
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams((1, 2, RATE, len(audio), "NONE", "not compressed"))
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return out.getvalue()


class TrackerBoundaryTests(unittest.TestCase):
    def test_fewer_readings_at_search_limit(self):
        # 衰减的低音跨弦: 修复前 38/193 帧读成 MIDI 96.9 (最短延迟边界), 修复后 29;
        # 有内部峰的帧改读真音高, 帧数不变 (不删帧, 见 track 注释)。
        n = int(RATE * .15)
        decay = np.exp(-np.arange(n) / RATE * 8)
        sig = np.concatenate([_tone(m, n, (1, .6, .4)) * .3 * decay for m in [38, 50, 40, 52] * 4])
        _, pitches, _, _ = track(sig.astype(np.float32), RATE)
        voiced = pitches[np.isfinite(pitches)]
        self.assertEqual(len(voiced), 193)
        self.assertLessEqual(int(np.count_nonzero(voiced >= 96.5)), 32)
        played = voiced[voiced < 96.5]
        near = np.min(np.abs(played[:, None] - np.array([38, 50, 40, 52])[None, :]), axis=1)
        self.assertGreater(float(np.mean(near < 1)), .9)

    def test_steady_low_tone_unchanged(self):
        _, pitches, _, _ = track((.3 * _tone(38, RATE)).astype(np.float32), RATE)
        voiced = pitches[np.isfinite(pitches)]
        self.assertEqual(len(voiced), len(pitches))
        self.assertLess(abs(float(np.median(voiced)) - 38), .1)


class FastCrossingTests(unittest.TestCase):
    def test_late_bass_notes_are_heard(self):
        for bpm, late in ((120, .04), (120, .06), (132, .04)):
            with self.subTest(bpm=bpm, late=late):
                r = analyze(_take(CROSSING, 60 / bpm / 4, late), _score(CROSSING), bpm, "cello", start_measure=1)
                s = r["summary"]
                self.assertGreaterEqual(s["voicedNotes"], 62)
                self.assertEqual(s["confidence"], "medium")
                self.assertGreaterEqual(s["pitchScore"] or 0, 95)


if __name__ == "__main__":
    unittest.main()
