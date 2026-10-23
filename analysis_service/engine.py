"""Conservative fixed-tempo, monophonic bowed-string analysis.

Results are only assigned where the recording supplies enough voiced evidence.
The engine does not infer a score from the PDF or claim to handle accompaniment.
"""

import io
import math
import wave
import xml.etree.ElementTree as ET
from collections import OrderedDict
from decimal import Decimal, InvalidOperation

import numpy as np

from .alignment import align_excerpt, anchor_time, locate_excerpt, usable_events
from .rhythm_annotator import annotate_rhythm as _annotate_rhythm
from .validation import validate_wav_audio, validate_musicxml, validate_bpm, validate_instrument
from .performance_monitor import track_performance

VERSION = "string-mono-0.30"

# string-mono-0.18: onset detectors carry ~15 ms of their own error, and without a
# metronome the time axis is anchored on the first detected onset (often late on
# bowed strings), so a constant offset up to ~30 ms is not the player's fault.
# Only spread/offset beyond these allowances costs points (corpus median 82 -> 95,
# clearly unsteady takes stay low).
RHYTHM_SPREAD_FLOOR_MS = 15
RHYTHM_OFFSET_TOLERANCE_MS = 30


def _rhythm_scores(spread_ms, offset_ms):
    """(rhythmStabilityScore, rhythmScore) from detrended spread and median offset."""
    excess_spread = max(0.0, float(spread_ms) - RHYTHM_SPREAD_FLOOR_MS)
    excess_offset = max(0.0, abs(float(offset_ms)) - RHYTHM_OFFSET_TOLERANCE_MS)
    stability = round(max(0, 100 - excess_spread * .55))
    rhythm = round(max(0, 100 - excess_spread * .45 - excess_offset * .3))
    return stability, rhythm


def _legacy_rhythm_gate(spread_ms, offset_ms):
    """The strict 0.17 rhythm formula, used only to decide whether rigid-grid
    alignment failed (_needs_rescue_check). The displayed score forgives the
    detector floor; the rescue gate must not, or wrong-tempo takes stop being
    rescued. Rescue behaviour is identical to 0.17."""
    return round(max(0, 100 - float(spread_ms) * .45 - abs(float(offset_ms)) * .3))
MAX_SECONDS = 300
MAX_FIRST_BEAT_SECONDS = 20
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# 调号在五线谱上的升降号顺序: fifths 个升号取前 N 个, 降号同理。
SHARP_ORDER = ("F", "C", "G", "D", "A", "E", "B")
FLAT_ORDER = ("B", "E", "A", "D", "G", "C", "F")
# 个别导出器只写 <accidental> 不写 <alter> 时的回退映射。
ACCIDENTAL_ALTER = {
    "sharp": 1, "natural": 0, "flat": -1,
    "double-sharp": 2, "sharp-sharp": 2, "flat-flat": -2,
    "natural-sharp": 1, "natural-flat": -1,
}


def musicxml_number(text: str | None, label: str) -> Decimal:
    try:
        value = Decimal(text if text is not None else "")
    except InvalidOperation as exc:
        raise ValueError(f"MusicXML {label} 无效") from exc
    if not value.is_finite():
        raise ValueError(f"MusicXML {label} 无效")
    return value


def xml_root(xml: str, label: str = "MusicXML") -> ET.Element:
    """共享的 XML 入口防护: 大小上限 + 实体声明拒绝 + 解析错误转 ValueError。"""
    return validate_musicxml(xml, label=label)


@track_performance("score_parsing")
def parse_score(xml: str) -> list[dict]:
    # Standard MusicXML often includes an external PUBLIC DTD. ElementTree does
    # not resolve it; forbid internal entity definitions, not the normal header.
    root = validate_musicxml(xml)
    if root.tag.rsplit("}", 1)[-1] != "score-partwise":
        raise ValueError("仅支持 score-partwise MusicXML")
    parts = root.findall("./{*}part")
    if len(parts) != 1:
        raise ValueError("第一版只支持单个乐器声部")
    if parts[0].find(".//{*}transpose") is not None:
        raise ValueError("移调记谱暂不支持，请使用实音 MusicXML")
    notes = []
    beat = 0.0
    divisions = Decimal(1)
    meter_signature = None
    key_alter: dict[str, int] = {}
    voices = set()
    staves = set()
    for index, measure in enumerate(parts[0].findall("./{*}measure"), 1):
        if measure.find(".//{*}repeat") is not None or measure.find(".//{*}ending") is not None:
            raise ValueError("反复/跳房子须先展开为顺序谱")
        attr = measure.find("./{*}attributes/{*}divisions")
        if attr is not None:
            divisions = musicxml_number(attr.text, "divisions")
            if divisions <= 0:
                raise ValueError("MusicXML divisions 无效")
        sig = measure.find("./{*}attributes/{*}time")
        if sig is not None:
            meter = (sig.findtext("./{*}beats"), sig.findtext("./{*}beat-type"))
            if meter_signature is None:
                meter_signature = meter
            elif meter != meter_signature:
                raise ValueError("中途变拍暂不支持，请按拍号分段分析")
        for fifths_el in measure.findall("./{*}attributes/{*}key/{*}fifths"):
            fifths = musicxml_number(fifths_el.text, "fifths")
            if fifths != fifths.to_integral_value() or not -7 <= fifths <= 7:
                raise ValueError("MusicXML 调号无效")
            fifths = int(fifths)
            if fifths > 0:
                key_alter = dict.fromkeys(SHARP_ORDER[:fifths], 1)
            elif fifths < 0:
                key_alter = dict.fromkeys(FLAT_ORDER[:-fifths], -1)
            else:
                key_alter = {}
        # 小节线把临时升降号清零, 调号保留到下次变调。
        accidentals: dict[tuple[str, int], int] = {}
        chord_ok, chord_base = False, None
        for item in measure:
            tag = item.tag.rsplit("}", 1)[-1]
            if tag in ("backup", "forward"):
                raise ValueError("多声部/交错时间轴暂不支持")
            if tag != "note":
                continue
            if item.find("./{*}grace") is not None:
                continue
            # 0.25: 同声部双音/和弦。<chord/> 音与前一音同起点、不推进时间;
            # pitchMidi 保留首个 (基础) 音 (= 单声部投影的选择), 全部音高进 chordMidi。
            chord = item.find("./{*}chord") is not None
            if chord and not chord_ok:
                raise ValueError("双音/和弦缺少起始音符")
            voice = item.findtext("./{*}voice")
            if voice:
                voices.add(voice)
            staff = item.findtext("./{*}staff")
            if staff:
                staves.add(staff)
            if len(voices) > 1 or len(staves) > 1:
                raise ValueError("多声部暂不支持")
            duration = item.findtext("./{*}duration")
            if duration is None:
                raise ValueError("仅支持有明确 duration 的音符和休止符")
            length = float(musicxml_number(duration, "duration") / divisions)
            if not 0 < length <= 32:
                raise ValueError("音符时值无效")
            pitch = item.find("./{*}pitch")
            if pitch is not None:
                name = pitch.findtext("./{*}step")
                if name not in STEP:
                    raise ValueError("MusicXML 音名无效")
                octave = musicxml_number(pitch.findtext("./{*}octave"), "octave")
                if octave != octave.to_integral_value():
                    raise ValueError("微分音或非整数八度暂不支持")
                octave = int(octave)
                alter_el = pitch.find("./{*}alter")
                if alter_el is not None:
                    alter = musicxml_number(alter_el.text, "alter")
                    if alter != alter.to_integral_value():
                        raise ValueError("微分音或非整数八度暂不支持")
                    alter = int(alter)
                    accidentals[(name, octave)] = alter
                else:
                    accidental = item.findtext("./{*}accidental")
                    if accidental is None:
                        alter = accidentals.get((name, octave), key_alter.get(name, 0))
                    else:
                        accidental = accidental.strip()
                        if accidental not in ACCIDENTAL_ALTER:
                            raise ValueError("微分音或非整数八度暂不支持")
                        alter = ACCIDENTAL_ALTER[accidental]
                        accidentals[(name, octave)] = alter
                midi = 12 * (octave + 1) + STEP[name] + alter
                if not 36 <= midi <= 96:
                    raise ValueError("音域暂仅支持 MIDI 36–96")
                ties = {t.get("type") for t in item.findall("./{*}tie")}
                if chord:
                    # 和弦音: 并入基础音; 延音线续上的和弦音不是新起音, 忽略。
                    if chord_base is not None and "stop" not in ties:
                        tones = chord_base.setdefault("chordMidi", [chord_base["pitchMidi"]])
                        if midi not in tones:
                            tones.append(midi)
                            tones.sort()
                    continue
                if "stop" in ties:
                    if not notes or notes[-1]["pitchMidi"] != midi:
                        raise ValueError("跨小节连音不完整")
                    notes[-1]["durationBeat"] += length
                    chord_base = None
                else:
                    notes.append({"id": f"n{len(notes) + 1}", "measure": index, "onsetBeat": beat,
                                  "durationBeat": length, "pitchMidi": midi})
                    chord_base = notes[-1]
                chord_ok = True
            elif chord:
                continue
            else:
                chord_ok, chord_base = False, None
            beat += length
    if not notes or len(notes) > 1000:
        raise ValueError("MusicXML 必须包含 1–1000 个可演奏音符")
    return notes


# analyze 内部工作电平: 所有能量阈值都相对这个峰值标定。
NORMALIZED_PEAK = 0.5
# track() 每块 FFT 帧数: 128 帧 x 16384 点 complex128 约 16 MB。
TRACK_CHUNK_FRAMES = 128


# 0.29 弦乐 Vamp 传感器前置高通: 60 Hz 二阶 Butterworth 幅频 (零相位 FFT, 不移动起音)。
# 低频隆隆声 (桌面/手机/空调) 干扰 pYIN/QM, 让 Dotzauer No.23 s1 自动对齐失败。
# 只喂给 vamp_features 与定位用 BP; 引擎自研跟踪与能量门限仍用原始信号 (引擎侧
# 也滤会让 No.27 fast 起音能量判定失准, 节奏 91 -> 0)。大提琴最低 C2 65 Hz 只衰减约 2 dB。
STRING_HIGHPASS_HZ = 60.0


def string_highpass(signal: np.ndarray, rate: int, cutoff: float = STRING_HIGHPASS_HZ) -> np.ndarray:
    if cutoff <= 0 or len(signal) < 16:
        return signal
    spectrum = np.fft.rfft(signal.astype(np.float64))
    f = np.fft.rfftfreq(len(signal), 1.0 / rate)
    gain = f ** 2 / np.sqrt(f ** 4 + cutoff ** 4)
    return np.fft.irfft(spectrum * gain, n=len(signal)).astype(np.float32)


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    """Parse and validate WAV audio, delegating to validation module."""
    return validate_wav_audio(data, max_duration=MAX_SECONDS)


def track(signal: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    # 约 12 ms hop、93 ms Hann 窗；自相关法只适合单声部基频。
    hop = max(1, int(rate * 0.012))
    size = max(1024, round(rate * 0.093))
    fft_size = 2 ** math.ceil(math.log2(2 * size - 1))
    min_hz = 440 * 2 ** ((36 - 69) / 12)
    max_hz = 440 * 2 ** ((96 - 69) / 12)
    lo = max(2, math.floor(rate / max_hz))
    hi = min(size // 2, math.ceil(rate / min_hz))
    window = np.hanning(size).astype(np.float32)
    # 分块批量 FFT (#8): 逐帧 rfft/irfft 在 300 s/48 kHz 录音上约 10 s。帧切分、能量门限、
    # 峰值挑选与逐帧版一致 (等价性见 PERFORMANCE-ANALYSIS-PLAN.md #8), 只把 FFT 按块向量化。
    if len(signal) < size:
        return tuple(np.asarray([], dtype=float) for _ in range(4))
    frames = np.lib.stride_tricks.sliding_window_view(signal, size)[::hop]
    count = len(frames)
    times = (np.arange(count) * hop + size / 2) / rate
    energies = np.empty(count)
    pitches = np.full(count, np.nan)
    confidences = np.zeros(count)
    norm = 1 - np.arange(lo, hi + 1) / size
    for begin in range(0, count, TRACK_CHUNK_FRAMES):
        block = frames[begin:begin + TRACK_CHUNK_FRAMES]
        # float32 平方/均值与逐帧版相同; 门限在 float64 上比较。
        energies[begin:begin + len(block)] = np.sqrt(np.mean(block ** 2, axis=1))
        voiced = np.flatnonzero(energies[begin:begin + len(block)] >= 0.008)
        if not len(voiced):
            continue
        spectrum = np.fft.rfft(block[voiced] * window, n=fft_size, axis=1)
        ac = np.fft.irfft(spectrum * spectrum.conj(), n=fft_size, axis=1)[:, :size]
        block_candidates = ac[:, lo:hi + 1] / (ac[:, :1] * norm + 1e-10)
        for row, candidates in zip(voiced, block_candidates):
            peaks = np.where((candidates[1:-1] >= candidates[:-2]) & (candidates[1:-1] >= candidates[2:]))[0] + 1
            maximum = float(np.max(candidates))
            # 首个强峰偏向基频而非 2 倍周期；低置信片段不强行定音。
            strong = peaks[candidates[peaks] >= max(0.7, maximum * 0.90)]
            idx = int(strong[0]) if len(strong) else int(np.argmax(candidates))
            if idx == 0 or idx == len(candidates) - 1:
                # 0.27: 落在搜索边界的不是音高 (截断值, 读数恒为 MIDI 96.9 / 36)。低音的
                # 最短延迟自相关天然很高, 真周期峰稍弱 (快速跨弦) 就被边界压掉。
                # 有 >= 0.7 的内部峰就改取最强内部峰。没有则保留原读数: 删掉会丢掉
                # 换音处的音高跳变起音, 快速抖动演奏累计错位 (test_drift_slip seed 8)。
                inner = peaks[candidates[peaks] >= 0.7]
                if len(inner):
                    top = float(np.max(candidates[inner]))
                    idx = int(inner[candidates[inner] >= top * 0.90][0])
            confidence = float(candidates[idx])
            lag = float(lo + idx)
            if 0 < idx < len(candidates) - 1:
                left, center, right = (float(candidates[idx - 1]), float(candidates[idx]), float(candidates[idx + 1]))
                denominator = left - 2 * center + right
                if abs(denominator) > 1e-9:
                    lag += max(-0.5, min(0.5, 0.5 * (left - right) / denominator))
            confidences[begin + row] = confidence
            if confidence >= 0.7:
                pitches[begin + row] = 69 + 12 * math.log2(rate / lag / 440)
    return times, pitches, energies, confidences


def _hint_track(signal: np.ndarray, rate: int,
                notes: list) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """融合基频: 自研原始跟踪打底(对短促偏差更敏感), pYIN 音符段只补自研
    无声/低置信的盲区。只补段内帧, 段间与首尾之外留 NaN, 能量网格沿用自研。"""
    times, self_p, energy, self_c = track(signal, rate)
    starts = np.array([a for a, _, _ in notes])
    ends = np.array([b for _, b, _ in notes])
    midis = np.array([m for _, _, m in notes])
    # 只在 pYIN 段内部补盲区; 段间静音留 NaN (#7: 漏奏的音曾被填上邻音音高,
    # 判成 +200 音分错音)。要求段已排序且不重叠, analyze 入口用 usable_events 校验。
    k = np.searchsorted(starts, times, side="right") - 1
    inside = (k >= 0) & (times < ends[np.clip(k, 0, len(ends) - 1)])
    pyin_p = np.where(inside, midis[np.clip(k, 0, len(midis) - 1)], np.nan)
    # 自研高置信帧优先, 盲区才用 pYIN 补
    use_self = np.isfinite(self_p) & (self_c >= 0.7)
    pitches = np.where(use_self, self_p, pyin_p)
    conf = np.where(use_self, self_c, np.where(np.isfinite(pyin_p), 0.9, 0.0))
    return times, pitches, energy, conf


# 0.19: 打分时剔除偏差 >600 音分的音 (判定/漂移/补救/匹配率仍按 0.18 口径)。
# 实测 600-1120 成片同向, 是测量/对位问题不是演奏; 标 pitchExcluded 供前端灰显。
PITCH_SCORE_EXCLUDE_CENTS = 600.0


def classify_pitch(cents: float | None, detected_midi: float | None, tolerance: float = 25.0) -> str:
    """Cents 判音: 物理不可能 Verdict uncertain, 差整八度单列 octave,
    ±tolerance 音分内 correct, 之外 sharp/flat。MIDI 只做存储, 判定全是 cents
    (1 半音=100, 1 八度=1200)。默认 tolerance=25¢ 平衡反馈敏感度；严格模式可用 15¢。"""
    if cents is None:
        return "uncertain"
    if detected_midi is not None and (detected_midi < 36 or detected_midi > 96):
        # 大提琴最低空弦 C2=36, 谱面域上限 96: 超出则跟踪器谐波/次谐波误判。
        return "uncertain"
    if abs(abs(cents) - 1200) <= 80:
        return "octave"
    # A displacement beyond an octave is suspect tracking/alignment evidence,
    # not a reliable intonation verdict. Keep the raw measurement for replay.
    if abs(cents) > 1200:
        return "outlier"
    if cents > tolerance:
        return "sharp"
    if cents < -tolerance:
        return "flat"
    return "correct"


# 对照谱面核对目标音: >150¢ 的音不猜原因, 直接看音高窗频谱里谱面目标音那串谐波
# (基音+倍频) 在不在。在 → 测量误差 (泛音/碰弦/拖尾), 从目标谐波重测音准;
# 不在而另一串在 → 真拉错。两串只比各自独有的分音, 八度/泛音关系才分得开。
OUTLIER_SUSPECT_CENTS = 150.0
VERIFY_PARTIALS = (1.0, 1.0, 0.8, 0.6, 0.5, 0.4)  # 第 k 分音的权重
VERIFY_TOL_CENTS = 60.0
VERIFY_PRESENT_DB = 15.0  # 分音峰高出频谱中位数 (噪声底) 多少才算在
VERIFY_SERIES_MIN = 0.5   # 独有分音加权出现比例
VERIFY_RESIDUAL_DB = -10.0  # 两串都在时目标串至少不比另一串弱这么多
VERIFY_MIN_SEC = 0.06


def _midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def verify_target(signal, rate, lo, hi, target_midi, detected_midi):
    """返回 None (窗太短/无信号) 或 {check, recovered:(midi, cents)|None, target, other}。
    check: confirmed 只有目标串 / two-series 目标串+另一串 / wrong-note 只有另一串 / unclear。"""
    if signal is None or lo is None or hi is None or detected_midi is None:
        return None
    a, b = max(0, int(lo * rate)), min(len(signal), int(hi * rate))
    if b - a < int(VERIFY_MIN_SEC * rate):
        return None
    seg = np.asarray(signal[a:b], dtype=np.float64)
    seg = seg - seg.mean()
    if not np.any(seg):
        return None
    n = 1 << int(math.ceil(math.log2(max(len(seg) * 4, 8192))))
    db = 20 * np.log10(np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n=n)) + 1e-12)
    freqs = np.arange(len(db)) * rate / n
    band = (freqs >= 50) & (freqs <= min(5000.0, rate / 2 - 1))
    need = max(float(np.median(db[band])) + VERIFY_PRESENT_DB, float(np.max(db[band])) - 50)
    res_hz = rate / len(seg)  # 真实分辨率由窗长决定, 不是补零后的 bin

    def tol(f):
        return max(f * (2 ** (VERIFY_TOL_CENTS / 1200) - 1), res_hz)

    def peak(f):
        sel = np.flatnonzero(np.abs(freqs - f) <= tol(f))
        if f >= rate / 2 - 1 or not len(sel):
            return None
        i = int(sel[np.argmax(db[sel])])
        if db[i] < need:
            return None
        off = 0.0
        if 0 < i < len(db) - 1:
            l, c, r = db[i - 1], db[i], db[i + 1]
            d = l - 2 * c + r
            off = max(-0.5, min(0.5, 0.5 * (l - r) / d)) if abs(d) > 1e-9 else 0.0
        return (i + off) * rate / n

    ft, fd = _midi_hz(target_midi), _midi_hz(detected_midi)
    tp = [ft * k for k in range(1, len(VERIFY_PARTIALS) + 1)]
    dp = [fd * k for k in range(1, len(VERIFY_PARTIALS) + 1)]

    def own(parts, base):
        # 按比率判共有: 落在另一串 (无限延伸) 某个整数倍上就算共有, 不只比前 6 个
        return [i for i, f in enumerate(parts)
                if f < base * 0.75 or abs(f - base * round(f / base)) > tol(f)]

    def score(parts, idx):
        if not idx:
            return None
        w = sum(VERIFY_PARTIALS[i] for i in idx)
        return round(sum(VERIFY_PARTIALS[i] for i in idx if peak(parts[i]) is not None) / w, 2)

    def level(parts, idx):
        if not idx:
            return None
        w = [VERIFY_PARTIALS[i] for i in idx]
        lv = [float(np.max(db[np.abs(freqs - parts[i]) <= tol(parts[i])], initial=-240)) for i in idx]
        return sum(a * b for a, b in zip(w, lv)) / sum(w)

    t_own, d_own = own(tp, fd), own(dp, ft)
    ts, ds = score(tp, t_own), score(dp, d_own)
    tl, dl = level(tp, t_own), level(dp, d_own)
    margin = round(tl - dl, 1) if tl is not None and dl is not None else None
    if ts is not None and ds is not None:
        # 目标串比另一串弱太多 = 混响/共鸣残影, 不是拉的音
        target = ts >= VERIFY_SERIES_MIN and margin >= VERIFY_RESIDUAL_DB
        other = ds >= VERIFY_SERIES_MIN
    elif ts is None:
        # 目标串全是实测音的倍频 (实测在目标下方): 实测独有分音在 → 真拉低了
        other = ds is not None and ds >= VERIFY_SERIES_MIN
        target = not other and peak(ft) is not None
    else:
        # 实测音是目标的某个泛音: 目标独有分音在 → 跟踪器抓了泛音; 不在 → 真拉高了
        target = ts >= VERIFY_SERIES_MIN
        other = not target and peak(fd) is not None
    check = ("two-series" if other else "confirmed") if target else ("wrong-note" if other else "unclear")
    recovered = None
    if target:
        est = [69 + 12 * math.log2(p / (k + 1) / 440) for k in (t_own or range(len(tp)))[:4]
               for p in [peak(tp[k])] if p is not None]
        if est:
            m = float(np.median(est))
            recovered = (m, round((m - target_midi) * 100, 1))
    return {"check": check, "recovered": recovered, "target": ts, "other": ds, "margin": margin}


def pitch_weight(cents, check=None) -> float:
    """单音音准权重 [0,1]。<=150¢ 全权; >600¢ 为 0 (多半是对位错); 频谱核对为
    wrong-note (目标串不在、另一串在) 全权; 其余 150→600¢ 线性衰减, 下限 0.3。"""
    a = abs(float(cents))
    if a > PITCH_SCORE_EXCLUDE_CENTS:
        return 0.0
    if a <= OUTLIER_SUSPECT_CENTS or check == "wrong-note":
        return 1.0
    decay = (PITCH_SCORE_EXCLUDE_CENTS - a) / (PITCH_SCORE_EXCLUDE_CENTS - OUTLIER_SUSPECT_CENTS)
    return round(max(0.3, decay), 2)


def _verify_targets(aligned: list, signal, rate, tolerance: float) -> None:
    """主循环 + CREPE 之后的事后核对。放在对齐之后: 纠正的音若回灌速度趋势会改变
    后续所有音的时间 (no27 fast 实测节奏 48→0)。只动音准读数与状态, 不动时间。"""
    for n in aligned:
        lo, hi = n.pop("_verifyWin", (None, None))
        n["targetCheck"], n["targetCheckRawCents"], n["targetCheckMarginDb"] = None, None, None
        cents = n.get("pitchErrorCents")
        if cents is None or n.get("pitchDisplaced") or abs(cents) <= OUTLIER_SUSPECT_CENTS:
            continue
        v = verify_target(signal, rate, lo, hi, n["pitchMidi"], n["pitchMidi"] + cents / 100)
        if v is None:
            continue
        n["targetCheck"], n["targetCheckMarginDb"] = v["check"], v["margin"]
        if v["recovered"] is not None:
            n["targetCheckRawCents"] = cents
            n["pitchErrorCents"] = v["recovered"][1]
            ps = classify_pitch(v["recovered"][1], v["recovered"][0], tolerance)
            n["pitchStatus"] = ps
            ts = n.get("timingStatus")
            n["status"] = ("wrong_pitch" if ps in ("sharp", "flat") else "octave_uncertain" if ps == "octave"
                           else "outlier" if ps == "outlier" else "uncertain" if ps == "uncertain"
                           else ts if ts in ("late", "early") else "timing_uncertain" if ts == "uncertain"
                           else "correct")


BP_OPINION_MIN = 0.3   # written key's mean activation over the note window
BP_OPINION_MAX_CENTS = 100.0


def _bp_second_opinion(aligned: list, signal, rate, tolerance: float) -> int:
    """0.30: the tracker says octave/outlier/>150 c but Basic Pitch clearly hears the
    written key (strongest key in the window) -> re-read the pitch from that key's own
    harmonics over the frames BP has it sounding. Lazy: BP runs only if a candidate
    exists. Returns how many notes were re-read."""
    cand = [n for n in aligned if not n.get("chordMidi") and not n.get("pitchDisplaced")
            and n.get("pitchErrorCents") is not None and n.get("targetCheckRawCents") is None
            and (n.get("pitchStatus") in ("octave", "outlier")
                 or (n.get("pitchStatus") in ("sharp", "flat")
                     and abs(n["pitchErrorCents"]) > OUTLIER_SUSPECT_CENTS))]
    if not cand:
        return 0
    act = _bp_note_activation(string_highpass(signal, rate), rate)
    if act is None:
        return 0
    from .chord_pitch import bp_time_frame, harmonic_cents, sounding_run
    fixed = 0
    for n in cand:
        lo = n["performedSec"] if n.get("performedSec") is not None else n["expectedSec"]
        hi = max(n["expectedEndSec"], lo + 0.05)
        m = int(round(n["pitchMidi"]))
        if not 21 <= m <= 108:
            continue
        f0 = int(bp_time_frame(lo))
        seg = act[f0:max(f0 + 1, int(bp_time_frame(hi)))].astype(np.float32)
        if not len(seg):
            continue
        seg = seg.mean(0)
        if seg[m - 21] < BP_OPINION_MIN or seg[m - 21] < seg.max():
            continue
        run = sounding_run(act, m, lo - 0.05, hi)
        if run is None:
            continue
        a, b = run
        c = harmonic_cents(signal, rate, m, a + 0.15 * (b - a), b - 0.1 * (b - a))
        if c is None or abs(c) > BP_OPINION_MAX_CENTS:
            continue
        n["bpCheckRawCents"] = n["pitchErrorCents"]
        n["pitchErrorCents"] = c
        n["pitchStatus"] = classify_pitch(c, m + c / 100, tolerance)
        n["status"] = _note_status(n["pitchStatus"], n.get("timingStatus"))
        fixed += 1
    return fixed


def _note_status(pitch_status: str, timing_status: str | None) -> str:
    return ("wrong_pitch" if pitch_status in ("sharp", "flat") else "octave_uncertain" if pitch_status == "octave"
            else "outlier" if pitch_status == "outlier" else "uncertain" if pitch_status == "uncertain"
            else timing_status if timing_status in ("late", "early") else "timing_uncertain" if timing_status == "uncertain"
            else "correct")


def _score_chord_tones(aligned: list, signal, rate, act, tolerance: float) -> None:
    """0.26 双音/和弦逐音音准 (见 chord_pitch.py): 谱面写的每个和弦音单独对照自己的
    谱面音高。Basic Pitch 逐帧激活定每个音何时在响, 音高从该音自己的谐波读。
    音符级 pitchErrorCents/状态取偏差最大的已测音 (显示用); 音准分逐音计 (见 _pitch_items)。
    没有 Basic Pitch 激活时不动 (保留 0.25 的最近和弦音读数)。"""
    if act is None:
        return
    from .chord_pitch import measure_chord
    for i, n in enumerate(aligned):
        tones = n.get("chordMidi")
        if not tones:
            continue
        on = n["performedSec"] if n.get("performedSec") is not None else n["expectedSec"]
        nxt = aligned[i + 1] if i + 1 < len(aligned) else None
        end = (nxt["performedSec"] if nxt and nxt.get("performedSec") is not None
               else nxt["expectedSec"] if nxt else n["expectedEndSec"])
        if end <= on:
            end = n["expectedEndSec"]
        res = measure_chord(signal, rate, act, tones, on, end)
        for t in res:
            t["pitchStatus"] = classify_pitch(t["cents"], t["midi"] + t["cents"] / 100, tolerance) \
                if t["cents"] is not None else None
        n["chordTones"] = res
        measured = [t for t in res if t["cents"] is not None]
        if measured:
            worst = max(measured, key=lambda t: abs(t["cents"]))
            n["pitchErrorCents"] = worst["cents"]
            n["confidence"] = 0.9
            n["matchStatus"] = "matched"
            n["pitchStatus"] = worst["pitchStatus"]
        else:
            n["pitchErrorCents"] = None
            n["confidence"] = 0.0
            n["matchStatus"] = "uncertain"
            n["pitchStatus"] = "uncertain"
        n["rawPitchErrorCents"], n["pitchDisplaced"], n["displacedFromMeasure"] = None, False, None
        n["status"] = _note_status(n["pitchStatus"], n.get("timingStatus"))


def _pitch_items(aligned: list) -> list:
    """(|cents|, weight) per scored pitch: one per note, one per measured tone for chords."""
    items = []
    for n in aligned:
        if n.get("pitchWeight", 0) <= 0 or n.get("pitchStatus") not in ("sharp", "flat", "correct"):
            continue
        tones = [t for t in n.get("chordTones") or [] if t["cents"] is not None]
        if tones:
            items.extend((abs(float(t["cents"])), n["pitchWeight"]) for t in tones)
        else:
            items.append((abs(float(n["pitchErrorCents"])), n["pitchWeight"]))
    return items


def _assign_pitch_weights(aligned: list) -> None:
    """终值 cents 定权 (CREPE 接管后才定), 权 0 的标 pitchExcluded 供前端灰显。"""
    for n in aligned:
        if n.get("pitchStatus") in ("sharp", "flat", "correct") and n.get("pitchErrorCents") is not None:
            w = pitch_weight(n["pitchErrorCents"], n.get("targetCheck"))
            n["pitchWeight"] = w
            if w == 0.0:
                n["pitchExcluded"] = True


def _displaced_match(note_index: int, notes: list, detected: float, tolerance: float):
    """节奏优先归因: 本窗音高超差时, 在 ±4 音/±6 拍内找音高匹配的邻音。
    找到返回 (new_cents, neighbor_measure), 否则 None。音准按邻音判对,
    错位由计时误差在节奏侧扣分 (小节错位是节奏错, 不是音准错)。"""
    center_beat = notes[note_index]["onsetBeat"]
    for j in range(max(0, note_index - 4), min(len(notes), note_index + 5)):
        if j == note_index:
            continue
        if abs(notes[j]["onsetBeat"] - center_beat) > 6.0:
            continue
        cents = round((detected - notes[j]["pitchMidi"]) * 100, 1)
        if abs(cents) <= tolerance:
            return cents, notes[j]["measure"]
    return None


def _drop_player_outliers(aligned: list, tolerance: float) -> bool:
    """动态剔除极端音 (原地改 aligned, 返回是否启用剔除)。
    门控: ≥10 个已判音且中位|偏差|≤40¢ —— 演奏者整体准才配剔除, 防止差生靠剔除刷分。
    剔除: 偏离个人中位 >150¢, 上限 max(2, 10%)。被剔音保留原始值供回放,
    状态记 dropped, 不计入音准分, 数量在 summary 明示。"""
    scored = [n for n in aligned if n.get("pitchStatus") in ("sharp", "flat", "correct")
              and n.get("pitchErrorCents") is not None]
    if len(scored) < 10:
        return False
    med_signed = float(np.median([n["pitchErrorCents"] for n in scored]))
    if float(np.median([abs(n["pitchErrorCents"]) for n in scored])) > 40:
        return False
    cap = max(2, len(scored) // 10)
    dropped = 0
    for n in sorted(scored, key=lambda n: abs(n["pitchErrorCents"] - med_signed), reverse=True):
        if dropped >= cap:
            break
        if abs(n["pitchErrorCents"] - med_signed) <= 150:
            break
        n["pitchStatus"] = "dropped"
        n["status"] = "dropped-outlier"
        n["dropReason"] = "extreme-vs-player-median"
        dropped += 1
    return dropped > 0


def _measure_scores(aligned: list, tolerance: float) -> list:
    """小节分 (动态窗口): 本小节音权 1.0, 相邻小节边界音 (上小节尾音/下小节首音)
    权 0.5 —— 切分 bleed 不冤枉本小节。只读, 不动逐音判定。"""
    by_measure: dict[int, list] = {}
    for n in aligned:
        by_measure.setdefault(n["measure"], []).append(n)
    measures = sorted(by_measure)
    out = []
    for i, m in enumerate(measures):
        pool = [(n, 1.0) for n in by_measure[m]
                if n.get("pitchStatus") in ("sharp", "flat", "correct")]
        for nb in (measures[i - 1] if i > 0 else None,
                   measures[i + 1] if i + 1 < len(measures) else None):
            if nb is None:
                continue
            edge = [n for n in by_measure[nb]
                    if n.get("pitchStatus") in ("sharp", "flat", "correct")]
            if not edge:
                continue
            pool.append((edge[-1] if nb < m else edge[0], 0.5))
        pool = [(n, w * n.get("pitchWeight", 1.0)) for n, w in pool if not n.get("pitchExcluded")]
        if not pool:
            out.append({"measure": m, "pitchScore": None, "noteCount": len(by_measure[m]),
                        "scoredNotes": 0})
            continue
        penalties = np.minimum(np.array([max(0.0, abs(n["pitchErrorCents"]) - tolerance)
                                          for n, _ in pool]), 100)
        weights = np.array([w for _, w in pool])
        score = round(max(0, 100 - float(np.sum(penalties * weights) / np.sum(weights)) * 1.2))
        out.append({"measure": m, "pitchScore": score, "noteCount": len(by_measure[m]),
                    "scoredNotes": len(pool)})
    return out


def _suggest_measure_sync(aligned: list, intervals: list, duration: float) -> tuple:
    """音频-小节自动标注: 全局 offset 网格搜索 (±0.5s/20ms 步进), 目标是计时残差
    中位最小 (音准匹配率与 offset 无关, 只做兜底参考); 取前 3 候选 (≥60ms 间隔),
    相对零位移改善 <15ms 则保持 0 (防抖动)。最优位移平移小节边界 (钳制≥0)。
    逐音 syncMeasure 左→右因果锁定 (单调不回退, 后调不影响已标); 无起音的音给候选小节。
    只读于打分, 只动边界展示与 manual 种子。返回 (suggestion, shifted, markers)。"""
    timed = [n for n in aligned if n.get("performedSec") is not None]
    if not timed or not intervals:
        return None, intervals, []
    exp = np.array([n["expectedSec"] for n in timed])
    perf = np.array([n["performedSec"] for n in timed])
    pitch_ok = [n.get("pitchErrorCents") is not None and abs(n["pitchErrorCents"]) <= 50
                for n in timed]
    match_rate = round(float(np.mean(pitch_ok)), 3) if pitch_ok else 0.0
    base_resid = float(np.median(np.abs(perf - exp)))
    ranked = []
    for off100 in range(-50, 51, 2):
        off = off100 / 100.0
        resid = float(np.median(np.abs(perf - (exp + off))))
        ranked.append((resid, off))
    ranked.sort()
    candidates = []
    for resid, off in ranked:
        if all(abs(off - c["offsetSec"]) >= 0.06 for c in candidates):
            candidates.append({"offsetSec": round(off, 2),
                               "medianResidualMs": round(resid * 1000),
                               "pitchMatchRate": match_rate})
        if len(candidates) >= 3:
            break
    best = candidates[0]["offsetSec"] if base_resid - candidates[0]["medianResidualMs"] / 1000 >= 0.015 else 0.0
    shifted = []
    for item in intervals:
        lo = max(0.0, round(item["startSec"] + best, 3))
        hi = min(duration, round(item["endSec"] + best, 3))
        if hi > lo:
            shifted.append({"measure": item["measure"], "startSec": lo, "endSec": hi})
    markers = []
    if shifted:
        for item in shifted:
            markers.append({"measure": item["measure"], "audioSec": item["startSec"]})
        markers.append({"measure": shifted[-1]["measure"] + 1,
                        "audioSec": shifted[-1]["endSec"]})
        increasing = all(b["audioSec"] > a["audioSec"] for a, b in zip(markers, markers[1:]))
        in_range = all(0 <= m["audioSec"] <= duration for m in markers)
        if not (increasing and in_range):
            markers = []
    first, last = (shifted[0]["measure"], shifted[-1]["measure"]) if shifted else (0, 0)

    def label(sec: float) -> int:
        for item in shifted:
            if item["startSec"] <= sec < item["endSec"]:
                return item["measure"]
        nearest = min(shifted, key=lambda item: abs((item["startSec"] + item["endSec"]) / 2 - sec))
        return nearest["measure"]

    prev = first - 1
    for n in aligned:
        sec = n["performedSec"] if n.get("performedSec") is not None else n["expectedSec"] + best
        lab = max(label(sec), prev) if shifted else n["measure"]
        n["syncMeasure"] = lab
        prev = lab
        if n.get("performedSec") is None:
            n["syncCandidates"] = [m for m in (lab - 1, lab, lab + 1) if first <= m <= last]
        else:
            n["syncCandidates"] = None
    suggestion = {"appliedOffsetSec": round(best, 2), "candidates": candidates,
                  "causal": True, "timedNotes": len(timed)}
    return suggestion, shifted, markers


def measure_start_beats(xml: str, include_end: bool = False) -> dict[int, float]:
    """Map 1-based measure number -> absolute downbeat in quarter-note beats.

    Includes rest-only measures. Independent from parse_score so the playback
    cursor and the metronome-anchored analysis share one definition of
    "measure N beat 1".
    """
    root = xml_root(xml)
    parts = root.findall("./{*}part")
    if len(parts) != 1:
        raise ValueError("第一版只支持单个乐器声部")
    beat = 0.0
    divisions = Decimal(1)
    starts: dict[int, float] = {}
    for index, measure in enumerate(parts[0].findall("./{*}measure"), 1):
        starts[index] = beat
        attr = measure.find("./{*}attributes/{*}divisions")
        if attr is not None:
            divisions = musicxml_number(attr.text, "divisions")
            if divisions <= 0:
                raise ValueError("MusicXML divisions 无效")
        for item in measure:
            tag = item.tag.rsplit("}", 1)[-1]
            if tag in ("backup", "forward"):
                raise ValueError("多声部/交错时间轴暂不支持")
            if tag != "note":
                continue
            if item.find("./{*}grace") is not None or item.find("./{*}chord") is not None:
                continue
            duration = item.findtext("./{*}duration")
            if duration is None:
                raise ValueError("仅支持有明确 duration 的音符和休止符")
            beat += float(musicxml_number(duration, "duration") / divisions)
    if include_end:
        starts[len(starts) + 1] = beat
    return starts


def validate_measure_sync(markers, xml: str, duration: float, start_measure: int) -> list:
    """Every interval has two explicit boundaries; never extrapolate user taps."""
    boundaries = measure_start_beats(xml, include_end=True)
    if not isinstance(markers, list) or not 2 <= len(markers) <= len(boundaries):
        raise ValueError("measureSync requires at least two measure boundaries")
    previous = None
    for marker in markers:
        if not isinstance(marker, dict):
            raise ValueError("Invalid measureSync marker")
        measure, sec = marker.get("measure"), marker.get("audioSec")
        if type(measure) is not int or measure not in boundaries or type(sec) not in (int, float) or not math.isfinite(sec) or not 0 <= sec <= duration:
            raise ValueError("measureSync boundary is outside the score or audio")
        if previous and (measure != previous["measure"] + 1 or sec <= previous["audioSec"] or boundaries[measure] <= boundaries[previous["measure"]]):
            raise ValueError("measureSync requires consecutive measures and increasing audio times")
        previous = marker
    if markers[0]["measure"] != start_measure:
        raise ValueError("startMeasure must match the first measureSync boundary")
    return markers


OCTAVE_SEARCH_SHIFTS = (0, -12, 12)
# 面板/实测速度比在此带内视为演奏偏差（照实报 late），之外视为输入错误
# （拍号口径、默认 BPM 未改），与拍点网格 [0.8, 1.25] 粗筛同带。
TEMPO_BAND = (0.8, 1.25)


def detect_builtin_onsets(times: np.ndarray, pitches: np.ndarray, energy: np.ndarray,
                          onset_hint: list | None = None) -> list[float]:
    """内置起音检测：能量突起或音高跳变，帧间隔 > 0.09 s 去重。

    时间零点锚在首个有音高的帧：前导宽带噪声（室噪/备弓）能量过门限但无音高，
    不能当首音起音，否则整条期望时间线提前、逐音对到邻音。只向前回溯
    <= 60 ms 的连续有能量帧，补回音头（起振帧音高尚未稳定）。
    """
    gate = max(0.012, float(np.max(energy)) * 0.10)
    voiced0 = int(np.flatnonzero(np.isfinite(pitches) & (energy > gate))[0])
    k = voiced0
    while k > 0 and energy[k - 1] > gate and times[k - 1] >= times[voiced0] - 0.06:
        k -= 1
    onsets = [float(times[k])]
    for i in range(2, len(times)):
        if energy[i] < 0.012:
            continue
        pitch_jump = np.isfinite(pitches[i]) and np.isfinite(pitches[i - 2]) and abs(pitches[i] - pitches[i - 2]) >= 0.85
        # 半音连奏：过渡帧把 2 帧差摊薄到 ~0.8 半音，漏检起音。补一个稳定阶跃判据：
        # 前段 (i-6..i-3) 与后段 (i..i+2) 各自平稳 (ptp<0.35)，中位数差 >= 0.6 半音。
        # 两段都要求平稳，揉弦（连续摆动）不满足。
        if not pitch_jump and 6 <= i <= len(times) - 3:
            before, after = pitches[i - 6:i - 2], pitches[i:i + 3]
            if np.isfinite(before).all() and np.isfinite(after).all() and \
                    float(np.ptp(before)) < 0.35 and float(np.ptp(after)) < 0.35:
                pitch_jump = abs(float(np.median(after)) - float(np.median(before))) >= 0.6
        attack = energy[i] > max(0.018, energy[i - 2] * 1.85) and energy[i] - energy[i - 2] > 0.008
        if (pitch_jump or attack) and times[i] - onsets[-1] > 0.09:
            onsets.append(float(times[i]))
    if onset_hint:
        # 外部起音传感器 (QM) 补入：与已检出起音按 150 ms 并档去重，只收编新沿
        for h in sorted(float(o) for o in onset_hint):
            if h > onsets[0] - 0.05 and all(abs(h - o) > 0.15 for o in onsets):
                onsets.append(h)
        onsets.sort()
    return onsets


def segment_builtin_events(times: np.ndarray, pitches: np.ndarray,
                           energy: np.ndarray) -> list[tuple[float, float, float]]:
    """内置跟踪帧按起音切分成音高事件 [(start, end, midi)]，供无外部传感器时的
    自动定位 / 自动小节同步使用。事件内音高取有声音频帧中位数；短于 0.09 s 或
    超出 36–96 的段由 usable_events 剔除（重叠只容忍舍入误差 1 ms）。"""
    gate = max(0.012, float(np.max(energy)) * 0.10)
    onsets = detect_builtin_onsets(times, pitches, energy)
    events = []
    end_cap = float(times[-1]) + 0.05
    for a, b in zip(onsets, onsets[1:] + [end_cap]):
        sel = [float(pitches[i]) for i in range(len(times))
               if a <= float(times[i]) < b and np.isfinite(pitches[i]) and energy[i] > gate]
        if not sel:
            continue
        midi = float(np.median(sel))
        if b - a >= 0.09 and 36 <= midi <= 96:
            if events and a < events[-1][1] - 0.001:
                a = events[-1][1]
            if b - a >= 0.09:
                events.append((a, b, midi))
    return events


def transpose_score_xml(xml: str, semitones: int) -> str:
    """整曲移调（仅改 <pitch><octave>，须为整八度）：八度错位谱面的补救通道。
    其余结构原样回写；打分仍走同一套解析，拍号/时值/小节线不受影响。"""
    if semitones % 12:
        raise ValueError("仅支持整八度移调")
    steps = semitones // 12
    root = ET.fromstring(xml)
    for pitch in root.iter():
        if pitch.tag.rsplit("}", 1)[-1] != "pitch":
            continue
        octave = None
        for child in pitch:
            if child.tag.rsplit("}", 1)[-1] == "octave":
                octave = child
                break
        if octave is None or octave.text is None:
            raise ValueError("MusicXML 音高缺少 octave")
        octave.text = str(int(octave.text) + steps)
    return ET.tostring(root, encoding="unicode")


def _usable_excerpt(excerpt: dict) -> bool:
    """补救可用的对齐：confident 直接可用；全局线残差超标（中途停顿类）时，
    只要音高吻合（cost<=0.90）、速度在乐理范围内、匹配数/覆盖率达标且有分段
    锚点，仍可用——markers 本来就走分段锚点，不走全局线。其它 fail-closed
    （不吻合/歧义）照常抛异常，由调用方转 advice。"""
    if excerpt.get("boundarySupported") is False:
        return False
    if excerpt.get("confident"):
        return True
    slope = excerpt.get("quarterPeriod")
    return (excerpt.get("cost", 9) <= 0.90 and excerpt.get("matched", 0) >= 8
            and (excerpt.get("coverage") or 0) >= 0.5 and bool(excerpt.get("anchors"))
            and slope is not None and 0.15 <= slope <= 2.0)


ALIGN_GRID_MAX_DEV = 0.5


def _alignment_grid(alignment, notes, base_beat, sec_per_beat, start, beat_time):
    """Measure-level timeline from a confident alignment, or None when the
    current grid already agrees with it within ALIGN_GRID_MAX_DEV seconds."""
    if not alignment.get("confident") or not alignment.get("quarterPeriod"):
        return None
    mt = alignment.get("measureTimes") or []
    if len(mt) < 2:
        return None
    first = {}
    for n in notes:
        first.setdefault(n["measure"], n["onsetBeat"])
    pts = sorted((first[m["measure"]], m["audioSec"]) for m in mt if m["measure"] in first)
    if len(pts) < 2:
        return None
    qs = np.array([q for q, _ in pts])
    ts = np.array([t for _, t in pts])
    if np.any(np.diff(qs) <= 0) or np.any(np.diff(ts) <= 0):
        return None
    slope = float(alignment["quarterPeriod"])

    def grid(rel):
        return beat_time(rel) if beat_time is not None else start + (rel + base_beat) * sec_per_beat
    dev = max(abs(grid(q - base_beat) - t) for q, t in pts)
    if dev <= ALIGN_GRID_MAX_DEV:
        return None

    def align_time(rel):
        q = rel + base_beat
        if q <= qs[0]:
            return float(ts[0] + (q - qs[0]) * slope)
        if q >= qs[-1]:
            return float(ts[-1] + (q - qs[-1]) * slope)
        return float(np.interp(q, qs, ts))
    return align_time


def _anchor_tempo(anchors: list, fallback: float) -> float:
    """分段锚点的稳健速度（秒/拍）：中途停顿时全局拟合斜率被污染（跨停顿的
    配对拉高斜率），按段取中位数并丢掉 gap 超过 2 倍中位数的段。"""
    segs = [(q2 - q1, t2 - t1) for (q1, t1), (q2, t2) in zip(anchors, anchors[1:])
            if q2 > q1 and t2 > t1]
    if len(segs) < 2:
        return fallback
    rates = sorted(dt / dq for dq, dt in segs)
    med = rates[len(rates) // 2]
    kept = [r for r in rates if r <= 2 * med]
    return float(np.median(kept)) if kept else fallback


def _interior_silence_gaps(times: np.ndarray, energy: np.ndarray, onsets: list[float],
                           duration_sec: float, min_gap: float = 0.5) -> list[tuple[float, float]]:
    """录音中段的静音 gap（中途停顿/分段练习的直接证据）：能量 < 0.012 持续超过
    min_gap 秒，且既不在开头回溯区也不在结尾。谱面内的休止符也会形成 gap，
    但 gap 本身只在刚性网格已解释失败时才作为补救原因采用。"""
    gaps = []
    n = len(times)
    i = 0
    while i < n:
        if energy[i] < 0.012:
            j = i
            while j < n and energy[j] < 0.012:
                j += 1
            a, b = float(times[i]), float(times[j - 1])
            if b - a > min_gap and a > onsets[0] + 0.5 and b < duration_sec - 1.0:
                gaps.append((a, b))
            i = j
        else:
            i += 1
    return gaps


# 0.28 漂移补救: 刚性/活网格结果的音高匹配率低于此值就试按小节重对齐, 补救后
# 匹配率至少高出 DRIFT_RESCUE_GAIN 才采用。E31 节拍器同步 0.39 -> 0.89。
DRIFT_RESCUE_MATCH = 0.6
DRIFT_RESCUE_GAIN = 0.15
# 0.29 局部微调: 全局重对齐失败 (重复乐句分不清) 时, 每小节在 ±0.75 s 内找
# 让本小节音高最吻合的平移, 相邻小节平移变化按 LOCAL_REFINE_JUMP_COST 每 0.1 s 计罚。
LOCAL_REFINE_MAX_SEC = 0.75
LOCAL_REFINE_STEP_SEC = 0.03
LOCAL_REFINE_JUMP_COST = 1.0

# 0.30: 整段录音常以 10-20 s 空弦调音开头 (No.03/No.17 s0)。指定起始小节时
# 首个起音就是时间零点, 调音会让整段错位。只在谱面开头的 12 个音在后面
# 明显吻合、而录音开头明显不吻合时才跳过; 正常录音不动。
LEAD_IN_NOTES = 12
LEAD_IN_MAX_SEC = 60.0
LEAD_IN_MIN_SEC = 1.5
LEAD_IN_MATCH = 0.6
LEAD_IN_MARGIN = 0.25
LEAD_IN_PAD_SEC = 0.15


def _opening_match(midis: list[float], opening: list[float]) -> float:
    """Fraction of the score opening found in order (LCS, +-1 semitone)."""
    prev = [0] * (len(opening) + 1)
    for m in midis:
        cur = [0]
        for j, o in enumerate(opening):
            cur.append(prev[j] + 1 if abs(m - o) <= 1.0 else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1] / len(opening)


def detect_lead_in(events: list, notes: list[dict]) -> float | None:
    """Audio second where the score opening starts after a tuning lead-in, or None."""
    opening = [float(n["pitchMidi"]) for n in notes[:LEAD_IN_NOTES]]
    if len(opening) < 8 or len(events) < len(opening):
        return None
    midis = [float(np.min(m)) if isinstance(m, (list, tuple)) else float(m) for _, _, m in events]
    first = float(events[0][0])
    window = len(opening) + 3
    cands = [i for i, e in enumerate(events) if float(e[0]) - first <= LEAD_IN_MAX_SEC]
    scores = [_opening_match(midis[i:i + window], opening) for i in cands]
    best = max(scores)
    if best < LEAD_IN_MATCH or scores[0] > best - LEAD_IN_MARGIN:
        return None
    # Earliest near-best window whose first event is itself one of the first notes,
    # so a tuning note just before the opening is not taken as the start.
    for i, s in zip(cands, scores):
        if s >= best - 0.05 and any(abs(midis[i] - o) <= 1.0 for o in opening[:2]):
            start = float(events[i][0])
            return start if start - first >= LEAD_IN_MIN_SEC else None
    return None


def _local_grid_refine(notes: list[dict], boundaries: dict[int, float], times: np.ndarray,
                       pitches: np.ndarray, duration_sec: float) -> list[dict]:
    """网格逐渐漂移 (Dotzauer No.20: 前 15 小节全对, 之后演奏一路晚到 0.6 s) 而全局
    重对齐失败时的兜底: 小节起点 = 原网格时刻 + 平滑平移 (Viterbi)。只移小节边界,
    小节内照常评分; 返回 [] 表示无从改进。notes 为已打分音符 (expectedSec/onsetBeat)。"""
    pts = sorted({(float(n["onsetBeat"]), float(n["expectedSec"])) for n in notes
                  if n.get("expectedSec") is not None and n.get("onsetBeat") is not None})
    if len(pts) < 12:
        return []
    beats, secs = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
    measures = sorted({n["measure"] for n in notes})
    shifts = np.arange(-LOCAL_REFINE_MAX_SEC, LOCAL_REFINE_MAX_SEC + 1e-9, LOCAL_REFINE_STEP_SEC)
    row = {m: i for i, m in enumerate(measures)}
    gain = np.zeros((len(measures), len(shifts)))
    for v in notes:
        if v.get("expectedEndSec") is None or v.get("expectedSec") is None:
            continue
        a, b = float(v["expectedSec"]), float(v["expectedEndSec"])
        want = np.asarray([v["pitchMidi"]] + list(v.get("chordMidi") or []), dtype=float)
        # 整音窗 [a+s, b+s) 内吻合帧占比: 平移恰好对准时最高 (只看中位数会在 ±半音长内一样好)。
        st, en = np.searchsorted(times, a + shifts), np.searchsorted(times, b + shifts)
        lo, hi = int(st.min()), int(en.max())
        seg = pitches[lo:hi]
        with np.errstate(invalid="ignore"):
            hits = np.isfinite(seg) & (np.min(np.abs(seg[:, None] - want[None, :]), axis=1) < 0.35)
        cs = np.concatenate([[0], np.cumsum(hits)])
        total = en - st
        gain[row[v["measure"]]] += np.where(total >= 2, (cs[en - lo] - cs[st - lo]) / np.maximum(total, 1), 0.0)
    jump = LOCAL_REFINE_JUMP_COST * np.abs(shifts[:, None] - shifts[None, :]) / 0.1
    total, back = gain[0].copy(), []
    for i in range(1, len(measures)):
        cand = total[:, None] - jump  # [prev, cur]
        back.append(np.argmax(cand, axis=0))
        total = cand.max(axis=0) + gain[i]
    path = [int(np.argmax(total))]
    for bp in reversed(back):
        path.append(int(bp[path[-1]]))
    path.reverse()
    if gain[np.arange(len(measures)), path].sum() <= gain[:, len(shifts) // 2].sum():
        return []
    markers = []
    for i, m in enumerate(measures + [measures[-1] + 1]):
        if m not in boundaries:
            return []
        sec = float(np.interp(boundaries[m], beats, secs, left=np.nan, right=np.nan))
        if not np.isfinite(sec):
            # 曲末边界在最后一个音之后: 按最后两音的拍速外推。
            spb = (secs[-1] - secs[-2]) / max(beats[-1] - beats[-2], 1e-6)
            sec = secs[-1] + (boundaries[m] - beats[-1]) * spb
        sec += float(shifts[path[min(i, len(path) - 1)]])
        markers.append({"measure": int(m), "audioSec": float(round(max(0.0, min(sec, duration_sec)), 3))})
    if any(b["audioSec"] <= a["audioSec"] for a, b in zip(markers, markers[1:])):
        return []
    return markers


def _needs_rescue_check(pitch_score, rhythm_score, confidence) -> bool:
    """刚性网格疑似解释失败才进入代价较高的自动对齐：分够不上或出不了分。
    好片段（音准节奏都在正常区间）永远走原路径，零行为变化。"""
    if pitch_score is None or rhythm_score is None:
        return True
    if pitch_score < 40 or rhythm_score == 0:
        return True
    return confidence == "low" and (pitch_score < 70 or (rhythm_score or 100) < 50)


def _auto_measure_sync(*, xml: str, notes: list[dict], times: np.ndarray,
                       pitches: np.ndarray, energy: np.ndarray, sec_per_beat: float,
                       duration_sec: float, requested_start: int, score_last: int,
                       rigid_start: float, onsets: list[float],
                       pitch_notes: list | None = None,
                       signal=None, rate=None, suspect: str | None = None) -> dict:
    """刚性网格解释失败时的补救：用音高证据重对齐并返回小节级网格。

    (0, -12, +12) 依次试 align_excerpt（不移调优先：移调候选须明显更优才胜出，
    见内联 margin），confident 者胜出；胜出后按证据性质记录原因：octave
    （整体差八度）、tempo（速度比出 [0.8, 1.25] 带）、pause（录音中段有超过
    0.5 s 的静音 gap）、offset（对齐起点与刚性起点差 > 0.30 s，录音开头有多余
    内容）、range（定位范围与所选/谱面跨度不一致）。有原因才返回 markers
    （与手动点选同等地位：只定小节边界，小节内照常评分）；全败或无原因时
    markers 为空，调用方保留刚性结果（失败原因进 advice，绝不静默零分）。
    """
    plan: dict = {"shift": 0, "alignment": None, "markers": [], "reasons": [], "attempts": [],
                  "detected_bpm": None, "advice": None, "limitations": [],
                  "start_measure": requested_start}
    events = usable_events(pitch_notes) if pitch_notes else segment_builtin_events(times, pitches, energy)
    if len(events) < 8:
        plan["advice"] = "可用音高事件不足 8 个，无法自动对齐；可使用手动小节同步逐小节对齐后重分析。"
        return plan
    def _run_shifts(ev, tag):
        found: list[tuple[float, int, dict]] = []
        errs: list[str] = []
        boundary_msg = None
        for shift in OCTAVE_SEARCH_SHIFTS:
            shifted = notes if shift == 0 else [
                {**n, "pitchMidi": float(n["pitchMidi"]) + shift,
                 **({"chordMidi": [p + shift for p in n["chordMidi"]]} if n.get("chordMidi") else {})}
                for n in notes]
            try:
                excerpt = align_excerpt(shifted, ev)
            except ValueError as exc:
                errs.append(str(exc))
                plan["attempts"].append({"shift": shift, "reason": "error", "detail": str(exc), "events": tag})
                continue
            if _usable_excerpt(excerpt):
                found.append((excerpt["cost"], shift, excerpt))
                plan["attempts"].append({"shift": shift, "reason": "usable", "events": tag})
            elif excerpt.get("boundarySupported") is False:
                boundary_msg = "谱面与录音首尾的时间证据冲突，不能确认覆盖范围；请检查谱面是否完整"
                plan["attempts"].append({"shift": shift, "reason": "boundary_unsupported", "events": tag})
            else:
                plan["attempts"].append({"shift": shift, "reason": "unusable", "events": tag})
        return found, errs, boundary_msg

    cands, failures, boundary_failure = _run_shifts(events, "pyin")
    if not cands and signal is not None and rate:
        # 0.23: pYIN 事件分不出重复句 / 边界不支持时, 用独立传感器 BP 再试一轮
        # (no23 slow: pYIN 三 shift 全败, BP 对齐可出 tempo 网格; no16 fast:
        # pYIN boundary_unsupported, BP 有机会给出可用 excerpt)。pYIN-first:
        # 今天能救起来的片段走原路径零变化; BP 也败则 advice 原样。
        _bp_ev = _bp_locate_events(signal, rate, chords=True) if any(n.get("chordMidi") for n in notes) \
            else _bp_locate_events(signal, rate)
        if _bp_ev and len(_bp_ev) >= 8:
            _bp_cands, _bp_failures, _ = _run_shifts(_bp_ev, "bp")
            if _bp_cands:
                cands, events = _bp_cands, _bp_ev
    if not cands:
        msg = boundary_failure or (failures[0] if failures else "录音片段与乐谱不吻合；请指定起始小节")
        plan["advice"] = f"自动对齐失败（{msg}）；可使用手动小节同步逐小节对齐后重分析。"
        return plan
    cands.sort(key=lambda c: c[0])
    # 不移调优先：DTW 本就给整八度差打折（0.75/音），八度错位的录音在 shift 0 下
    # 也能 "confident"。只有移调候选明显更优（>0.10）才认定八度错位。
    zero = next((c for c in cands if c[1] == 0), None)
    if zero is not None and zero[0] <= cands[0][0] + 0.10:
        winner = (zero[1], zero[2])
    else:
        winner = (cands[0][1], cands[0][2])
    shift, excerpt = winner
    slope = excerpt["quarterPeriod"]
    anchors = excerpt.get("anchors") or []
    # 速度用分段锚点算：中途停顿会污染全局拟合斜率（跨停顿配对拉高斜率）。
    tempo = _anchor_tempo(anchors, slope)
    ratio = tempo / sec_per_beat if sec_per_beat > 0 else 1.0
    t0 = excerpt["t0"]
    reasons = []
    if shift:
        reasons.append("octave")
    if not TEMPO_BAND[0] <= ratio <= TEMPO_BAND[1]:
        reasons.append("tempo")
    if _interior_silence_gaps(times, energy, onsets, duration_sec):
        reasons.append("pause")
    if abs(t0 - rigid_start) > 0.30:
        reasons.append("offset")
    boundaries = measure_start_beats(xml, include_end=True)
    # Only complete measures inside the actually matched score range can be
    # rescued. Partial first/last measures must not be extrapolated to full ones.
    lo_m = notes[excerpt["start"]]["measure"]
    hi_m = notes[excerpt["end"]]["measure"]
    if any(n["measure"] == lo_m for n in notes[:excerpt["start"]]):
        lo_m += 1
    if any(n["measure"] == hi_m for n in notes[excerpt["end"] + 1:]):
        hi_m -= 1
    if lo_m > hi_m:
        plan["advice"] = "定位片段没有完整小节，无法自动重建边界；请使用手动小节同步逐小节对齐后重分析。"
        return plan
    end_audio = excerpt["endAudioSec"]
    if lo_m != requested_start or hi_m < score_last or end_audio < events[-1][1] - 2.0:
        reasons.append("range")
    markers = []
    for m in range(lo_m, hi_m + 2):
        beat = boundaries.get(m)
        if beat is None:
            plan["advice"] = "定位到的小节超出谱面范围，无法重建网格；可使用手动小节同步逐小节对齐后重分析。"
            return {**plan, "markers": [], "reasons": []}
        sec = anchor_time(anchors, beat, slope) if anchors else t0 + slope * beat
        markers.append({"measure": m, "audioSec": round(max(0.0, min(sec, duration_sec)), 3)})
    if any(b["audioSec"] <= a["audioSec"] for a, b in zip(markers, markers[1:])):
        plan["advice"] = "自动对齐的小节时间不是单调递增，无法重建网格；可使用手动小节同步逐小节对齐后重分析。"
        return {**plan, "markers": [], "reasons": []}
    if not reasons and suspect:
        # 调用方已从音高证据看出网格漂移 (见 DRIFT_RESCUE_MATCH); 采不采用由调用方比匹配率决定。
        reasons.append(suspect)
    if not reasons:
        return plan
    plan.update(shift=shift, alignment=True, markers=markers, reasons=reasons,
                detected_bpm=round(60.0 / tempo / tracker_beat_quarters(xml), 1) if tempo > 0 else None,
                start_measure=markers[0]["measure"])
    lo_sec, hi_sec = markers[0]["audioSec"], markers[-1]["audioSec"]
    if shift:
        direction = "高" if shift < 0 else "低"
        plan["limitations"].append(f"谱面整体比录音{direction}八度，已移调后打分；请检查谱面文件是否正确。")
    if "tempo" in reasons:
        plan["limitations"].append(
            f"面板速度与实测 {plan['detected_bpm']} BPM 差别较大，已按实测速度对齐；可在面板上改成该速度。")
    if "drift" in reasons:
        plan["limitations"].append("检测到的拍点在曲中逐渐偏离演奏，已按音高证据逐小节重新对齐；小节内部节奏照常评分。")
    if "pause" in reasons:
        plan["limitations"].append("录音中途有停顿或明显变速，已按小节分段对齐；小节内部节奏照常评分。")
    if "offset" in reasons:
        plan["limitations"].append("录音开头有多余内容，已从定位到的乐段起点打分。")
    if "range" in reasons:
        plan["limitations"].append(
            f"只对第 {lo_m}–{hi_m} 小节定位到的乐段打分（{lo_sec:.1f}–{hi_sec:.1f}s），之外的内容未计入。")
    # 录音比谱面长（如只识别了一页谱的完整演奏）：对齐已在锚点可靠处截尾，
    # 明确告诉用户尾部不是“没拉好”，而是谱面里没有这段。
    trimmed = excerpt.get("tailTrimmedAfterSec")
    if trimmed is not None:
        extra = max(0.0, float(events[-1][1]) - float(trimmed))
        plan["take_beyond_score_after"] = trimmed
        plan["limitations"].append(
            f"录音在 {trimmed:.1f}s 之后还有约 {extra:.0f}s 内容与谱面对不上（第 {hi_m} 小节之后未评分）；"
            "谱面可能缺页或不完整，请检查谱面。")
    return plan


def tracker_beat_quarters(xml: str) -> float:
    """QM 拍点跟踪器一个拍点间隔走过的四分音符数: 单拍子 1, 复拍子
    (6/8·9/8·12/8, 面板按惯例填附点速度) 1.5。网格门限与下标映射都按它折算。"""
    root = xml_root(xml)
    time = root.find("./{*}part/{*}measure/{*}attributes/{*}time")
    try:
        beats = int(time.findtext("./{*}beats")) if time is not None else 4
        beat_type = int(time.findtext("./{*}beat-type")) if time is not None else 4
    except (TypeError, ValueError) as exc:
        raise ValueError("MusicXML 拍号无效") from exc
    return 1.5 if beat_type == 8 and beats in (6, 9, 12) else 1.0


def seconds_per_quarter(xml: str, bpm: float) -> float:
    """Convert the displayed tempo to the quarter-note beat used by notes.

    In compound eighth meters the conventional tempo unit is a dotted quarter
    (three eighths), while MusicXML durations and onsetBeat remain quarter
    notes.  Keeping this conversion here prevents a 6/8 take from drifting 50%
    slow against the score.
    """
    return 60.0 / bpm / tracker_beat_quarters(xml)


def _interp_beats(beats: np.ndarray, med: float, anchor: int, rel_beat: float) -> float:
    """拍点下标 -> 秒（无位移版 beat_time）：越界用中位间隔外推。"""
    pos = anchor + rel_beat
    if pos <= 0:
        return float(beats[0] + pos * med)
    if pos >= len(beats) - 1:
        return float(beats[-1] + (pos - (len(beats) - 1)) * med)
    i = int(pos)
    f = pos - i
    return float(beats[i] * (1 - f) + beats[i + 1] * f)


def _select_grid_scale(beats: np.ndarray, med: float, anchor: int, notes: list,
                       base_beat: float, times, pitches, confidence, scales,
                       anchor_shift: float = 0.0) -> float | None:
    """用音高证据验网格刻度：候选 1.0=四分脉冲 1:1，1.5=附点脉冲 /1.5，
    0.5=八分密网格（跟踪器锁在八分音符上时下标按 /0.5 折算，多见于慢速连奏）。
    窗内音高中位数与谱面音差 ≤1.5 半音算命中；赢家须 ≥0.6，多候选时还须
    ≥1.4 倍于次名，单候选须 ≥0.7，否则 None。只统计录音覆盖的音符。"""
    if med <= 0 or len(beats) < 2 or not notes:
        return None
    span = (float(beats[-1]) - float(beats[0])) / med
    cov = [n for n in notes if n["onsetBeat"] - base_beat <= span + 2.0]
    if len(cov) < 4:
        return None
    t = np.asarray(times)
    p = np.asarray(pitches)
    c = np.asarray(confidence)
    agree = {}
    for scale in scales:
        hit = total = 0
        for n in cov:
            rel = n["onsetBeat"] - base_beat
            t0 = _interp_beats(beats, med, anchor, rel / scale) + anchor_shift
            t1 = _interp_beats(beats, med, anchor, (rel + n["durationBeat"]) / scale) + anchor_shift
            lo, hi = t0 + (t1 - t0) * 0.3, t1 - (t1 - t0) * 0.3
            m = (t >= lo) & (t <= hi) & np.isfinite(p) & (c >= 0.7)
            if int(m.sum()) < 3:
                continue
            total += 1
            if abs(float(np.median(p[m])) - n["pitchMidi"]) <= 1.5:
                hit += 1
        agree[scale] = hit / total if total >= 4 else 0.0
    best = max(scales, key=lambda s: agree[s])
    if agree[best] < 0.6:
        return None
    if len(scales) == 1:
        return best if agree[best] >= 0.7 else None
    others = [agree[s] for s in scales if s != best]
    if others and agree[best] >= 1.4 * max(others):
        return best
    return None


def _select_grid_phase(beats: np.ndarray, med: float, anchor: int, notes: list,
                       base_beat: float, pitch_notes: list, beat_quarters: float,
                       base_shift: float = 0.0) -> float:
    """用 pYIN 音符段验活网格相位：QM 只给拍点时间戳，相位不可信。
    6/8 这类连续八分音符里最近拍点有 50% 概率锁到弱拍相位（半个脉冲偏差），
    前导拍点漏检时还会差整脉冲；网格整体平移半/一个脉冲后，每个音符窗口
    落到邻音上，时值看似正常但音高全错（Dotzauer No.5 实测：相位差 1 个
    八分音符时 pitchScore 0→100 只差这一项）。
    候选 {0, +0.5, -0.5, +1, -1} 个脉冲：每个音符取期望起音最近的 pYIN 段首
    （一个脉冲内，否则该音弃权），段内音高与谱面差 ≤1.5 半音算命中；
    赢家须 ≥0.6，领先次名 ≥0.15 直接锁；多候选并列（慢速连奏里半脉冲/
    整脉冲可能同时全中）时按平均残差（段首贴期望起音程度）打破，残差
    差 <0.03s 才算真含糊、返回 0.0（保持原锚点）。只统计录音覆盖的
    音符；可投票音符 <8 直接弃权，避免短片段误判。返回脉冲数偏移。"""
    if med <= 0 or len(beats) < 2 or not notes or not pitch_notes:
        return 0.0
    span = (float(beats[-1]) - float(beats[0])) / med
    cov = [n for n in notes if n["onsetBeat"] - base_beat <= span + 2.0]
    if len(cov) < 8:
        return 0.0
    try:
        seg_starts = np.array([float(a) for a, _, _ in pitch_notes])
        seg_midis = np.array([float(m) for _, _, m in pitch_notes])
    except (TypeError, ValueError):
        return 0.0
    if len(seg_starts) == 0:
        return 0.0
    cands = (0.0, 0.5, -0.5, 1.0, -1.0)
    agree: dict[float, float] = {}
    mean_resid: dict[float, float] = {}
    for cand in cands:
        hit = total = 0
        resid = 0.0
        for n in cov:
            rel = n["onsetBeat"] - base_beat
            t0 = _interp_beats(beats, med, anchor, rel / beat_quarters) + base_shift + cand * med
            j = int(np.argmin(np.abs(seg_starts - t0)))
            if abs(float(seg_starts[j]) - t0) > med:
                continue
            total += 1
            resid += abs(float(seg_starts[j]) - t0)
            if abs(float(seg_midis[j]) - n["pitchMidi"]) <= 1.5:
                hit += 1
        agree[cand] = hit / total if total >= 8 else 0.0
        mean_resid[cand] = resid / total if total else math.inf
    best = min(cands, key=lambda c: (-agree[c], abs(c)))
    if agree[best] < 0.6:
        return 0.0
    contenders = [c for c in cands if agree[c] > agree[best] - 0.15]
    if len(contenders) == 1:
        return best
    # 并列时用平均残差打破：段首越贴期望起音相位越真；残差也分不开
    # （如全同音重复句）才算真含糊，保持原锚点。
    ranked = sorted(contenders, key=lambda c: (mean_resid[c], abs(c)))
    if len(ranked) > 1 and mean_resid[ranked[1]] - mean_resid[ranked[0]] < 0.03:
        return 0.0
    return ranked[0]


BP_TIMEOUT_SEC = 30
_BP_CACHE_CAP = 64
_BP_CACHE: OrderedDict = OrderedDict()
_BP_ACT_CACHE_CAP = 8
_BP_ACT_CACHE: OrderedDict = OrderedDict()


def bp_monophonic(notes, window: float = 0.05, head: float = 0.05) -> list:
    """Basic Pitch notes -> monophonic, time-ordered (start, end, midi) events.

    Onsets within `window` of a group's first onset form one group and the lowest
    pitch wins (upper partials are the usual false extra). Each note ends 1 ms
    before the next onset, so usable_events sees no overlap. Onsets in the first
    `head` seconds are dropped: the excerpt cut re-attacks the previous measure's
    tail there, which located one measure early in the lab."""
    rows = []
    for item in notes or []:
        try:
            start, end, midi = float(item[0]), float(item[1]), float(item[2])
        except (TypeError, ValueError, IndexError):
            continue
        if (math.isfinite(start) and math.isfinite(end) and math.isfinite(midi)
                and start >= head and end > start):
            rows.append((start, end, midi))
    rows.sort()
    groups = []
    for row in rows:
        if groups and row[0] - groups[-1][0][0] <= window:
            groups[-1].append(row)
        else:
            groups.append([row])
    out = [list(min(group, key=lambda r: r[2])) for group in groups]
    for i in range(len(out) - 1):
        out[i][1] = min(out[i][1], out[i + 1][0] - 0.001)
    return [tuple(r) for r in out if r[1] > r[0]]


# 0.25 chord grouping: a cellist rolls a chord (bass 0.2-0.4 s ahead), so its
# tones start up to BP_ROLL_SEC apart but ring together; successive melody
# notes barely overlap. A note joins the open group if it starts within 50 ms
# of the group's first onset (as bp_monophonic), or within BP_ROLL_SEC while
# overlapping a sounding member by more than BP_RING_SEC.
BP_ROLL_SEC = 0.40
BP_RING_SEC = 0.10


def bp_chords(notes, head: float = 0.05) -> list:
    """Basic Pitch notes -> time-ordered (start, end, pitches) events; pitches is
    always a sorted tuple, even for one note (see alignment._match_cost)."""
    rows = []
    for item in notes or []:
        try:
            start, end, midi = float(item[0]), float(item[1]), float(item[2])
        except (TypeError, ValueError, IndexError):
            continue
        if (math.isfinite(start) and math.isfinite(end) and math.isfinite(midi)
                and start >= head and end > start):
            rows.append((start, end, midi))
    rows.sort()
    groups = []
    for row in rows:
        lead = row[0] - groups[-1][0][0] if groups else None
        if groups and (lead <= 0.05 or (lead <= BP_ROLL_SEC and
                                        row[0] < max(r[1] for r in groups[-1]) - BP_RING_SEC)):
            groups[-1].append(row)
        else:
            groups.append([row])
    out = []
    for group in groups:
        pitches = tuple(sorted({r[2] for r in group}))
        out.append([group[0][0], max(r[1] for r in group), pitches])
    for i in range(len(out) - 1):
        out[i][1] = min(out[i][1], out[i + 1][0] - 0.001)
    return [tuple(r) for r in out if r[1] > r[0]]


def _bp_locate_events(signal, rate, chords: bool = False):
    """Optional Basic Pitch events for auto-locate. None unless SCOREFOLLOW_BP_PYTHON
    names a venv interpreter with basic-pitch[onnx]; any failure or timeout -> None,
    so locate falls back to pYIN and the fused events exactly as in 0.11.
    chords=True groups simultaneous notes (bp_chords) for chord scores; the raw
    notes are cached so both reductions share one inference.
    0.29: 定位用的 BP 吃高通后的信号 (低频隆隆声让 No.23 s1 三个 shift 全败)。"""
    raw = _bp_raw_notes(string_highpass(signal, rate), rate)
    if raw is None:
        return None
    return (bp_chords(raw) if chords else bp_monophonic(raw)) or None


def _bp_raw_notes(signal, rate):
    return _bp_run(signal, rate)[0]


def _bp_note_activation(signal, rate):
    """Frame-level Basic Pitch note activation (frames x 88 keys) for chord intonation.
    Kept in a small separate cache (long takes are MBs); a miss re-runs the same inference."""
    return _bp_run(signal, rate, need_act=True)[1]


def _bp_run(signal, rate, need_act=False):
    """(notes or None, activation or None); failures are cached as (None, None)."""
    import os
    python = os.environ.get('SCOREFOLLOW_BP_PYTHON', '').strip()
    if not python:
        return None, None
    import hashlib
    import json
    import subprocess
    import tempfile
    x = np.ascontiguousarray(signal, dtype=np.float32)
    key = (hashlib.blake2b(x.tobytes(), digest_size=16).digest(), int(rate))
    if key in _BP_CACHE and (not need_act or key in _BP_ACT_CACHE or _BP_CACHE[key] is None):
        _BP_CACHE.move_to_end(key)
        if key in _BP_ACT_CACHE:
            _BP_ACT_CACHE.move_to_end(key)
        return _BP_CACHE[key], _BP_ACT_CACHE.get(key)
    notes, act = None, None
    try:
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bp_worker.py')
        with tempfile.TemporaryDirectory(prefix='sf-bp-') as tmp:
            wav_path = os.path.join(tmp, 'in.wav')
            out_path = os.path.join(tmp, 'out.json')
            pcm = (np.clip(x, -1.0, 1.0) * 32767).astype('<i2').tobytes()
            with wave.open(wav_path, 'wb') as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(int(rate))
                handle.writeframes(pcm)
            subprocess.run([python, '-I', '-B', worker, wav_path, out_path], cwd=tmp,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=BP_TIMEOUT_SEC, check=True)
            with open(out_path, encoding='utf-8') as handle:
                raw = json.load(handle)
            try:
                act = np.load(out_path + '.note.npy')
                if act.ndim != 2 or act.shape[1] != 88:
                    act = None
            except Exception:
                act = None
        notes = raw.get('notes') if isinstance(raw.get('notes'), list) else None
    except Exception:
        notes, act = None, None
    _BP_CACHE[key] = notes
    while len(_BP_CACHE) > _BP_CACHE_CAP:
        _BP_CACHE.popitem(last=False)
    if act is not None and notes is not None:
        _BP_ACT_CACHE[key] = act
        while len(_BP_ACT_CACHE) > _BP_ACT_CACHE_CAP:
            _BP_ACT_CACHE.popitem(last=False)
    return notes, (act if notes is not None else None)


CREPE_TIMEOUT_SEC = 240
CREPE_VOICING_MIN = 0.5
CREPE_MIN_FRAMES = 4
# 有界接管门限: |pYIN|>1000c 是拉住的单音物理上不可能的位置 (实测崩溃案
# 例 no31 n98 报 +4990c, 三全音串音原型复现同值), 只在这种荒谬值上才允许
# CREPE 接管; 看似合理的 pYIN 读数永远不动。
CREPE_OVERRIDE_ABSURD_CENTS = 1000.0
_CREPE_CACHE_CAP = 16
_CREPE_CACHE: OrderedDict = OrderedDict()


def crepe_backend() -> str:
    """Which CREPE transport is configured: 'remote' (resident GPU worker) wins
    over 'cpu' (local subprocess); 'none' disables CREPE second opinions."""
    import os
    if os.environ.get('SCOREFOLLOW_CREPE_URL', '').strip():
        return 'remote'
    if os.environ.get('SCOREFOLLOW_CREPE_PYTHON', '').strip():
        return 'cpu'
    return 'none'


def _crepe_enabled():
    """CREPE worker env 是否就绪。请求路径只在有缺测窗时才调 _crepe_track。"""
    return crepe_backend() != 'none'


def _merge_spans(windows, pad=0.25, limit=None):
    """合并加窗: 每段双向 pad, 钳制 [0, limit], 重叠合并。返回 [(lo, hi)]。"""
    spans = []
    for lo, hi in windows:
        a = max(0.0, lo - pad)
        b = hi + pad
        if limit is not None:
            b = min(b, limit)
        if b > a:
            spans.append([a, b])
    spans.sort()
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def _write_crepe_wav(x, wav_path, rate):
    pcm = (np.clip(x, -1.0, 1.0) * 32767).astype('<i2').tobytes()
    with wave.open(wav_path, 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(pcm)


def _read_crepe_out(out_path):
    import json
    with open(out_path, encoding='utf-8') as handle:
        raw = json.load(handle)
    times = np.asarray(raw.get('times'), dtype=np.float64)
    midi = np.asarray(raw.get('midi'), dtype=np.float64)
    voicing = np.asarray(raw.get('voicing'), dtype=np.float64)
    if times.ndim == 1 and midi.shape == times.shape and voicing.shape == times.shape and len(times) >= 8:
        return (times, midi, voicing)
    return None


def _crepe_tracks(signals, rate):
    """Batch tracks via resident GPU when configured, otherwise local worker.
    Both use full CREPE and PCM16 input; decoder dithering can shift readings
    near scoring boundaries either way. Remote failure degrades to pYIN-only
    (fail-closed) and never falls through to the slow CPU worker.
    """
    import os
    out = [None] * len(signals)
    python = os.environ.get('SCOREFOLLOW_CREPE_PYTHON', '').strip()
    remote = os.environ.get('SCOREFOLLOW_CREPE_URL', '').strip()
    if not (python or remote) or not signals:
        return out
    import hashlib
    import subprocess
    import tempfile
    pending = []
    for i, signal in enumerate(signals):
        x = np.ascontiguousarray(signal, dtype=np.float32)
        key = (hashlib.blake2b(x.tobytes(), digest_size=16).digest(), int(rate))
        if remote:
            key = (*key, remote)
        if key in _CREPE_CACHE:
            _CREPE_CACHE.move_to_end(key)
            out[i] = _CREPE_CACHE[key]
        else:
            pending.append((i, key, x))
    if pending:
        if remote:
            from .crepe_remote import remote_tracks
            try:
                tracks = remote_tracks([x for _i, _key, x in pending], rate, remote)
            except Exception:
                return out  # fail-closed to pYIN; never the CPU subprocess
            for (i, key, _x), track in zip(pending, tracks):
                _CREPE_CACHE[key] = track
                while len(_CREPE_CACHE) > _CREPE_CACHE_CAP:
                    _CREPE_CACHE.popitem(last=False)
                out[i] = track
            return out
        try:
            worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'crepe_worker.py')
            with tempfile.TemporaryDirectory(prefix='sf-crepe-') as tmp:
                args = []
                for j, (_i, _key, x) in enumerate(pending):
                    wav_path = os.path.join(tmp, 'in%d.wav' % j)
                    out_path = os.path.join(tmp, 'out%d.json' % j)
                    _write_crepe_wav(x, wav_path, rate)
                    args += [wav_path, out_path]
                subprocess.run([python, '-I', '-B', worker] + args, cwd=tmp,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL,
                               timeout=CREPE_TIMEOUT_SEC + 60 * (len(pending) - 1), check=True)
                for j, (i, key, _x) in enumerate(pending):
                    track = _read_crepe_out(os.path.join(tmp, 'out%d.json' % j))
                    _CREPE_CACHE[key] = track
                    while len(_CREPE_CACHE) > _CREPE_CACHE_CAP:
                        _CREPE_CACHE.popitem(last=False)
                    out[i] = track
        except Exception:
            pass
    return out


def _crepe_track(signal, rate):
    """Optional TorchCREPE f0 track for scoring second opinion. None unless
    SCOREFOLLOW_CREPE_PYTHON names a venv interpreter with torchcrepe; any
    failure or timeout -> None, so scoring falls back to pYIN exactly as in
    0.13. Returns (times, midi, voicing) float arrays or None.
    Single-signal path shares the batch implementation (one pair per call)."""
    return _crepe_tracks([signal], rate)[0]


def _apply_crepe_opinion(cents, detected, quality, pitch_midi, window, crepe_track):
    """CREPE second opinion for one scored note. window is (lo, hi) seconds or
    (None, None). Returns (cents, detected, quality, crepe_cents).
    v1 policy: gap-fill only -- a missing pYIN reading takes the CREPE median
    (>= 4 voiced frames); an existing pYIN reading is always kept and
    crepe_cents is recorded for audit. Probes: CREPE err 1-6c vs BP bend
    23-60c on detuned sines, so CREPE is the trustworthy filler. Lazy caller
    (analyze) only invokes this on missing-reading windows."""
    crepe_cents = None
    crepe_median = None
    crepe_quality = 0.0
    if crepe_track is not None and window[0] is not None and window[1] is not None:
        times, midi, voicing = crepe_track
        lo, hi = window
        sel = (times >= lo) & (times <= hi) & np.isfinite(midi) & (voicing >= CREPE_VOICING_MIN)
        if int(np.count_nonzero(sel)) >= CREPE_MIN_FRAMES:
            crepe_median = float(np.median(midi[sel]))
            crepe_cents = round((crepe_median - pitch_midi) * 100, 1)
            crepe_quality = round(float(np.median(voicing[sel])), 2)
    if cents is None and crepe_cents is not None:
        cents, detected, quality = crepe_cents, crepe_median, crepe_quality
    return cents, detected, quality, crepe_cents


def _restatus_crepe_entry(entry, cents, detected, tolerance):
    """CREPE 补/接管后的定性: 与主循环同规则 (classify + timing 组合)。
    不走 displaced 归因 (起音证据已在主循环消耗)。"""
    ps = classify_pitch(cents, detected, tolerance)
    entry["pitchStatus"] = ps
    ts = entry["timingStatus"]
    if ps in ("sharp", "flat"):
        entry["status"] = "wrong_pitch"
    elif ps == "octave":
        entry["status"] = "octave_uncertain"
    elif ps == "outlier":
        entry["status"] = "outlier"
    elif ts in ("late", "early"):
        entry["status"] = ts
    elif ts == "unscored":
        entry["status"] = "correct"
    else:
        entry["status"] = "timing_uncertain"


def _run_crepe_verdicts(aligned, items, signal, rate, tolerance):
    """主循环后的 lazy CREPE 裁决, 返回补齐数 (计入 measured 的增量)。
    gap (pYIN 缺测) 取 CREPE 中位数; suspect (|pYIN|>1000c, 拉住的单音物理
    不可能) 且 CREPE 窗内有声 (>=4 帧) 时由 CREPE 接管并记 crepeOverride,
    同时清掉 stale 的 displaced 归因。pYIN 看似合理时永远不动。"""
    delta = 0
    if not items or not _crepe_enabled():
        return delta
    done = set()
    jobs = []
    for slo, shi in _merge_spans([(g["lo"], g["hi"]) for g in items],
                                 pad=0.25, limit=len(signal) / rate):
        seg = signal[int(slo * rate):int(shi * rate)]
        if len(seg) < 8:
            continue
        jobs.append((slo, shi, seg))
    # One worker process for all spans (model loads once); verdicts are
    # equivalent to per-span calls (median-stable, see _crepe_tracks).
    tracks = _crepe_tracks([seg for _slo, _shi, seg in jobs], rate)
    for (slo, shi, _seg), track in zip(jobs, tracks):
        if track is None:
            continue
        t3 = (track[0] + slo, track[1], track[2])
        for g in items:
            if g["index"] in done:
                continue
            if not (slo <= g["lo"] and g["hi"] <= shi):
                continue
            entry = aligned[g["index"]]
            if g["kind"] == "gap":
                fc, fd, fq, fcc = _apply_crepe_opinion(
                    None, None, 0.0, g["pitchMidi"], (g["lo"], g["hi"]), t3)
                if fc is None:
                    continue
                # 0.20: 兜底窗或无起音短音, CREPE 差三度以上多半是邻音, 与主循环同规则不指控。
                if abs(fc) > 200 and (g.get("fallback") or g.get("noOnsetShort")):
                    continue
                if g.get("fallback"):
                    entry["crepeFallback"] = True
                entry["pitchErrorCents"] = fc
                entry["confidence"] = fq
                entry["crepeCents"] = fcc
                entry["matchStatus"] = "matched"
                _restatus_crepe_entry(entry, fc, fd, tolerance)
                if not g.get("counted"):
                    delta += 1
            else:
                if entry["pitchErrorCents"] is None:
                    continue
                if abs(entry["pitchErrorCents"]) <= CREPE_OVERRIDE_ABSURD_CENTS:
                    done.add(g["index"])
                    continue
                _, fd, fq, fcc = _apply_crepe_opinion(
                    entry["pitchErrorCents"], None, 0.0, g["pitchMidi"],
                    (g["lo"], g["hi"]), t3)
                if fcc is None:
                    continue
                entry["pitchErrorCents"] = fcc
                entry["confidence"] = fq
                entry["crepeCents"] = fcc
                entry["crepeOverride"] = True
                entry["matchStatus"] = "matched"
                entry["rawPitchErrorCents"] = None
                entry["pitchDisplaced"] = False
                entry["displacedFromMeasure"] = None
                _restatus_crepe_entry(entry, fcc, fd, tolerance)
            done.add(g["index"])
    return delta


def _fused_locate_events(signal, rate):
    """Optional onset+pitch-track events for the locate fallback; None without vamp."""
    from .vamp_features import extract_fused_events
    return extract_fused_events(signal, rate)


def analyze(wav: bytes, xml: str, bpm: float, instrument: str, start_measure: int = 1,
            first_beat_audio_sec: float | None = None, sync_mode: str = "legacy",
            pitch_notes: list | None = None, onset_hint: list | None = None,
            beat_map: list | None = None, measure_sync: list | None = None,
            pitch_tolerance_cents: float = 25.0, _beat_requested: bool | None = None, _beat_rejected_in: bool = False) -> dict:
    """pitch_notes: [(start_sec, end_sec, midi)] 外部基频传感器(pYIN); onset_hint: [sec]
    外部起音传感器(QM)。两者都可选, 为空时退回自研检测, 打分逻辑不变。
    sync_mode="vamp-beat": 用 QM 拍点时间轴做活网格, 需 beat_map=[sec...]。"""
    # Beat following as the caller requested it, kept across internal
    # vamp-beat -> legacy fallbacks and the rescue re-run (degradation).
    _beat_req = (sync_mode == "vamp-beat") if _beat_requested is None else bool(_beat_requested)
    # The live beat grid existed but lost the pitch-evidence vote (typically a
    # score/take octave or tempo mismatch); kept across the rescue re-run.
    _beat_rejected = bool(_beat_rejected_in)
    validate_instrument(instrument, ["violin", "viola", "cello"])
    validate_bpm(bpm, min_bpm=30, max_bpm=200)
    if sync_mode not in ("legacy", "metronome", "vamp-beat", "manual-measures"):
        raise ValueError("无效的同步模式")
    if sync_mode == "manual-measures" and (start_measure == 0 or first_beat_audio_sec is not None):
        raise ValueError("Manual measure sync cannot use automatic location or a metronome anchor")
    if sync_mode != "manual-measures" and measure_sync is not None:
        raise ValueError("measureSync requires manual-measures mode")
    if first_beat_audio_sec is not None and (
            not isinstance(first_beat_audio_sec, (int, float)) or
            not 0 <= float(first_beat_audio_sec) <= MAX_FIRST_BEAT_SECONDS):
        raise ValueError(f"firstBeatAudioSec 须在 0–{MAX_FIRST_BEAT_SECONDS} 秒之间")
    if sync_mode == "legacy" and first_beat_audio_sec is not None:
        raise ValueError("legacy 模式不应携带 firstBeatAudioSec")
    if sync_mode == "metronome" and first_beat_audio_sec is None:
        raise ValueError("metronome 模式需要 firstBeatAudioSec")
    score_notes = parse_score(xml)
    has_chords = any(n.get("chordMidi") for n in score_notes)
    if type(start_measure) is not int or start_measure < 0 or start_measure > score_notes[-1]["measure"]:
        raise ValueError("开始小节没有可演奏音符")
    signal, rate = read_wav(wav)
    if sync_mode == "manual-measures":
        measure_sync = validate_measure_sync(measure_sync, xml, len(signal) / rate, start_measure)
    # 削波必须在原始电平上判定; 随后把峰值归一化到固定电平, 让下游的绝对能量
    # 阈值 (0.008/0.012/0.018) 与录音电平无关 (#6: -38 dBFS 录音曾报"无法检测到演奏",
    # 0.02~0.32 间节奏分随电平漂移)。read_wav 已拒绝峰值 < 0.005 的录音。
    raw_clipped = bool(np.max(np.abs(signal)) >= 0.999)
    signal = (signal * (NORMALIZED_PEAK / float(np.max(np.abs(signal))))).astype(np.float32)
    # Guard: pYIN 只返回 1 音符时 _hint_track midis[clip(j,0,-1)] 会 IndexError
    pitch_notes = pitch_notes if pitch_notes and len(pitch_notes) >= 2 else None
    # 所有路径都校验传感器事件 (#7): 原先只有自动定位走 usable_events, 指定小节时
    # 乱序/重叠事件直接进入 _hint_track 的 searchsorted。
    if pitch_notes:
        usable_events(pitch_notes)
    lead_in_sec = None
    if pitch_notes and sync_mode in ("legacy", "vamp-beat") and start_measure >= 1:
        lead_in_sec = detect_lead_in(usable_events(pitch_notes),
                                     [n for n in score_notes if n["measure"] >= start_measure])
        if lead_in_sec is not None:
            cut = max(0.0, lead_in_sec - LEAD_IN_PAD_SEC)
            signal = signal.copy()
            signal[:int(cut * rate)] = 0.0
            pitch_notes = [e for e in pitch_notes if float(e[0]) >= cut]
            onset_hint = [o for o in onset_hint if float(o) >= cut] if onset_hint else onset_hint
            beat_map = [b for b in beat_map if float(b) >= cut - 0.5] if beat_map else beat_map
            lead_in_sec = round(lead_in_sec, 2)
    sec_per_beat = seconds_per_quarter(xml, bpm)
    # 面板速度只做第一道粗筛：区间外标 mismatch；区间内（[0.8,1.25]）也可能
    # 是 2x 密网格（八分锁拍且面板≈2x 真速，慢速连奏实测），间隔比值无法区分，
    # 一律再拿音高证据验刻度（含 0.5 八分候选），含糊按 mismatch 退回 legacy。
    beat_quarters = 1.0
    grid_voted = False
    needs_vote = False
    tempo_mismatch = False
    mismatch_bpm = None
    if sync_mode == "vamp-beat" and beat_map:
        grid = sorted(set(float(b) for b in beat_map if math.isfinite(float(b)) and float(b) >= 0))
        if len(grid) >= 4:
            interval = float(np.median(np.diff(grid)))
            if interval <= 0:
                tempo_mismatch = True
                beat_map = None
            elif 0.8 <= interval / sec_per_beat <= 1.25:
                pass
            elif start_measure != 0:
                needs_vote = True
                tempo_mismatch = True
                mismatch_bpm = round(60 / interval, 1)
            else:
                # 自动定位越界：丢网退 legacy（no23 slow 类位对网错需 shootout
                # 另立项：活网/平滑网事后比优，见下一轮计划）。
                tempo_mismatch = True
                mismatch_bpm = round(60 / interval, 1)
                beat_map = None
    auto_located = start_measure == 0
    location_cost = None
    alignment = None
    boundary_conflict = False
    fused_locate = False
    bp_locate = None
    if auto_located:
        if sync_mode == "metronome" or first_beat_audio_sec is not None:
            raise ValueError("自动定位仅支持未同步的单声部录音")
        if not pitch_notes:
            pitch_events = []
        else:
            pitch_events = usable_events(pitch_notes)
        if not pitch_events:
            # 无外部传感器时退回内置跟踪分段：同一套定位逻辑，证据弱一些。
            # 内置跟踪在下方统一跑，这里为定位先跑一次（只发生在无传感器路径）。
            _bt, _bp, _be, _bc = track(signal, rate)
            _ev = usable_events(segment_builtin_events(_bt, _bp, _be)) if len(_bt) >= 8 else []
            if len(_ev) < 8:
                raise ValueError("自动定位需要 pYIN 音高传感器；请指定起始小节")
            pitch_events = _ev
        reliable_events = pitch_events
        # Full-excerpt alignment first: start + end + measure time map from
        # audio events and XML alone (panel-tempo independent). Falls back to
        # the legacy start-only location when the excerpt is ambiguous; scoring
        # math below is untouched either way.
        try:
            excerpt = align_excerpt(score_notes, reliable_events,
                                    beat_map=beat_map if sync_mode == "vamp-beat" else None)
        except ValueError:
            excerpt = None
        # 0.13: pYIN-first. Basic Pitch runs lazily, only when the pYIN
        # full-excerpt alignment is missing or unconfident; the locate layer
        # below is pYIN-first too (BP second, fused last).
        bp_events, bp_excerpt = None, None
        if excerpt is None or not excerpt.get("confident"):
            # 0.25: 含和弦的谱面用 BP 和弦分组 (同时发声的音合成一个事件)。
            bp_events = _bp_locate_events(signal, rate, chords=True) if has_chords \
                else _bp_locate_events(signal, rate)
            if bp_events:
                try:
                    bp_excerpt = align_excerpt(score_notes, bp_events,
                                               beat_map=beat_map if sync_mode == "vamp-beat" else None)
                except ValueError:
                    bp_excerpt = None
            if bp_excerpt is not None and bp_excerpt.get("confident"):
                excerpt, reliable_events, bp_locate = bp_excerpt, bp_events, "align"
        boundary_conflict = excerpt is not None and excerpt.get("boundarySupported") is False
        if excerpt is not None and excerpt.get("confident"):
            alignment = excerpt
            index, location_cost = excerpt["start"], excerpt["cost"]
            notes = score_notes[alignment["start"]: alignment["end"] + 1]
        else:
            locate_beats = beat_map if sync_mode == "vamp-beat" else None
            bp_hit = None
            try:
                index, location_cost = locate_excerpt(
                    score_notes, reliable_events, beat_map=locate_beats)
            except ValueError as first_error:
                # pYIN-first fallback: BP gets the second try at the locate
                # layer; the fused retry stays last, as in 0.11/0.12.
                if bp_events:
                    try:
                        bp_hit = locate_excerpt(score_notes, bp_events, beat_map=locate_beats)
                    except ValueError:
                        bp_hit = None
                if bp_hit is not None:
                    index, location_cost = bp_hit
                else:
                    # pYIN's note tracker merges fast passages (16ths); retry once with
                    # QM-onset segments + pYIN frame pitch under the same gates. The
                    # original error survives if the fused events cannot locate either.
                    fused = _fused_locate_events(signal, rate)
                    if not fused:
                        raise
                    try:
                        index, location_cost = locate_excerpt(score_notes, fused, beat_map=locate_beats)
                    except ValueError:
                        raise first_error from None
                    fused_locate = True
            if bp_hit is not None:
                reliable_events, bp_locate = bp_events, "locate"
            notes = score_notes[index:]
        if not notes:
            raise ValueError("录音不足以覆盖所选开始小节")
        location_anchor = reliable_events[0][0]
        start_measure = notes[0]["measure"]
    else:
        notes = [n for n in score_notes if n["measure"] >= start_measure]
    if sync_mode == "manual-measures":
        notes = [n for n in notes if n["measure"] < measure_sync[-1]["measure"]]
        if not notes:
            raise ValueError("No pitched notes inside the confirmed measure boundaries")
    times, pitches, energy, confidence = _hint_track(signal, rate, pitch_notes) if pitch_notes \
        else track(signal, rate)
    if len(times) < 8:
        raise ValueError("有效录音过短")
    active = np.flatnonzero(energy > max(0.012, np.max(energy) * 0.10))
    voiced = np.flatnonzero(np.isfinite(pitches) & (energy > max(0.012, np.max(energy) * 0.10)))
    if not len(active) or not len(voiced):
        raise ValueError("无法检测到演奏")
    onsets = detect_builtin_onsets(times, pitches, energy, onset_hint)
    sec_per_beat = seconds_per_quarter(xml, bpm)
    estimated_latency_ms: int | None = None
    detected_bpm: float | None = None
    beat_time = None
    base_beat = 0.0
    if beat_map is not None:
        beat_map = sorted(set(float(b) for b in beat_map if math.isfinite(float(b)) and float(b) >= 0))
    if sync_mode == "vamp-beat":
        # 活网格: 谱面相对拍 -> QM 实测拍点时间的分段线性映射, 越界用中位间隔外推。
        # 只用拍点时间戳(QM 的 beat number 相位不可信), 锚到首个有声起音最近的拍点。
        # 拍点网格是独立于起音事件的周期参考, 这正是节奏分可测量的前提;
        # 逐音符锚定的 warp(谱面感知对齐)会让期望与实测同源、节奏分恒满分, 故不用。
        if not beat_map or len(beat_map) < 4:
            # Vamp 不可用时静默降级到 legacy 固定速度，前端无感
            sync_mode = "legacy"
        else:
            # 网格锚在首个发声上, 所以相对拍也必须从首个谱面音符算起;
            # 用小节线会让以休止开头的起始小节整体错位。
            base_beat = notes[0]["onsetBeat"]
            beats = np.asarray(sorted(float(b) for b in beat_map))
            med = float(np.median(np.diff(beats)))
            # Beat trackers may emit a short, off-phase pickup before locking
            # onto the pulse. Do not count that pickup as a full score beat:
            # it shifts every subsequent note by a subdivision. Only discard
            # unstable startup intervals, never deviations later in the take.
            audio_anchor = location_anchor if auto_located else onsets[0]
            startup = np.flatnonzero((beats[:-1] <= audio_anchor) &
                                     (np.diff(beats) < 0.75 * med))
            repaired_start = bool(len(startup))
            if repaired_start:
                beats = beats[int(startup[-1]) + 1:]
            detected_bpm = round(60 / med, 1) if med > 0 else None
            audio_anchor = location_anchor if auto_located else onsets[0]
            anchor = int(np.argmin(np.abs(beats - audio_anchor)))
            anchor_shift = audio_anchor - beats[anchor] if auto_located or repaired_start else 0.0
            # 网格刻度投票：0.5=八分密网格（跟踪器锁在八分音符上，多见于
            # 慢速连奏）；内容（窗内音高中位数±1.5半音）说了算，含糊（None）
            # 按 mismatch 退回 legacy。票不够（覆盖音符<4，短片段投不准）且
            # 无需投票时沿用粗筛结论，不验不退。
            span = (float(beats[-1]) - float(beats[0])) / med if med > 0 else 0.0
            votable = sum(1 for n in notes if n["onsetBeat"] - notes[0]["onsetBeat"] <= span + 2.0) >= 4
            voted = needs_vote or votable
            if not voted:
                picked = 1.0
            else:
                scales = (1.0, 1.5, 0.5) if tracker_beat_quarters(xml) == 1.5 else (1.0, 0.5)
                picked = _select_grid_scale(
                    beats, med, anchor, notes, notes[0]["onsetBeat"],
                    times, pitches, confidence, scales, anchor_shift)
            if picked is None and needs_vote:
                beat_map = None
                sync_mode = "legacy"
                _beat_rejected = True
            elif picked is None:
                # 粗筛通过但内容含糊（谱面错/重复句常见）：弃权不断网格，
                # 沿用 1:1（0.20 行为）；只有本就可疑的网格才退 legacy。
                beat_quarters = 1.0
            else:
                beat_quarters = picked
                if voted:
                    grid_voted = True
            if sync_mode == "vamp-beat" and pitch_notes and beat_quarters:
                # 相位投票：最近拍点锚点在连续八分音符/前导拍点漏检时可能差
                # 半个或一个脉冲；用 pYIN 段验相位，赢家平移 anchor_shift。
                # 弃权/模糊时返回 0.0，保持原锚点（只读于打分，只动网格）。
                anchor_shift += _select_grid_phase(
                    beats, med, anchor, notes, base_beat,
                    pitch_notes, beat_quarters, anchor_shift) * med
            if tracker_beat_quarters(xml) == 1.5 and not needs_vote and not grid_voted \
                    and detected_bpm is not None:
                # 直接锁住的复拍子网格：面板按惯例是附点口径，detectedBpm
                # 折成附点数才跟面板可比。投票锁住的不折（口径未知，报实测）。
                detected_bpm = round(detected_bpm / 1.5, 1)

            if sync_mode == "vamp-beat":
                def beat_time(rel_beat: float) -> float:  # noqa: F811
                    # 相对拍是四分音符口径，拍点下标是跟踪器脉冲口径：下标按
                    # 选中的单位折算（1=四分脉冲 1:1，1.5=附点脉冲 /1.5）。
                    return _interp_beats(beats, med, anchor, rel_beat / beat_quarters) + anchor_shift
            else:
                beat_time = None

    # A rejected QM pulse must not leave an auto-located excerpt on a known
    # wrong tempo unit. Calibrate one global ruler, never per-note expected times.
    auto_tempo_refit = bool(auto_located and alignment is not None and
                           sync_mode == "legacy" and tempo_mismatch and
                           not TEMPO_BAND[0] <= alignment["quarterPeriod"] / sec_per_beat <= TEMPO_BAND[1])
    if auto_tempo_refit:
        sec_per_beat = alignment["quarterPeriod"]
        detected_bpm = round(60.0 / sec_per_beat / tracker_beat_quarters(xml), 1)

    manual_boundaries = measure_start_beats(xml) if sync_mode == "manual-measures" else {}
    if sync_mode == "manual-measures":
        boundaries = measure_start_beats(xml, include_end=True)
        anchor_beats = [boundaries[m["measure"]] for m in measure_sync]
        anchor_times = [m["audioSec"] for m in measure_sync]
        base_beat = 0.0
        def beat_time(rel_beat):
            return float(np.interp(rel_beat, anchor_beats, anchor_times))

    if sync_mode == "metronome":
        # The client records the metronome downbeat of start_measure.
        # Trust it as the base timeline, then apply only a small bounded
        # correction from the first voiced frame so a bad onset cannot
        # drag the whole excerpt to the wrong place.
        base_beat = measure_start_beats(xml)[start_measure]
        start = float(first_beat_audio_sec) - base_beat * sec_per_beat
        raw_latency = onsets[0] - (start + notes[0]["onsetBeat"] * sec_per_beat)
        clamped = max(-0.15, min(0.15, raw_latency))
        start += clamped
        estimated_latency_ms = round(clamped * 1000)
    else:
        # Align the first pitched onset with the first written note, even if the
        # MusicXML starts with an all-rest measure. Silence before it is not scored.
        start = (location_anchor if auto_located else onsets[0]) - notes[0]["onsetBeat"] * sec_per_beat
        if auto_tempo_refit:
            start = alignment["t0"]
    # 0.24: the pitch alignment (often Basic Pitch) already knows where each
    # measure starts. When the beat grid disagrees with it (wrong tempo unit,
    # slow drift), score on the alignment's measure map instead — same standing
    # as confirmed markers: per measure, never per note, so rhythm stays measurable.
    align_grid = _alignment_grid(alignment, notes, base_beat, sec_per_beat, start, beat_time) \
        if sync_mode in ("vamp-beat", "legacy") and alignment is not None else None
    if align_grid is not None:
        beat_time = align_grid
    # Score excerpts can start at any measure. Never count score notes beyond
    # the recording as missed notes, including when the full score is hours long.
    last_voiced = times[voiced[-1]]
    rescue_notes = score_notes if auto_located else [n for n in score_notes if n["measure"] >= start_measure]
    if sync_mode != "manual-measures" and alignment is None:
        notes = [n for n in notes if (beat_time(n["onsetBeat"] - base_beat) if beat_time is not None
                                    else start + n["onsetBeat"] * sec_per_beat) <= last_voiced + 0.06]
    if not notes:
        raise ValueError("录音不足以覆盖所选开始小节")
    aligned = []
    pitch_errors, timing_errors = [], []
    timing_at: list[float] = []
    measured_count = 0
    timing_candidates = 0
    # legacy/metronome 是固定网格: 整体偏慢/偏快时误差逐音累积, 几小节后搜索窗
    # 落到邻音上, 把速度问题误报成错音。只让"去哪儿找"跟随已测起音的线性趋势;
    # 计时误差仍对固定网格计算, 拖慢照实报 late, 期望与实测不同源。
    drift_obs: list[tuple[float, float]] = []
    last_onset = -1.0
    prev_duration: float | None = None
    # CREPE 二诊 v2 (lazy + crop): 整轨 full 模型 CPU 推理约 4s/s 音频, 不能
    # 每个请求跑。本轮先登记缺测窗 (gap) 与荒谬值窗 (suspect), 循环后只对
    # 合并窗跑 crop; 无窗时 CREPE 零调用、零开销。全量审计是离线任务,
    # 不在请求路径做。
    crepe_items: list = []

    def predicted_drift(at: float) -> float:
        if beat_time is not None or not drift_obs:
            return 0.0
        xs = np.array([x for x, _ in drift_obs[-8:]])
        ds = np.array([d for _, d in drift_obs[-8:]])
        if len(xs) < 3 or float(np.ptp(xs)) <= 0:
            return float(np.median(ds))
        slope = max(-0.12, min(0.12, float(np.polyfit(xs, ds, 1)[0])))
        return float(np.mean(ds) + slope * (at - np.mean(xs)))

    for note_index, note in enumerate(notes):
        if beat_time is not None:
            expected = beat_time(note["onsetBeat"] - base_beat)
        else:
            expected = start + note["onsetBeat"] * sec_per_beat
        duration = (beat_time(note["onsetBeat"] - base_beat + note["durationBeat"]) - expected
                    if beat_time is not None else note["durationBeat"] * sec_per_beat)
        # 换把滑音需要更长的稳定时间: 与前音差 3 半音以上时, 音高窗跳过前 35%。
        shifted = note_index > 0 and abs(note["pitchMidi"] - notes[note_index - 1]["pitchMidi"]) >= 3
        # 时间误差与稳态音高分开估计，避开擦弦、滑音和收尾。
        center = expected + predicted_drift(expected)
        reach = min(0.22, duration * 0.35)
        # 固定网格模式下起音单调且一一匹配: 前一音符已占用的起音不可复用,
        # 否则回退窗会把前一音的起音当成本音 (拖慢时尤甚)。
        measure_lo = beat_time(manual_boundaries[note["measure"]]) if manual_boundaries else -math.inf
        measure_hi = beat_time(boundaries[note["measure"] + 1]) if manual_boundaries else math.inf
        free = [t for t in onsets if measure_lo <= t < measure_hi and
                ((beat_time is not None and not manual_boundaries) or t > last_onset + 0.05)]
        # 先在趋势预测处找; 落空再回固定网格窗 (随机抖动时预测会偏)。
        # 两处都落空时音高窗仍跟随趋势: 漏检起音(如半音连奏)不把音高窗拉回旧网格。
        ref = center
        candidates = [t for t in free if abs(t - center) <= reach]
        if not candidates and center != expected:
            fallback = [t for t in free if abs(t - expected) <= reach]
            if fallback:
                ref = expected
                candidates = fallback
        onset = min(candidates, key=lambda t: abs(t - ref)) if candidates else None
        wide_hit = False
        if onset is None:
            # 幸存者偏差 (#5): 偏差超出常规窗的音若被丢弃, 节奏越乱可判起音越少,
            # 剩下的反而越"准"。常规窗落空时用宽窗再找一次: 每侧不超过相邻音符
            # 时长的 45% (不越过中点, 抓不到邻音的起音), 上限 0.4 s; 起音单调
            # 一一匹配。命中后音高窗锚到实测起音, 避免窗口落在前一音的尾部。
            late_reach = min(0.40, duration * 0.45)
            early_reach = min(0.40, (prev_duration or duration) * 0.45)
            wide = [t for t in onsets if measure_lo <= t < measure_hi and t > last_onset + 0.05 and expected - early_reach <= t <= expected + late_reach]
            if wide:
                onset = min(wide, key=lambda t: abs(t - expected))
                ref = onset
                wide_hit = True
        prev_duration = duration
        if onset is not None:
            last_onset = onset
            # 宽窗命中是离群点, 喂给趋势会让线性外推冲过头、抓到下一音的起音。
        skip = duration * 0.35 if shifted else min(0.12, duration * 0.28)
        # 音高窗不越过下一个实测起音: 本音拖、下音抢时两音被挤压, 固定 78% 时长
        # 会采到下一音 (#5)。只在本音起音已测到时截断; 起音漏检时下一个
        # 起音可能就是本音自己的, 截断会把窗口清空。
        hi_edge = ref + duration * 0.78
        if onset is not None:
            nxt = min((t for t in onsets if t > onset + 0.05), default=None)
            if nxt is not None:
                hi_edge = min(hi_edge, nxt - 0.03)
        crepe_lo, crepe_hi = None, None
        fallback_win = False
        mask = (times >= ref + skip) & (times <= hi_edge)
        valid = mask & np.isfinite(pitches) & (confidence >= 0.7)
        if beat_time is not None and pitch_notes:
            # 活网格模式: 音高窗口锚在 pYIN 音符段自身时间轴上(音频真值, 与速度无关)。
            # 快速经过句中段首 proximity 会抓到邻音, 改为与期望音符区间的重叠优先,
            # 平局才看段首距离; 无重叠则判 uncertain, 不强行用邻音定音高。
            # 不做音高门控(无偏好，跑调照实报)
            seg = None
            best_score = None
            note_end = expected + duration
            for (sa, sb_, _sm) in pitch_notes:
                overlap = min(sb_, note_end) - max(sa, expected)
                if overlap <= 0:
                    continue
                score = (overlap, -abs(sa - expected))
                if best_score is None or score > best_score:
                    best_score = score
                    seg = (sa, sb_)
            cents = None
            quality = 0.0
            detected = None
            if seg is not None and seg[1] - seg[0] >= 0.15:
                lo = seg[0] + (seg[1] - seg[0]) * 0.28
                hi = seg[1] - (seg[1] - seg[0]) * 0.22
                lo = max(lo, expected)
                if shifted:
                    lo = max(lo, expected + duration * 0.35)
                hi = min(hi, note_end)
                crepe_lo, crepe_hi = lo, hi
                svalid = (times >= lo) & (times <= hi) & np.isfinite(pitches) & (confidence >= 0.7)
                if np.count_nonzero(svalid) >= 4:
                    detected = float(np.median(pitches[svalid]))
                    cents = round((detected - note["pitchMidi"]) * 100, 1)
                    quality = round(float(np.median(confidence[svalid])), 2)
            if detected is None:
                # 活网格下 pYIN 段过短/缺失（快速经过句常见）：退到帧中位数，
                # 窗口同兜底窗（期望区间内、有效帧≥4），仍无才留给 CREPE。
                # 只补 None，不碰已有 verdict（no05 fast 实测：66 短段全军）。
                fb_lo0, fb_hi0 = max(ref + skip, expected), min(hi_edge, note_end)
                if fb_hi0 - fb_lo0 >= 0.04:
                    fvalid = ((times >= fb_lo0) & (times <= fb_hi0) & np.isfinite(pitches)
                              & (confidence >= 0.7))
                    if np.count_nonzero(fvalid) >= 4:
                        detected = float(np.median(pitches[fvalid]))
                        cents = round((detected - note["pitchMidi"]) * 100, 1)
                        quality = round(float(np.median(confidence[fvalid])), 2)
            if crepe_lo is None:
                # 0.20: 无可用 pYIN 段 (无重叠或 <0.15s): pYIN 照旧不定音高, 只给 CREPE 登记
                # 期望区间内的兜底窗; CREPE 读数 >200c 不指控 (见 _run_crepe_verdicts)。
                fb_lo, fb_hi = max(ref + skip, expected), min(hi_edge, note_end)
                if fb_hi - fb_lo >= 0.04:
                    crepe_lo, crepe_hi, fallback_win = fb_lo, fb_hi, True
        else:
            crepe_lo, crepe_hi = ref + skip, hi_edge
            detected = float(np.median(pitches[valid])) if np.count_nonzero(valid) >= 4 else None
            cents = round((detected - note["pitchMidi"]) * 100, 1) if detected is not None else None
            quality = round(float(np.median(confidence[valid])), 2) if cents is not None else 0.0
        # 0.27 起音锚定补测: 快速大跳 (如大提琴跨弦低音八分音符) 的常规窗锚在期望时刻、
        # 跳过前 35%、又在下一起音前 30 ms 截断, 常只剩 0-30 ms (<4 帧), 帧明明测到
        # (置信 0.8-0.99) 却判没听清。起音已测到时改在 [本起音, 下一起音] 内重测:
        # 读数像邻音 (更近前/后一音的谱面音高) 不收; 差三度以上不指控, 只交 CREPE。
        rescued = False
        if cents is None and onset is not None:
            span_end = min(onset + duration, nxt) if nxt is not None else onset + duration
            span = span_end - onset
            r_lo = onset + span * (0.30 if shifted else 0.20)
            r_hi = span_end - span * 0.12
            if r_hi - r_lo >= 0.04:
                rvalid = (times >= r_lo) & (times <= r_hi) & np.isfinite(pitches) & (confidence >= 0.7)
                if np.count_nonzero(rvalid) >= 3:
                    r_det = float(np.median(pitches[rvalid]))
                    r_cents = (r_det - note["pitchMidi"]) * 100
                    own = abs(r_det - note["pitchMidi"])
                    near = [abs(r_det - notes[k]["pitchMidi"]) for k in (note_index - 1, note_index + 1)
                            if 0 <= k < len(notes)]
                    neighbour = abs(r_cents) > pitch_tolerance_cents and any(d < own for d in near)
                    if abs(r_cents) <= 200 and not neighbour:
                        detected, cents = r_det, round(r_cents, 1)
                        quality = round(float(np.median(confidence[rvalid])), 2)
                        rescued = True
                    else:
                        # 前一音仍在共鸣 (单音高跟踪器跟住了它): 频谱里目标音的分音串确实在、
                        # 且不比另一串弱太多才算听到; 读数取目标分音, 宽于 50c 不评 (短窗分辨率不够)。
                        v = verify_target(signal, rate, onset + span * 0.10, span_end, note["pitchMidi"], r_det)
                        if v and v["check"] in ("confirmed", "two-series") and v["recovered"] is not None \
                                and abs(v["recovered"][1]) <= 50:
                            detected, cents = v["recovered"][0], v["recovered"][1]
                            quality = 0.7
                            rescued = True
                if cents is None and not (crepe_lo is not None and crepe_hi is not None
                                          and crepe_hi - crepe_lo >= r_hi - r_lo):
                    crepe_lo, crepe_hi, fallback_win = r_lo, r_hi, True
        # 节奏优先归因: 本窗超差但邻音 (±4 音/±6 拍) 匹配时, 音准按邻音判对,
        # 错位由计时误差在节奏侧扣分 (小节错位是节奏错, 不是音准错)。
        cents, detected, quality, crepe_cents = _apply_crepe_opinion(
            cents, detected, quality, note["pitchMidi"], (crepe_lo, crepe_hi), None)
        chord_tones = note.get("chordMidi")
        if chord_tones and detected is not None:
            # 0.25 双音/和弦: 单音高跟踪器只跟住一个声部, 按最近的和弦音计音准;
            # 半音内没有和弦音就不判 (多声部下读数不可信, 不指控错音)。
            nearest = min(chord_tones, key=lambda p: abs(detected - p))
            cents = round((detected - nearest) * 100, 1) if abs(detected - nearest) <= 1.0 else None
            if cents is None:
                quality = 0.0
        # lazy gap 登记: 主循环结束后再对缺测窗跑 crop 推理。veto (窗内多半是
        # 邻音) 之后才变 None 的音不登记, 避免把邻音音高算到本音头上。
        if cents is None and crepe_lo is not None and crepe_hi is not None and crepe_hi > crepe_lo:
            crepe_items.append({"index": len(aligned), "lo": float(crepe_lo),
                                "hi": float(crepe_hi), "pitchMidi": note["pitchMidi"],
                                "kind": "gap", "fallback": fallback_win,
                                "noOnsetShort": onset is None and duration < 0.25})
        raw_cents, displaced, displaced_from = None, False, None
        if cents is not None and detected is not None and abs(cents) > pitch_tolerance_cents:
            # 起音落在本音自己的位置 (偏差 <= max(80 ms, 25% 时值)) 时音高窗测的就是本音:
            # 恰好等于邻音音高是拉错音, 不是错位。只有起音漏检或明显偏移才按邻音归因。
            on_time = onset is not None and abs(onset - expected) <= max(0.08, duration * 0.25)
            hit = None if on_time else _displaced_match(note_index, notes, detected, pitch_tolerance_cents)
            if hit is not None:
                raw_cents, displaced_from = cents, hit[1]
                cents = hit[0]
                displaced = True
        delta = round((onset - expected) * 1000) if onset is not None else None
        if cents is not None:
            measured_count += 1
        # 无起音的短音差三度以上: 窗内多半是邻音, 无分段不指控。
        # (覆盖率仍计入 measured: 测到了帧, 只是不敢判。)
        if onset is None and duration < 0.25 and cents is not None and abs(cents) > 200:
            cents = None
            quality = 0.0
            # 0.20b: pYIN 窗内读到邻音被否决后仍登记 CREPE 补测 (同 >200c 规则; 已计覆盖, 不重复计)
            if crepe_lo is not None and crepe_hi is not None and crepe_hi > crepe_lo:
                crepe_items.append({"index": len(aligned), "lo": float(crepe_lo), "hi": float(crepe_hi),
                                    "pitchMidi": note["pitchMidi"], "kind": "gap", "fallback": fallback_win,
                                    "noOnsetShort": True, "counted": True})
        # absurd suspect 登记 (post-veto): veto 之后仍有值且荒谬才登记,
        # veto 掉的不进, 避免把邻音窗算进来。
        if cents is not None and abs(cents) > CREPE_OVERRIDE_ABSURD_CENTS \
                and crepe_lo is not None and crepe_hi is not None and crepe_hi > crepe_lo:
            crepe_items.append({"index": len(aligned), "lo": float(crepe_lo),
                                "hi": float(crepe_hi), "pitchMidi": note["pitchMidi"],
                                "kind": "suspect"})
        pitch_status = classify_pitch(cents, detected, pitch_tolerance_cents)
        # 只挡有滑格证据的起音 (判错音/邻音归因) 进速度趋势; uncertain 照常喂, 抢快时趋势才追得上。
        # 补测读数只用于音准, 不改速度趋势的取舍 (按补测前的 uncertain 喂)。
        if onset is not None and beat_time is None and not wide_hit and not displaced and (rescued or pitch_status not in ("sharp", "flat")):
            drift_obs.append((expected, onset - expected))
        timing_eligible = (bool(manual_boundaries) or note_index > 0) and not (manual_boundaries and abs(note["onsetBeat"] - manual_boundaries[note["measure"]]) < 1e-6)
        timing_candidates += int(timing_eligible)
        if delta is not None and timing_eligible:
            timing_errors.append(delta)
            timing_at.append(expected)
        timing_status = "unscored" if not timing_eligible else "uncertain" if delta is None else "late" if delta > 80 else "early" if delta < -80 else "correct"
        status = "outlier" if pitch_status == "outlier" else "uncertain" if pitch_status == "uncertain" else "octave_uncertain" if pitch_status == "octave" else "wrong_pitch" if pitch_status in ("sharp", "flat") else \
            "timing_uncertain" if timing_eligible and delta is None else timing_status if timing_status in ("late", "early") else "correct"
        aligned.append({**note, "expectedSec": round(expected, 3), "performedSec": round(onset, 3) if onset is not None else None,
                        "expectedEndSec": round(expected + duration, 3),
                        "pitchErrorCents": cents, "crepeCents": crepe_cents, "crepeOverride": False, "timingErrorMs": delta if timing_eligible else None,
                        "confidence": quality, "pitchStatus": pitch_status, "timingStatus": timing_status,
                        "rawPitchErrorCents": raw_cents, "pitchDisplaced": displaced,
                        "displacedFromMeasure": displaced_from,
                        "_verifyWin": (crepe_lo, crepe_hi),
                        "matchStatus": "matched" if cents is not None else "uncertain", "status": status})
    # CREPE verdicts (lazy + crop): 缺测补齐 + 荒谬值接管, 详见 _run_crepe_verdicts。
    # 无窗时零调用、零开销; 看似合理的 pYIN 读数永远不动。
    # CREPE 也是单声部跟踪器, 和弦音不登记。
    crepe_items = [it for it in crepe_items if not aligned[it["index"]].get("chordMidi")]
    measured_count += _run_crepe_verdicts(
        aligned, crepe_items, signal, rate, pitch_tolerance_cents)
    if has_chords:
        _was = sum(n.get("pitchErrorCents") is not None for n in aligned if n.get("chordMidi"))
        _score_chord_tones(aligned, signal, rate, _bp_note_activation(signal, rate), pitch_tolerance_cents)
        measured_count += sum(n.get("pitchErrorCents") is not None for n in aligned if n.get("chordMidi")) - _was
    # 动态剔除极端音 (门控见 _drop_player_outliers); 音准分按剔除后重建,
    # dropped/octave/outlier 一律不计入。
    # 对齐全部定型后才核对目标音: 只改评分, 不回灌速度趋势/CREPE 登记 (见 _verify_targets)。
    _verify_targets(aligned, signal, rate, pitch_tolerance_cents)
    import os as _os
    if _os.environ.get("SF_NO_BP_OPINION") != "1":
        _bp_second_opinion(aligned, signal, rate, pitch_tolerance_cents)
    trim_active = _drop_player_outliers(aligned, pitch_tolerance_cents)
    pitch_errors = [abs(float(n["pitchErrorCents"])) for n in aligned
                    if n.get("pitchStatus") in ("sharp", "flat", "correct")]
    # 逐音权重 (归因 + 偏差 + 稳定度); >600¢ 仍为 0。覆盖率/补救门槛/匹配率仍用全部可判音。
    _assign_pitch_weights(aligned)
    weighted = _pitch_items(aligned)  # 和弦音逐音计
    # 不将不可判断的音符作为正确或错误；节奏得分只在至少三个起音可匹配时给出。
    pitch_score = None
    pitch_gate_score = None
    intonation_score = None
    correct_pitch_notes = sum(n["pitchStatus"] == "correct" for n in aligned)
    wrong_pitch_notes = sum(n["pitchStatus"] in ("sharp", "flat") for n in aligned)
    octave_uncertain_notes = sum(n["pitchStatus"] == "octave" for n in aligned)
    voiced_count = measured_count
    if pitch_errors and len(pitch_errors) / len(notes) >= .6:
        # Capped mean keeps one noisy frame bounded, but unlike a median it cannot
        # hide a substantial minority of clearly wrong notes.
        # Within the accepted tolerance band there is no pitch penalty.
        penalties = np.maximum(np.asarray(pitch_errors) - pitch_tolerance_cents, 0)
        # 补救门槛沿用 0.18 口径 (含剔除音), 与 rhythm_gate_score 同理, 控制流不变。
        pitch_gate_score = round(max(0, 100 - float(np.mean(np.minimum(penalties, 100))) * 1.2))
        if weighted:
            kept = np.maximum(np.array([e for e, _ in weighted]) - pitch_tolerance_cents, 0)
            wts = np.array([w for _, w in weighted])
            pitch_score = round(max(0, 100 - float(np.sum(np.minimum(kept, 100) * wts) / np.sum(wts)) * 1.2))
        in_tune = [abs(float(n["pitchErrorCents"])) for n in aligned if n["pitchStatus"] == "correct"]
        intonation_score = 100 if in_tune else None
    rhythm_score = None
    rhythm_gate_score = None
    timing_accuracy_score = None
    rhythm_stability_score = None
    rhythm_spread = None
    timing_offset = None
    if len(timing_errors) >= 3 and len(timing_errors) / max(1, timing_candidates) >= .6:
        timing_offset = round(float(np.median(timing_errors)))
        # 稳定性只看去掉整体速度趋势后的残差: 稳定地慢/快由 timingAccuracyScore 扣分,
        # 不算"不稳" (产品决定 2026-10-01)。至少 6 个起音才拟合趋势, 点太少时
        # 线性拟合会吞掉随机抖动; 不足 6 个保持原算法。
        residual = np.array(timing_errors, dtype=float) - timing_offset
        if len(timing_errors) >= 6 and float(np.ptp(timing_at)) > 0:
            fit = np.polyval(np.polyfit(timing_at, timing_errors, 1), timing_at)
            residual = np.array(timing_errors, dtype=float) - fit
            residual -= np.median(residual)
        rhythm_spread = round(float(np.median(np.abs(residual))))
        rhythm_stability_score = _rhythm_scores(rhythm_spread, timing_offset)[0]
        # 截断均值而非中位数 (#9): 中位数会掩盖少数严重偏差 (1/4 音 +400 ms 仍得 90)。
        # 单音误差截断在 250 ms, 一个离群点有上限, 与 pitchScore 的截断均值同一思路。
        timing_accuracy_score = round(max(0, 100 - float(np.mean(np.minimum(np.abs(timing_errors), 250))) * .4))
        rhythm_score = _rhythm_scores(rhythm_spread, timing_offset)[1]
        rhythm_gate_score = _legacy_rhythm_gate(rhythm_spread, timing_offset)
    duration_sec = round(float(len(signal) / rate), 3)
    boundaries = measure_start_beats(xml, include_end=True)
    def audio_time(beat):
        return beat_time(beat - base_beat) if beat_time is not None else start + beat * sec_per_beat
    # Automatic measure sync: when full-excerpt alignment is confident, derive
    # per-measure times from its fitted line (audio events + XML only). This is
    # the same standing as user-confirmed markers (piecewise measure anchors),
    # never per-note warp: intra-measure timing stays measurable. Otherwise the
    # live grid (vamp-beat) or the fixed grid (legacy/metronome) rules as before.
    alignment_intervals = None
    if alignment is not None and alignment.get("t0") is not None:
        _slope, _t0 = alignment["quarterPeriod"], alignment["t0"]
        _anchors = alignment.get("anchors") or []
        def _align_t(beat):
            return anchor_time(_anchors, beat, _slope) if _anchors else _t0 + _slope * beat
        alignment_intervals = []
        for measure in range(notes[0]["measure"], notes[-1]["measure"] + 1):
            lo = max(0.0, round(_align_t(boundaries[measure]), 3))
            hi = min(duration_sec, round(_align_t(boundaries[measure + 1]), 3))
            if hi > lo:
                alignment_intervals.append({"measure": measure, "startSec": lo, "endSec": hi})
        if not alignment_intervals:
            alignment_intervals = None
    measure_intervals = alignment_intervals if alignment_intervals is not None else []
    if not measure_intervals:
        for measure in range(notes[0]["measure"], notes[-1]["measure"] + 1):
            lo = max(0.0, audio_time(boundaries[measure]))
            hi = min(duration_sec, audio_time(boundaries[measure + 1]))
            if hi > lo:
                measure_intervals.append({"measure": measure, "startSec": round(lo, 3), "endSec": round(hi, 3)})
    clipped = raw_clipped  # 归一化前测得, 见 read_wav 调用处
    sensors = (["fused-pitch"] if pitch_notes else []) + (["qm-onset"] if onset_hint else []) or ["builtin"]
    if fused_locate:
        sensors.append("fused-locate")
    if bp_locate:
        sensors.append("bp-locate")
    if align_grid is not None:
        sensors.append("align-grid")
    # Optional-plugin degradation is explicit in the payload (not logs only),
    # derived from effective detector availability after engine guards
    # (single-note pitch guard, beat_map length/tempo filtering). Beat counts
    # as available only when the live vamp-beat grid is actually in use.
    # Scoring math, thresholds and existing keys are untouched.
    from .vamp_features import degradation_reasons as _degradation_reasons
    _effective_beat = beat_map if sync_mode == "vamp-beat" else None
    degraded_reasons = _degradation_reasons(pitch_notes, onset_hint, _effective_beat,
                                            beat_requested=_beat_req,
                                            beat_rejected=_beat_rejected)
    degraded = bool(degraded_reasons)
    if sync_mode == "manual-measures":
        measure_intervals = [{"measure": a["measure"], "startSec": a["audioSec"], "endSec": b["audioSec"]}
                             for a, b in zip(measure_sync, measure_sync[1:])]
    # 小节分 (动态窗口, 只读) + 音频-小节自动标注 (全局 offset + 因果锁定, 只动边界)。
    # manual 模式边界来自用户手点, 不平移, 只给 syncMeasure=measure。
    measure_scores = _measure_scores(aligned, pitch_tolerance_cents)
    if sync_mode == "manual-measures":
        sync_suggestion, suggested_sync = None, []
        for n in aligned:
            n["syncMeasure"] = n["measure"]
            n["syncCandidates"] = None
    else:
        sync_suggestion, measure_intervals, suggested_sync = _suggest_measure_sync(
            aligned, measure_intervals, duration_sec)
    # Additive rhythmic-structure annotation (beats/downbeats/phrases) on the
    # active timeline. Read-only w.r.t. scoring: math, thresholds and existing
    # keys are untouched; None/empty beat input falls back to the legacy grid.
    rhythm = _annotate_rhythm(measure_intervals, beat_map=_effective_beat,
                              sec_per_beat=sec_per_beat)
    result = {"version": VERSION, "instrument": instrument, "bpm": bpm, "mode": "fixed-tempo-monophonic",
            "measureIntervals": measure_intervals,
            "measureSync": measure_sync,
            "measureScores": measure_scores,
            "syncSuggestion": sync_suggestion,
            "suggestedMeasureSync": suggested_sync,
            "rhythm": rhythm,
            "summary": {"pitchScore": pitch_score, "intonationScore": intonation_score,
                        "pitchToleranceCents": pitch_tolerance_cents,
                        "timingCandidateNotes": timing_candidates,
                        "timingReference": "within-manually-synced-measures" if manual_boundaries else "automatic",
                        "outlierNotes": sum(n["pitchStatus"] == "outlier" for n in aligned), "excludedPitchNotes": sum(bool(n.get("pitchExcluded")) for n in aligned),
                        "droppedOutlierNotes": sum(n.get("pitchStatus") == "dropped" for n in aligned),
                        "outlierTrimActive": trim_active,
                        "displacedPitchNotes": sum(bool(n.get("pitchDisplaced")) for n in aligned),
                        "scoredPitchNotes": len(pitch_errors),
                        "correctPitchNotes": correct_pitch_notes, "wrongPitchNotes": wrong_pitch_notes,
                        "octaveUncertainNotes": octave_uncertain_notes,
                        **({"chordTones": {state: sum(t["state"] == state for n in aligned for t in n.get("chordTones") or [])
                                           for state in ("measured", "missing", "unchecked", "inseparable", "unmeasured")}}
                           if has_chords else {}),
                        "rhythmScore": rhythm_score, "timingAccuracyScore": timing_accuracy_score,
                        "rhythmStabilityScore": rhythm_stability_score,
                        "timingOffsetMs": timing_offset, "timingSpreadMs": rhythm_spread,
                        "measureCount": len(ET.fromstring(xml).find("./{*}part").findall("./{*}measure")),
                        "startMeasure": notes[0]["measure"], "endMeasure": notes[-1]["measure"],
                        "autoLocated": auto_located, "locationCost": location_cost,
                        "noteCount": len(notes), "voicedNotes": voiced_count, "timedNotes": len(timing_errors),
                        "confidence": "medium" if voiced_count / len(notes) >= .8 else "low",
                        "syncMode": sync_mode,
                        "recordedFirstBeatSec": round(float(first_beat_audio_sec), 3) if first_beat_audio_sec is not None else None,
                        "estimatedLatencyMs": estimated_latency_ms,
                        "coveredSec": duration_sec, "sensors": sensors,
                        "degraded": degraded, "degradedReasons": degraded_reasons,
                        "clipped": clipped, "detectedBpm": detected_bpm if detected_bpm is not None else mismatch_bpm,
                        "tempoMismatch": tempo_mismatch,
                        "autoMeasureSync": False, "octaveShift": None,
                        "rescueReasons": ["tempo"] if auto_tempo_refit else [],
                        "syncAdvice": None, "leadInSec": lead_in_sec},
            "notes": aligned, "limitations": ["仅支持单声部无明显伴奏；长滑音、揉弦、重复音起音可能无法可靠判定。",
                                           "手动小节边界用于对齐；仅评估小节内节奏，手动标记的首拍不评分。"
                                           if sync_mode == "manual-measures" else
                                           "音高按十二平均律；首音作为时间零点，不计入节奏得分。"
                                           if sync_mode == "legacy" else
                                           "音高按十二平均律；节拍器第一拍锚定时间轴，后端仅做 ±150 ms 微调。"]}
    if lead_in_sec is not None:
        result["limitations"].append(f"录音开头 {lead_in_sec} 秒与谱面开头不吻合（疑似调音），已跳过，不计分。")
    if auto_tempo_refit:
        result["limitations"].append(
            f"拍点网格与谱面速度口径不一致，已按片段证据校准整体速度为 {detected_bpm} BPM；逐音节奏偏差仍按固定速度参考评分。")
    # 刚性网格补救：解释失败（疑似输入错误：八度 / 速度 / 停顿 / 多余内容）时，
    # 用音高证据重对齐并按小节锚点重算一次。只进不出：补救失败保留刚性结果并
    # 给出 syncAdvice；好片段因 _needs_rescue_check 根本不进这里，零行为变化。
    if boundary_conflict:
        result["summary"]["syncAdvice"] = "谱面与录音首尾的时间证据冲突，覆盖范围未核实；请检查谱面是否完整，并使用手动小节同步后重分析。"
    # An already supported excerpt may begin mid-measure (a cropped take).
    # Preserve that note-level range instead of replacing it with whole measures.
    # 0.28: 网格一路漂移 (QM 拍点在快速段丢拍: E31 节拍器同步到曲末早 5 s) 时测音窗
    # 落到邻音上, 音准掉到 50 多, 不到 _needs_rescue_check 的 < 40, 活网格也从不补救。
    # 匹配率低就也试一次补救, 但只有补救后匹配率明显更高才采用: 真拉错的录音换了
    # 网格也不会变好, 照原结果打分。
    _gate = sync_mode == "legacy" and alignment is None and \
        _needs_rescue_check(pitch_gate_score, rhythm_gate_score,
                            "medium" if voiced_count / len(notes) >= .8 else "low")
    _match_now = correct_pitch_notes / len(pitch_errors) if len(pitch_errors) >= 12 else None
    _drift = not _gate and sync_mode in ("legacy", "vamp-beat") and alignment is None and \
        _match_now is not None and _match_now < DRIFT_RESCUE_MATCH
    if _gate or _drift:
        _plan = _auto_measure_sync(xml=xml, notes=rescue_notes, times=times, pitches=pitches,
                                   energy=energy, sec_per_beat=sec_per_beat,
                                   duration_sec=duration_sec,
                                   requested_start=start_measure,
                                   score_last=score_notes[-1]["measure"],
                                   rigid_start=start, onsets=onsets, pitch_notes=pitch_notes,
                                   signal=signal, rate=rate,
                                   suspect="drift" if _drift else None)
        if _drift and not _plan["markers"]:
            _local = _local_grid_refine(result["notes"], measure_start_beats(xml, include_end=True),
                                        times, pitches, duration_sec)
            if _local:
                _plan.update(markers=_local, reasons=["drift"], start_measure=_local[0]["measure"])
                _plan["attempts"] = _plan["attempts"] + [{"reason": "local_refine", "events": "grid"}]
        if _plan["markers"] and _drift:
            _rescued = analyze(wav, transpose_score_xml(xml, _plan["shift"]) if _plan["shift"] else xml,
                               bpm, instrument, _plan["start_measure"],
                               sync_mode="manual-measures", measure_sync=_plan["markers"], _beat_requested=_beat_req,
                               # 拍点网格跑了但输给音高证据 = beat:rejected, 不是检测器缺失。
                               _beat_rejected_in=_beat_rejected or sync_mode == "vamp-beat",
                               pitch_notes=pitch_notes, onset_hint=onset_hint,
                               pitch_tolerance_cents=pitch_tolerance_cents)
            _rs = _rescued["summary"]
            _match_new = (_rs.get("correctPitchNotes") or 0) / _rs["scoredPitchNotes"] \
                if (_rs.get("scoredPitchNotes") or 0) >= 12 else None
            if _match_new is None or _match_new < _match_now + DRIFT_RESCUE_GAIN:
                result["summary"]["rescueAttempts"] = _plan["attempts"] + [
                    {"reason": "drift_not_better", "matchBefore": round(_match_now, 3),
                     "matchAfter": None if _match_new is None else round(_match_new, 3)}]
                return result
            _plan["_rescued"] = _rescued
        if _plan["markers"]:
            _xml2 = transpose_score_xml(xml, _plan["shift"]) if _plan["shift"] else xml
            _rescued = _plan.get("_rescued") or analyze(
                wav, _xml2, bpm, instrument, _plan["start_measure"],
                sync_mode="manual-measures", measure_sync=_plan["markers"], _beat_requested=_beat_req, _beat_rejected_in=_beat_rejected,
                pitch_notes=pitch_notes, onset_hint=onset_hint,
                pitch_tolerance_cents=pitch_tolerance_cents)
            _summary = _rescued["summary"]
            _summary["autoLocated"] = auto_located
            _summary["locationCost"] = location_cost
            _summary["autoMeasureSync"] = True
            _summary["octaveShift"] = _plan["shift"] or None
            _summary["rescueReasons"] = _plan["reasons"]
            _summary["rescueAttempts"] = _plan["attempts"]
            _summary["detectedBpm"] = _plan["detected_bpm"]
            _summary["takeBeyondScoreAfterSec"] = _plan.get("take_beyond_score_after")
            _summary["leadInSec"] = lead_in_sec
            if "tempo" in _plan["reasons"]:
                _summary["tempoMismatch"] = True
            _rescued["limitations"] = list(_rescued.get("limitations") or []) + _plan["limitations"] + \
                [x for x in result["limitations"] if x.startswith("录音开头")]
            return _rescued
        result["summary"]["rescueAttempts"] = _plan["attempts"]
        if _plan["advice"] and not _drift:
            result["summary"]["syncAdvice"] = _plan["advice"]
    return result
