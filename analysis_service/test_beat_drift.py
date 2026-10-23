"""string-mono-0.28: 拍点网格漂移补救 (Dotzauer No.31 E31 节拍器同步实案).

QM 拍点在快速段丢拍, 活网格到曲末比演奏早 5 s: 测音窗落到邻音上, 音准 54、
匹配率 0.39, 却够不上 _needs_rescue_check 的 < 40, 活网格也从不补救。
"""
import io
import unittest
import wave

import numpy as np

from .engine import analyze
from .quality import assess_quality

RATE = 22050
STEPS = {48: ("C", 3), 50: ("D", 3), 52: ("E", 3), 53: ("F", 3), 55: ("G", 3), 57: ("A", 3), 59: ("B", 3), 60: ("C", 4)}
UP = [48, 50, 52, 53, 55, 57, 59, 60]
MELODY = (UP + UP[::-1]) * 8  # 16 小节八分音符, 相邻音都不同
BPM = 100
SPACING = 60 / BPM / 2


def _score(pitches):
    measures = []
    for m in range(0, len(pitches), 8):
        attrs = ('<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time>'
                 '<clef><sign>F</sign><line>4</line></clef></attributes>') if m == 0 else ''
        body = ''.join('<note><pitch><step>%s</step><octave>%d</octave></pitch><duration>1</duration>'
                       '<type>eighth</type></note>' % STEPS[x] for x in pitches[m:m + 8])
        measures.append('<measure number="%d">%s%s</measure>' % (m // 8 + 1, attrs, body))
    return '<score-partwise><part id="P1">' + ''.join(measures) + '</part></score-partwise>'


def _take(pitches, wrong=()):
    audio = np.zeros(int((1.0 + len(pitches) * SPACING) * RATE), np.float32)
    n = int(SPACING * .92 * RATE)
    t = np.arange(n) / RATE
    for i, midi in enumerate(pitches):
        f = 440 * 2 ** ((midi + (1 if i in wrong else 0) - 69) / 12)
        tone = sum(a * np.sin(2 * np.pi * f * (k + 1) * t) for k, a in enumerate((1, .6, .4, .25)))
        o = int((0.5 + i * SPACING) * RATE)
        audio[o:o + n] += 0.25 * np.minimum(1, t * 80) * np.minimum(1, (t[-1] - t) * 80) * tone
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams((1, 2, RATE, len(audio), "NONE", "not compressed"))
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return out.getvalue()


def _beats(period):
    return [0.5 + i * period for i in range(int(len(MELODY) / 2) + 4)]


def _match(r):
    s = r["summary"]
    return s["correctPitchNotes"] / s["scoredPitchNotes"]


class BeatDriftRescueTests(unittest.TestCase):
    def test_drifting_grid_is_realigned(self):
        # 拍点比演奏快 4%: 到曲末早约 1.5 s (2-3 个音)。
        r = analyze(_take(MELODY), _score(MELODY), BPM, "cello", 1, sync_mode="vamp-beat",
                    beat_map=_beats(60 / BPM * .96))
        s = r["summary"]
        self.assertIn("drift", s["rescueReasons"])
        self.assertTrue(s["autoMeasureSync"])
        self.assertGreater(_match(r), .9)
        self.assertGreaterEqual(s["pitchScore"], 95)
        # 网格跑了但被音高证据否决: beat:rejected, 不是 beat:legacy (拍点检测器缺失)。
        self.assertIn("beat:rejected", s["degradedReasons"])
        self.assertNotIn("beat:legacy", s["degradedReasons"])
        self.assertIsNotNone(assess_quality(r)["overallScore"])

    def test_steady_grid_untouched(self):
        r = analyze(_take(MELODY), _score(MELODY), BPM, "cello", 1, sync_mode="vamp-beat",
                    beat_map=_beats(60 / BPM))
        s = r["summary"]
        self.assertEqual(s["syncMode"], "vamp-beat")
        self.assertFalse(s["autoMeasureSync"])
        self.assertGreater(_match(r), .9)

    def test_wrong_notes_on_steady_grid_stay_wrong(self):
        # 真拉错一半的音: 匹配率低但网格没漂, 补救不会更好, 照原结果打分。
        wrong = set(range(0, len(MELODY), 2))
        r = analyze(_take(MELODY, wrong), _score(MELODY), BPM, "cello", 1, sync_mode="vamp-beat",
                    beat_map=_beats(60 / BPM))
        s = r["summary"]
        self.assertEqual(s["syncMode"], "vamp-beat")
        self.assertLess(_match(r), .6)
        self.assertLess(s["pitchScore"], 70)


if __name__ == "__main__":
    unittest.main()
