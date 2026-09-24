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

VERSION = "string-mono-0.1"
MAX_SECONDS = 90
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def musicxml_number(text: str | None, label: str) -> Decimal:
    try:
        value = Decimal(text if text is not None else "")
    except InvalidOperation as exc:
        raise ValueError(f"MusicXML {label} 无效") from exc
    if not value.is_finite():
        raise ValueError(f"MusicXML {label} 无效")
    return value


def parse_score(xml: str) -> list[dict]:
    # Standard MusicXML often includes an external PUBLIC DTD. ElementTree does
    # not resolve it; forbid internal entity definitions, not the normal header.
    if len(xml) > 1_000_000 or "<!ENTITY" in xml.upper() or ("<!DOCTYPE" in xml.upper() and "[" in xml.split(">", 1)[0]):
        raise ValueError("MusicXML 过大或包含不支持的实体声明")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ValueError("MusicXML 无法解析") from exc
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
        for item in measure:
            tag = item.tag.rsplit("}", 1)[-1]
            if tag in ("backup", "forward"):
                raise ValueError("多声部/交错时间轴暂不支持")
            if tag != "note":
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


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            rate = wav.getframerate()
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or not 8000 <= rate <= 48000:
                raise ValueError("请上传单声道 16-bit PCM WAV (8–48 kHz)")
            frames = wav.getnframes()
            if frames / rate > MAX_SECONDS or frames / rate < 0.4:
                raise ValueError("录音长度须为 0.4–90 秒")
            signal = np.frombuffer(wav.readframes(frames), dtype="<i2").astype(np.float32) / 32768
    except (wave.Error, EOFError) as exc:
        raise ValueError("WAV 格式无效") from exc
    if not np.isfinite(signal).all() or np.max(np.abs(signal)) < 0.005:
        raise ValueError("录音音量过低")
    return signal, rate


def track(signal: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    # 约 12 ms hop、93 ms Hann 窗；自相关法只适合单声部基频。
    hop = max(1, int(rate * 0.012))
    size = max(1024, 2 ** math.ceil(math.log2(rate * 0.093)))
    lo, hi = max(2, int(rate / 1200)), min(size // 2, int(rate / 65))
    window = np.hanning(size).astype(np.float32)
    times, pitches, energies, confidences = [], [], [], []
    for start in range(0, max(1, len(signal) - size + 1), hop):
        frame = signal[start:start + size]
        if len(frame) < size:
            break
        rms = float(np.sqrt(np.mean(frame ** 2)))
        times.append((start + size / 2) / rate)
        energies.append(rms)
        if rms < 0.008:
            pitches.append(float("nan"))
            confidences.append(0.0)
            continue
        f = np.fft.rfft(frame * window, n=2 * size)
        ac = np.fft.irfft(f * f.conj(), n=2 * size)[:size]
        candidates = ac[lo:hi + 1] / (ac[0] * (1 - np.arange(lo, hi + 1) / size) + 1e-10)
        peaks = np.where((candidates[1:-1] >= candidates[:-2]) & (candidates[1:-1] >= candidates[2:]))[0] + 1
        maximum = float(np.max(candidates))
        # 首个强峰偏向基频而非 2 倍周期；低置信片段不强行定音。
        strong = peaks[candidates[peaks] >= max(0.7, maximum * 0.93)]
        idx = int(strong[0]) if len(strong) else int(np.argmax(candidates))
        confidence = float(candidates[idx])
        confidences.append(confidence)
        pitches.append(69 + 12 * math.log2(rate / (lo + idx) / 440) if confidence >= 0.7 else float("nan"))
    return tuple(np.asarray(x) for x in (times, pitches, energies, confidences))


def measure_start_beats(xml: str) -> dict[int, float]:
    """Map 1-based measure number -> absolute downbeat in quarter-note beats.

    Includes rest-only measures. Independent from parse_score so the playback
    cursor and the metronome-anchored analysis share one definition of
    "measure N beat 1".
    """
    if len(xml) > 1_000_000 or "<!ENTITY" in xml.upper():
        raise ValueError("MusicXML 过大或包含不支持的实体声明")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ValueError("MusicXML 无法解析") from exc
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
            duration = item.findtext("./{*}duration")
            if duration is None:
                raise ValueError("仅支持有明确 duration 的音符和休止符")
            beat += float(musicxml_number(duration, "duration") / divisions)
    return starts


def analyze(wav: bytes, xml: str, bpm: float, instrument: str, start_measure: int = 1,
            first_beat_audio_sec: float | None = None, sync_mode: str = "legacy") -> dict:
    if instrument not in ("violin", "viola", "cello"):
        raise ValueError("不支持的乐器")
    if not 30 <= bpm <= 200:
        raise ValueError("BPM 须在 30–200 之间")
    if sync_mode not in ("legacy", "metronome"):
        raise ValueError("无效的同步模式")
    if first_beat_audio_sec is not None and (
            not isinstance(first_beat_audio_sec, (int, float)) or not 0 <= float(first_beat_audio_sec) <= 10):
        raise ValueError("firstBeatAudioSec 须在 0–10 秒之间")
    if sync_mode == "legacy" and first_beat_audio_sec is not None:
        raise ValueError("legacy 模式不应携带 firstBeatAudioSec")
    if sync_mode == "metronome" and first_beat_audio_sec is None:
        raise ValueError("metronome 模式需要 firstBeatAudioSec")
    score_notes = parse_score(xml)
    if type(start_measure) is not int or start_measure < 1 or start_measure > score_notes[-1]["measure"]:
        raise ValueError("开始小节没有可演奏音符")
    notes = [n for n in score_notes if n["measure"] >= start_measure]
    signal, rate = read_wav(wav)
    times, pitches, energy, confidence = track(signal, rate)
    if len(times) < 8:
        raise ValueError("有效录音过短")
    active = np.flatnonzero(energy > max(0.012, np.max(energy) * 0.10))
    voiced = np.flatnonzero(np.isfinite(pitches) & (energy > max(0.012, np.max(energy) * 0.10)))
    if not len(active) or not len(voiced):
        raise ValueError("无法检测到演奏")
    sec_per_beat = 60 / bpm
    estimated_latency_ms: int | None = None
    if sync_mode == "metronome":
        # The client records the metronome downbeat of start_measure.
        # Trust it as the base timeline, then apply only a small bounded
        # correction from the first voiced frame so a bad onset cannot
        # drag the whole excerpt to the wrong place.
        base_beat = measure_start_beats(xml)[start_measure]
        start = float(first_beat_audio_sec) - base_beat * sec_per_beat
        raw_latency = (float(times[voiced[0]]) - 0.047) - (start + notes[0]["onsetBeat"] * sec_per_beat)
        clamped = max(-0.15, min(0.15, raw_latency))
        start += clamped
        estimated_latency_ms = round(clamped * 1000)
    else:
        # Align the first pitched onset with the first written note, even if the
        # MusicXML starts with an all-rest measure. Silence before it is not scored.
        start = (times[voiced[0]] - 0.047) - notes[0]["onsetBeat"] * sec_per_beat
    # Score excerpts can start at any measure. Never count score notes beyond
    # the recording as missed notes, including when the full score is hours long.
    last_voiced = times[voiced[-1]]
    notes = [n for n in notes if start + n["onsetBeat"] * sec_per_beat <= last_voiced + 0.06]
    if not notes:
        raise ValueError("录音不足以覆盖所选开始小节")
    onsets = [float(times[active[0]])]
    for i in range(2, len(times)):
        if energy[i] < 0.012:
            continue
        pitch_jump = np.isfinite(pitches[i]) and np.isfinite(pitches[i - 2]) and abs(pitches[i] - pitches[i - 2]) >= 0.85
        attack = energy[i] > max(0.018, energy[i - 2] * 1.85) and energy[i] - energy[i - 2] > 0.008
        if (pitch_jump or attack) and times[i] - onsets[-1] > 0.09:
            onsets.append(float(times[i]))
    aligned = []
    pitch_errors, timing_errors = [], []
    for note in notes:
        expected = start + note["onsetBeat"] * sec_per_beat
        duration = note["durationBeat"] * sec_per_beat
        # 时间误差与稳态音高分开估计，避开擦弦、滑音和收尾。
        candidates = [t for t in onsets if abs(t - expected) <= min(0.22, duration * 0.35)]
        onset = min(candidates, key=lambda t: abs(t - expected)) if candidates else None
        mask = (times >= expected + min(0.12, duration * 0.28)) & (times <= expected + duration * 0.78)
        valid = mask & np.isfinite(pitches) & (confidence >= 0.7)
        cents = round(float((np.median(pitches[valid]) - note["pitchMidi"]) * 100), 1) if np.count_nonzero(valid) >= 4 else None
        quality = round(float(np.median(confidence[valid])), 2) if cents is not None else 0.0
        delta = round((onset - expected) * 1000) if onset is not None else None
        if cents is not None:
            pitch_errors.append(abs(cents))
        if delta is not None and note is not notes[0]:
            timing_errors.append(delta)
        aligned.append({**note, "expectedSec": round(expected, 3), "performedSec": round(onset, 3) if onset is not None else None,
                        "pitchErrorCents": cents, "timingErrorMs": delta if note is not notes[0] else None,
                        "confidence": quality, "status": "uncertain" if cents is None else
                        "wrong_pitch" if abs(cents) > 50 else "late" if delta is not None and delta > 80 else
                        "early" if delta is not None and delta < -80 else "correct"})
    # 不将不可判断的音符作为正确或错误；节奏得分只在至少三个起音可匹配时给出。
    pitch_score = round(max(0, 100 - float(np.median(pitch_errors)) * 1.2)) if pitch_errors and len(pitch_errors) / len(notes) >= .6 else None
    rhythm_score = None
    rhythm_spread = None
    timing_offset = None
    if len(timing_errors) >= 3 and len(timing_errors) / max(1, len(notes) - 1) >= .6:
        timing_offset = round(float(np.median(timing_errors)))
        rhythm_spread = round(float(np.median(np.abs(np.array(timing_errors) - timing_offset))))
        rhythm_score = round(max(0, 100 - rhythm_spread * .55))
    duration_sec = round(float(len(signal) / rate), 3)
    return {"version": VERSION, "instrument": instrument, "bpm": bpm, "mode": "fixed-tempo-monophonic",
            "summary": {"pitchScore": pitch_score, "rhythmScore": rhythm_score,
                        "timingOffsetMs": timing_offset, "timingSpreadMs": rhythm_spread,
                        "measureCount": len(ET.fromstring(xml).find("./{*}part").findall("./{*}measure")),
                        "startMeasure": notes[0]["measure"], "endMeasure": notes[-1]["measure"],
                        "noteCount": len(notes), "voicedNotes": len(pitch_errors), "timedNotes": len(timing_errors),
                        "confidence": "medium" if len(pitch_errors) / len(notes) >= .8 else "low",
                        "syncMode": sync_mode,
                        "recordedFirstBeatSec": round(float(first_beat_audio_sec), 3) if first_beat_audio_sec is not None else None,
                        "estimatedLatencyMs": estimated_latency_ms,
                        "coveredSec": duration_sec},
            "notes": aligned, "limitations": ["仅支持单声部无明显伴奏；长滑音、揉弦、重复音起音可能无法可靠判定。",
                                           "音高按十二平均律；首音作为时间零点，不计入节奏得分。"
                                           if sync_mode == "legacy" else
                                           "音高按十二平均律；节拍器第一拍锚定时间轴，后端仅做 ±150 ms 微调。"]}
