"""Conservative fixed-tempo, monophonic bowed-string analysis.

Results are only assigned where the recording supplies enough voiced evidence.
The engine does not infer a score from the PDF or claim to handle accompaniment.
"""

import io
import math
import wave
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

import numpy as np

from .alignment import locate_excerpt, usable_events

VERSION = "string-mono-0.2"
MAX_SECONDS = 300
MAX_FIRST_BEAT_SECONDS = 20
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


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
    if not isinstance(xml, str) or len(xml) > 1_000_000 or "<!ENTITY" in xml.upper() or (
            "<!DOCTYPE" in xml.upper() and "[" in xml.split(">", 1)[0]):
        raise ValueError(f"{label}过大或包含不支持的实体声明")
    try:
        return ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ValueError(f"{label}无法解析") from exc


def parse_score(xml: str) -> list[dict]:
    # Standard MusicXML often includes an external PUBLIC DTD. ElementTree does
    # not resolve it; forbid internal entity definitions, not the normal header.
    root = xml_root(xml)
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
        for item in measure:
            tag = item.tag.rsplit("}", 1)[-1]
            if tag in ("backup", "forward"):
                raise ValueError("多声部/交错时间轴暂不支持")
            if tag != "note":
                continue
            if item.find("./{*}grace") is not None:
                continue
            if item.find("./{*}chord") is not None:
                raise ValueError("双音/和弦暂不支持")
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
                alter = musicxml_number(pitch.findtext("./{*}alter", "0"), "alter")
                if octave != octave.to_integral_value() or alter != alter.to_integral_value():
                    raise ValueError("微分音或非整数八度暂不支持")
                midi = 12 * (int(octave) + 1) + STEP[name] + int(alter)
                if not 36 <= midi <= 96:
                    raise ValueError("音域暂仅支持 MIDI 36–96")
                ties = {t.get("type") for t in item.findall("./{*}tie")}
                if "stop" in ties:
                    if not notes or notes[-1]["pitchMidi"] != midi:
                        raise ValueError("跨小节连音不完整")
                    notes[-1]["durationBeat"] += length
                else:
                    notes.append({"id": f"n{len(notes) + 1}", "measure": index, "onsetBeat": beat,
                                  "durationBeat": length, "pitchMidi": midi})
            beat += length
    if not notes or len(notes) > 1000:
        raise ValueError("MusicXML 必须包含 1–1000 个可演奏音符")
    return notes


# analyze 内部工作电平: 所有能量阈值都相对这个峰值标定。
NORMALIZED_PEAK = 0.5
# track() 每块 FFT 帧数: 128 帧 x 16384 点 complex128 约 16 MB。
TRACK_CHUNK_FRAMES = 128


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            rate = wav.getframerate()
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or not 8000 <= rate <= 48000:
                raise ValueError("请上传单声道 16-bit PCM WAV (8–48 kHz)")
            frames = wav.getnframes()
            if frames / rate > MAX_SECONDS or frames / rate < 0.4:
                raise ValueError("录音长度须为 0.4–300 秒")
            signal = np.frombuffer(wav.readframes(frames), dtype="<i2").astype(np.float32) / 32768
    except (wave.Error, EOFError) as exc:
        raise ValueError("WAV 格式无效") from exc
    if not np.isfinite(signal).all() or np.max(np.abs(signal)) < 0.005:
        raise ValueError("录音音量过低")
    return signal, rate


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


def classify_pitch(cents: float | None, detected_midi: float | None) -> str:
    """Cents 判音: 物理不可能 Verdict uncertain, 差整八度单列 octave,
    ±50 音分内 correct, 之外 sharp/flat。MIDI 只做存储, 判定全是 cents
    (1 半音=100, 1 八度=1200)。"""
    if cents is None:
        return "uncertain"
    if detected_midi is not None and (detected_midi < 36 or detected_midi > 96):
        # 大提琴最低空弦 C2=36, 谱面域上限 96: 超出则跟踪器谐波/次谐波误判。
        return "uncertain"
    if abs(abs(cents) - 1200) <= 80:
        return "octave"
    if cents > 50:
        return "sharp"
    if cents < -50:
        return "flat"
    return "correct"


def measure_start_beats(xml: str) -> dict[int, float]:
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
            if item.find("./{*}grace") is not None:
                continue
            duration = item.findtext("./{*}duration")
            if duration is None:
                raise ValueError("仅支持有明确 duration 的音符和休止符")
            beat += float(musicxml_number(duration, "duration") / divisions)
    return starts


def seconds_per_quarter(xml: str, bpm: float) -> float:
    """Convert the displayed tempo to the quarter-note beat used by notes.

    In compound eighth meters the conventional tempo unit is a dotted quarter
    (three eighths), while MusicXML durations and onsetBeat remain quarter
    notes.  Keeping this conversion here prevents a 6/8 take from drifting 50%
    slow against the score.
    """
    root = xml_root(xml)
    time = root.find("./{*}part/{*}measure/{*}attributes/{*}time")
    try:
        beats = int(time.findtext("./{*}beats")) if time is not None else 4
        beat_type = int(time.findtext("./{*}beat-type")) if time is not None else 4
    except (TypeError, ValueError) as exc:
        raise ValueError("MusicXML 拍号无效") from exc
    if beat_type == 8 and beats in (6, 9, 12):
        return 60.0 / bpm * (2.0 / 3.0)
    return 60.0 / bpm


def analyze(wav: bytes, xml: str, bpm: float, instrument: str, start_measure: int = 1,
            first_beat_audio_sec: float | None = None, sync_mode: str = "legacy",
            pitch_notes: list | None = None, onset_hint: list | None = None,
            beat_map: list | None = None) -> dict:
    """pitch_notes: [(start_sec, end_sec, midi)] 外部基频传感器(pYIN); onset_hint: [sec]
    外部起音传感器(QM)。两者都可选, 为空时退回自研检测, 打分逻辑不变。
    sync_mode="vamp-beat": 用 QM 拍点时间轴做活网格, 需 beat_map=[sec...]。"""
    if instrument not in ("violin", "viola", "cello"):
        raise ValueError("不支持的乐器")
    if not 30 <= bpm <= 200:
        raise ValueError("BPM 须在 30–200 之间")
    if sync_mode not in ("legacy", "metronome", "vamp-beat"):
        raise ValueError("无效的同步模式")
    if first_beat_audio_sec is not None and (
            not isinstance(first_beat_audio_sec, (int, float)) or
            not 0 <= float(first_beat_audio_sec) <= MAX_FIRST_BEAT_SECONDS):
        raise ValueError(f"firstBeatAudioSec 须在 0–{MAX_FIRST_BEAT_SECONDS} 秒之间")
    if sync_mode == "legacy" and first_beat_audio_sec is not None:
        raise ValueError("legacy 模式不应携带 firstBeatAudioSec")
    if sync_mode == "metronome" and first_beat_audio_sec is None:
        raise ValueError("metronome 模式需要 firstBeatAudioSec")
    score_notes = parse_score(xml)
    if type(start_measure) is not int or start_measure < 0 or start_measure > score_notes[-1]["measure"]:
        raise ValueError("开始小节没有可演奏音符")
    signal, rate = read_wav(wav)
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
    sec_per_beat = seconds_per_quarter(xml, bpm)
    # 拍点网格的单位必须是四分音符: 跟踪器锁在倍速/半速或跟附点四分/二分时,
    # 中位间隔与面板速度差很远; 此时不用网格评分/定位, 退回固定速度并显式标出。
    tempo_mismatch = False
    mismatch_bpm = None
    if sync_mode == "vamp-beat" and beat_map:
        grid = sorted(set(float(b) for b in beat_map if math.isfinite(float(b)) and float(b) >= 0))
        if len(grid) >= 4:
            interval = float(np.median(np.diff(grid)))
            if interval > 0 and not 0.8 <= interval / sec_per_beat <= 1.25:
                tempo_mismatch = True
                mismatch_bpm = round(60 / interval, 1)
                beat_map = None
    auto_located = start_measure == 0
    location_cost = None
    if auto_located:
        if sync_mode == "metronome" or first_beat_audio_sec is not None:
            raise ValueError("自动定位仅支持未同步的单声部录音")
        if not pitch_notes:
            raise ValueError("自动定位需要 pYIN 音高传感器；请指定起始小节")
        reliable_events = usable_events(pitch_notes)
        index, location_cost = locate_excerpt(score_notes, pitch_notes,
                                              beat_map=beat_map if sync_mode == "vamp-beat" else None)
        location_anchor = reliable_events[0][0]
        notes = score_notes[index:]
        start_measure = notes[0]["measure"]
    else:
        notes = [n for n in score_notes if n["measure"] >= start_measure]
    times, pitches, energy, confidence = _hint_track(signal, rate, pitch_notes) if pitch_notes \
        else track(signal, rate)
    if len(times) < 8:
        raise ValueError("有效录音过短")
    active = np.flatnonzero(energy > max(0.012, np.max(energy) * 0.10))
    voiced = np.flatnonzero(np.isfinite(pitches) & (energy > max(0.012, np.max(energy) * 0.10)))
    if not len(active) or not len(voiced):
        raise ValueError("无法检测到演奏")
    onsets = [float(times[active[0]])]
    for i in range(2, len(times)):
        if energy[i] < 0.012:
            continue
        pitch_jump = np.isfinite(pitches[i]) and np.isfinite(pitches[i - 2]) and abs(pitches[i] - pitches[i - 2]) >= 0.85
        # 半音连奏: 过渡帧把 2 帧差摊薄到 ~0.8 半音, 漏检起音 (#11)。补一个稳定阶跃判据:
        # 前段(i-6..i-3)与后段(i..i+2)各自平稳 (ptp<0.35), 中位数差 >= 0.6 半音。
        # 两段都要求平稳, 揉弦 (连续摆动) 不满足; 风险见 PERFORMANCE-ANALYSIS-PLAN.md #11。
        if not pitch_jump and 6 <= i <= len(times) - 3:
            before, after = pitches[i - 6:i - 2], pitches[i:i + 3]
            if np.isfinite(before).all() and np.isfinite(after).all() and \
                    float(np.ptp(before)) < 0.35 and float(np.ptp(after)) < 0.35:
                pitch_jump = abs(float(np.median(after)) - float(np.median(before))) >= 0.6
        attack = energy[i] > max(0.018, energy[i - 2] * 1.85) and energy[i] - energy[i - 2] > 0.008
        if (pitch_jump or attack) and times[i] - onsets[-1] > 0.09:
            onsets.append(float(times[i]))
    if onset_hint:
        # 外部起音传感器(QM)补入: 与已检出起音按 150 ms 并档去重, 只收编新沿
        for h in sorted(float(o) for o in onset_hint):
            if h > onsets[0] - 0.05 and all(abs(h - o) > 0.15 for o in onsets):
                onsets.append(h)
        onsets.sort()
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
            detected_bpm = round(60 / med, 1) if med > 0 else None
            audio_anchor = location_anchor if auto_located else onsets[0]
            anchor = int(np.argmin(np.abs(beats - audio_anchor)))
            anchor_shift = audio_anchor - beats[anchor] if auto_located else 0.0

            def beat_time(rel_beat: float) -> float:  # noqa: F811
                pos = anchor + rel_beat
                if pos <= 0:
                    return float(beats[0] + pos * med + anchor_shift)
                if pos >= len(beats) - 1:
                    return float(beats[-1] + (pos - (len(beats) - 1)) * med + anchor_shift)
                i = int(pos)
                f = pos - i
                return float(beats[i] * (1 - f) + beats[i + 1] * f + anchor_shift)

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
    # Score excerpts can start at any measure. Never count score notes beyond
    # the recording as missed notes, including when the full score is hours long.
    last_voiced = times[voiced[-1]]
    notes = [n for n in notes if (beat_time(n["onsetBeat"] - base_beat) if beat_time is not None
                                else start + n["onsetBeat"] * sec_per_beat) <= last_voiced + 0.06]
    if not notes:
        raise ValueError("录音不足以覆盖所选开始小节")
    aligned = []
    pitch_errors, timing_errors = [], []
    timing_at: list[float] = []
    measured_count = 0
    # legacy/metronome 是固定网格: 整体偏慢/偏快时误差逐音累积, 几小节后搜索窗
    # 落到邻音上, 把速度问题误报成错音。只让"去哪儿找"跟随已测起音的线性趋势;
    # 计时误差仍对固定网格计算, 拖慢照实报 late, 期望与实测不同源。
    drift_obs: list[tuple[float, float]] = []
    last_onset = -1.0
    prev_duration: float | None = None

    def predicted_drift(at: float) -> float:
        if beat_time is not None or not drift_obs:
            return 0.0
        xs = np.array([x for x, _ in drift_obs[-8:]])
        ds = np.array([d for _, d in drift_obs[-8:]])
        if len(xs) < 3 or float(np.ptp(xs)) <= 0:
            return float(np.median(ds))
        slope = max(-0.25, min(0.25, float(np.polyfit(xs, ds, 1)[0])))
        return float(np.mean(ds) + slope * (at - np.mean(xs)))

    for note_index, note in enumerate(notes):
        if beat_time is not None:
            expected = beat_time(note["onsetBeat"] - base_beat)
        else:
            expected = start + note["onsetBeat"] * sec_per_beat
        duration = (beat_time(note["onsetBeat"] - base_beat + note["durationBeat"]) - expected
                    if auto_located and beat_time is not None else note["durationBeat"] * sec_per_beat)
        # 换把滑音需要更长的稳定时间: 与前音差 3 半音以上时, 音高窗跳过前 35%。
        shifted = note_index > 0 and abs(note["pitchMidi"] - notes[note_index - 1]["pitchMidi"]) >= 3
        # 时间误差与稳态音高分开估计，避开擦弦、滑音和收尾。
        center = expected + predicted_drift(expected)
        reach = min(0.22, duration * 0.35)
        # 固定网格模式下起音单调且一一匹配: 前一音符已占用的起音不可复用,
        # 否则回退窗会把前一音的起音当成本音 (拖慢时尤甚)。
        free = [t for t in onsets if beat_time is not None or t > last_onset + 0.05]
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
            wide = [t for t in onsets if t > last_onset + 0.05 and expected - early_reach <= t <= expected + late_reach]
            if wide:
                onset = min(wide, key=lambda t: abs(t - expected))
                ref = onset
                wide_hit = True
        prev_duration = duration
        if onset is not None:
            last_onset = onset
            # 宽窗命中是离群点, 喂给趋势会让线性外推冲过头、抓到下一音的起音。
            if beat_time is None and not wide_hit:
                drift_obs.append((expected, onset - expected))
        skip = duration * 0.35 if shifted else min(0.12, duration * 0.28)
        # 音高窗不越过下一个实测起音: 本音拖、下音抢时两音被挤压, 固定 78% 时长
        # 会采到下一音 (#5)。只在本音起音已测到时截断; 起音漏检时下一个
        # 起音可能就是本音自己的, 截断会把窗口清空。
        hi_edge = ref + duration * 0.78
        if onset is not None:
            nxt = min((t for t in onsets if t > onset + 0.05), default=None)
            if nxt is not None:
                hi_edge = min(hi_edge, nxt - 0.03)
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
                svalid = (times >= lo) & (times <= hi) & np.isfinite(pitches) & (confidence >= 0.7)
                if np.count_nonzero(svalid) >= 4:
                    detected = float(np.median(pitches[svalid]))
                    cents = round((detected - note["pitchMidi"]) * 100, 1)
                    quality = round(float(np.median(confidence[svalid])), 2)
        else:
            detected = float(np.median(pitches[valid])) if np.count_nonzero(valid) >= 4 else None
            cents = round((detected - note["pitchMidi"]) * 100, 1) if detected is not None else None
            quality = round(float(np.median(confidence[valid])), 2) if cents is not None else 0.0
        delta = round((onset - expected) * 1000) if onset is not None else None
        if cents is not None:
            measured_count += 1
        # 无起音的短音差三度以上: 窗内多半是邻音, 无分段不指控。
        # (覆盖率仍计入 measured: 测到了帧, 只是不敢判。)
        if onset is None and duration < 0.25 and cents is not None and abs(cents) > 200:
            cents = None
            quality = 0.0
        pitch_status = classify_pitch(cents, detected)
        if cents is not None and pitch_status in ("sharp", "flat", "correct"):
            pitch_errors.append(abs(cents))
        if delta is not None and note_index > 0:
            timing_errors.append(delta)
            timing_at.append(expected)
        timing_status = "unscored" if note_index == 0 else "uncertain" if delta is None else "late" if delta > 80 else "early" if delta < -80 else "correct"
        status = "uncertain" if cents is None else "octave_uncertain" if pitch_status == "octave" else "wrong_pitch" if pitch_status in ("sharp", "flat") else \
            "timing_uncertain" if note_index > 0 and delta is None else timing_status if timing_status in ("late", "early") else "correct"
        aligned.append({**note, "expectedSec": round(expected, 3), "performedSec": round(onset, 3) if onset is not None else None,
                        "pitchErrorCents": cents, "timingErrorMs": delta if note_index > 0 else None,
                        "confidence": quality, "pitchStatus": pitch_status, "timingStatus": timing_status,
                        "matchStatus": "matched" if cents is not None else "uncertain", "status": status})
    # 不将不可判断的音符作为正确或错误；节奏得分只在至少三个起音可匹配时给出。
    pitch_score = None
    intonation_score = None
    correct_pitch_notes = sum(n["pitchStatus"] == "correct" for n in aligned)
    wrong_pitch_notes = sum(n["pitchStatus"] in ("sharp", "flat") for n in aligned)
    octave_uncertain_notes = sum(n["pitchStatus"] == "octave" for n in aligned)
    voiced_count = measured_count
    if pitch_errors and voiced_count / len(notes) >= .6:
        # Capped mean keeps one noisy frame bounded, but unlike a median it cannot
        # hide a substantial minority of clearly wrong notes.
        pitch_score = round(max(0, 100 - float(np.mean(np.minimum(pitch_errors, 100))) * 1.2))
        in_tune = [abs(float(n["pitchErrorCents"])) for n in aligned if n["pitchStatus"] == "correct"]
        intonation_score = round(max(0, 100 - float(np.median(in_tune)) * 1.2)) if in_tune else None
    rhythm_score = None
    timing_accuracy_score = None
    rhythm_stability_score = None
    rhythm_spread = None
    timing_offset = None
    if len(timing_errors) >= 3 and len(timing_errors) / max(1, len(notes) - 1) >= .6:
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
        rhythm_stability_score = round(max(0, 100 - rhythm_spread * .55))
        # 截断均值而非中位数 (#9): 中位数会掩盖少数严重偏差 (1/4 音 +400 ms 仍得 90)。
        # 单音误差截断在 250 ms, 一个离群点有上限, 与 pitchScore 的截断均值同一思路。
        timing_accuracy_score = round(max(0, 100 - float(np.mean(np.minimum(np.abs(timing_errors), 250))) * .4))
        rhythm_score = round(max(0, 100 - rhythm_spread * .45 - abs(timing_offset) * .3))
    duration_sec = round(float(len(signal) / rate), 3)
    clipped = raw_clipped  # 归一化前测得, 见 read_wav 调用处
    sensors = (["fused-pitch"] if pitch_notes else []) + (["qm-onset"] if onset_hint else []) or ["builtin"]
    return {"version": VERSION, "instrument": instrument, "bpm": bpm, "mode": "fixed-tempo-monophonic",
            "summary": {"pitchScore": pitch_score, "intonationScore": intonation_score,
                        "correctPitchNotes": correct_pitch_notes, "wrongPitchNotes": wrong_pitch_notes,
                        "octaveUncertainNotes": octave_uncertain_notes,
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
                        "clipped": clipped, "detectedBpm": detected_bpm if detected_bpm is not None else mismatch_bpm,
                        "tempoMismatch": tempo_mismatch},
            "notes": aligned, "limitations": ["仅支持单声部无明显伴奏；长滑音、揉弦、重复音起音可能无法可靠判定。",
                                           "音高按十二平均律；首音作为时间零点，不计入节奏得分。"
                                           if sync_mode == "legacy" else
                                           "音高按十二平均律；节拍器第一拍锚定时间轴，后端仅做 ±150 ms 微调。"]}
