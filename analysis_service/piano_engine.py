"""Polyphonic piano channel: ByteDance transcription -> MIDI notes -> score alignment.

Unlike the monophonic FFT pipeline in engine.py, piano takes are transcribed to
note events (onset/offset/pitch/velocity) and matched note-by-note against the
score. No Vamp/pYIN hints are involved; transcription IS the sensor.
"""
import io
import json
import os
import time
import urllib.request
import uuid

from collections import Counter, defaultdict

import numpy as np

from .engine import read_wav
from .piano_align import align, smooth_map
from .piano_score import has_repeats, parse_piano_score
from .validation import validate_instrument, validate_bpm

VERSION = "piano-align-0.4"
SMOOTH_HALF_WINDOW_BEATS = 2.0   # tempo shaping slower than this is rubato, faster is rhythm
CHORD_UNEVEN_MS = 50             # chord notes spread wider than this sound split
# 5090 transcription service (Tailscale). Override with env; old public IP is dead (CGNAT).
PIANO_API_URL = os.environ.get("PIANO_API_URL", "http://100.88.202.126:7777").rstrip("/")
POLL_TIMEOUT_SEC = 400


def _api(path: str, body: bytes | None = None, headers: dict | None = None, timeout: int = 30) -> bytes:
    req = urllib.request.Request(PIANO_API_URL + path, data=body, headers=headers or {}, method="POST" if body else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _post_audio(wav: bytes) -> str:
    boundary = uuid.uuid4().hex
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"take.wav\"\r\n"
            f"Content-Type: audio/wav\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    data = json.loads(_api("/api/jobs", body=head + wav + tail,
                            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=60))
    job_id = data.get("job_id")
    if not job_id:
        raise ValueError(f"transcribe rejected: {data}")
    return job_id


def _parse_midi(data: bytes) -> list:
    import mido
    mid = mido.MidiFile(file=io.BytesIO(data))
    abs_time, open_notes, out = 0.0, {}, []
    for msg in mid:  # merged across tracks, msg.time in seconds (delta)
        abs_time += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            open_notes.setdefault((msg.channel, msg.note), []).append((abs_time, msg.velocity))
        elif msg.type in ("note_off",) or (msg.type == "note_on"):
            stack = open_notes.get((msg.channel, msg.note))
            if stack:
                start, vel = stack.pop(0)
                if abs_time > start:
                    out.append((start, abs_time, float(msg.note), float(vel)))
    return sorted(out, key=lambda e: (e[0], e[2]))


def transcribe_notes(wav: bytes) -> list | None:
    """WAV bytes -> [(onset_sec, offset_sec, midi_float, velocity)] via 5090, or None."""
    try:
        job_id = _post_audio(wav)
        deadline = time.time() + POLL_TIMEOUT_SEC
        midi_path = None
        while time.time() < deadline:
            job = json.loads(_api(f"/api/jobs/{job_id}", timeout=30))
            status = job.get("status")
            if status == "done":
                midi_path = job.get("midi_url") or f"/api/jobs/{job_id}/midi"
                break
            if status in ("failed", "error") or job.get("error"):
                return None
            time.sleep(1.0)
        if not midi_path:
            return None
        notes = _parse_midi(_api(midi_path, timeout=60))
        return notes or None
    except Exception:
        return None


def _candidates(xml: str, start_measure: int):
    """Score readings to try: unfolded repeats, and as printed when the score has repeats."""
    for unfold in ([True, False] if has_repeats(xml) else [True]):
        spans: list = []
        notes = parse_piano_score(xml, unfold=unfold, spans=spans)
        if start_measure > 0:
            starts = [b for m, b, _e in spans if m == start_measure]
            if not starts:
                continue
            notes = [n for n in notes if n["onsetBeat"] >= starts[0] - 1e-6]
            spans = [s for s in spans if s[1] >= starts[0] - 1e-6]
        if notes:
            yield unfold, notes, spans


def _scope(notes, r, audio_sec: float, auto: bool):
    """Score notes this take is judged on: from the start measure (or the located start) to the
    last matched group, plus later notes the recording still had time for."""
    played = sorted(set(r["match"]) | set(r["wrong"]))
    if not played:
        return []
    first = played[0] if auto else 0
    last = played[-1]
    first_beat = notes[first]["onsetBeat"]
    last_beat = notes[last]["onsetBeat"]
    exp = r["expected"]
    return [k for k, n in enumerate(notes)
            if n["onsetBeat"] >= first_beat - 1e-6 and (n["onsetBeat"] <= last_beat + 1e-6 or (not auto and exp[k] < audio_sec))]


def analyze_piano(wav: bytes, xml: str, bpm: float, start_measure: int = 1, perf: list | None = None) -> dict:
    """start_measure 0 = locate the excerpt automatically. perf: pre-transcribed events (tests/benchmarks)."""
    validate_instrument("piano", ["piano"])
    validate_bpm(bpm, 30, 200)
    signal, rate = read_wav(wav)
    audio_sec = len(signal) / rate
    if perf is None:
        perf = transcribe_notes(wav)
        if not perf:
            raise ValueError("钢琴转录失败，请检查录音是否为清晰的独奏钢琴")
    perf = sorted((tuple(e) for e in perf if 0 <= e[0] < audio_sec), key=lambda e: (e[0], e[2]))
    if not perf:
        raise ValueError("钢琴转录未返回录音范围内的音符")
    auto = start_measure == 0
    best = None
    for unfold, notes, spans in _candidates(xml, start_measure):
        try:
            r = align(notes, perf, free_score_start=auto, sec_per_beat=60.0 / bpm)
        except ValueError:
            continue
        scope = _scope(notes, r, audio_sec, auto)
        lo, hi = r["window_sec"]
        heard = sum(lo <= e[0] <= hi for e in perf)
        quality = 2 * len(r["match"]) / max(1, len(scope) + heard)
        if best is None or quality > best[0]:
            best = (quality, unfold, notes, spans, r, scope)
    if best is None:
        raise ValueError("开始小节没有可演奏音符" if start_measure > 0 else "录音与谱面对不上")
    _q, unfold, notes, spans, r, scope = best
    if not scope:
        raise ValueError("录音与谱面对不上：没有匹配到谱面音符")
    match, wrong = r["match"], r["wrong"]
    smooth = smooth_map(r["tempo"], SMOOTH_HALF_WINDOW_BEATS)
    in_scope = set(scope)

    aligned, residuals = [], []
    first_group_beat = notes[scope[0]]["onsetBeat"]
    for idx, k in enumerate(scope):
        n = notes[k]
        expected = float(smooth(n["onsetBeat"]))
        base = {**n, "id": f"n{idx + 1}", "expectedSec": round(expected, 3)}
        if k in match or k in wrong:
            j = match.get(k, wrong.get(k))
            onset, _off, pitch, vel = perf[j]
            played = int(round(pitch))
            cents = (played - n["pitchMidi"]) * 100
            first = abs(n["onsetBeat"] - first_group_beat) < 1e-6
            delta = round((onset - expected) * 1000)
            spb = smooth.sec_per_beat(n["onsetBeat"])
            thr = min(120, max(50, 150 * spb))
            timing = "unscored" if first else "late" if delta > thr else "early" if delta < -thr else "correct"
            if not first and k in match:
                residuals.append(delta)
            pitch_status = "correct" if k in match else ("sharp" if cents > 0 else "flat")
            status = "wrong_pitch" if k in wrong else (timing if timing in ("late", "early") else "correct")
            aligned.append({**base, "performedSec": round(onset, 3), "playedMidi": played,
                            "pitchErrorCents": cents, "timingErrorMs": None if first else delta,
                            "confidence": round(min(1.0, vel / 127.0), 2), "pitchStatus": pitch_status,
                            "timingStatus": timing, "matchStatus": "matched", "status": status})
        else:
            aligned.append({**base, "performedSec": None, "pitchErrorCents": None, "timingErrorMs": None,
                            "confidence": 0.0, "pitchStatus": "uncertain", "timingStatus": "uncertain",
                            "matchStatus": "missed", "status": "missed"})

    # Extras: unused performed notes inside the played span. A same-pitch onset right after a used
    # one is the transcriber splitting a held note, not a second strike.
    used = {match[k] for k in scope if k in match} | {wrong[k] for k in scope if k in wrong}
    used_times = [perf[j][0] for j in used]
    lo_t, hi_t = min(used_times) - 0.3, max(used_times) + 0.5
    by_pitch_used = defaultdict(list)
    for j in used:
        by_pitch_used[int(round(perf[j][2]))].append(perf[j][0])
    extra = 0
    for j, (on, _off, p, _v) in enumerate(perf):
        if j in used or not lo_t <= on <= hi_t:
            continue
        if any(0 < on - t < 0.1 for t in by_pitch_used[int(round(p))]):
            continue
        extra += 1

    correct = sum(1 for k in scope if k in match)
    wrong_n = sum(1 for k in scope if k in wrong)
    missed = len(scope) - correct - wrong_n
    performed = correct + wrong_n + extra
    pitch_score = round(200 * correct / (len(scope) + performed))

    rhythm_score = timing_accuracy = stability = spread = offset = None
    if len(residuals) >= 3 and len(residuals) / max(1, len(scope) - 1) >= .5:
        arr = np.array(residuals, dtype=float)
        offset = round(float(np.median(arr)))
        spread = round(float(np.median(np.abs(arr - offset))))
        stability = round(max(0, 100 - spread * .55))
        timing_accuracy = round(max(0, 100 - float(np.median(np.abs(arr))) * .4))
        rhythm_score = round(max(0, 100 - spread * .45 - abs(offset) * .3))

    # Chord evenness and hand coordination, from groups with two or more matched notes.
    groups = defaultdict(list)
    for k in scope:
        if k in match:
            groups[round(notes[k]["onsetBeat"], 4)].append(k)
    chord_spreads, hand_offsets, uneven_measures = [], [], Counter()
    for ks in groups.values():
        if len(ks) < 2 or any(notes[k].get("arpeggiate") for k in ks):
            continue
        ons = [perf[match[k]][0] for k in ks]
        sp = (max(ons) - min(ons)) * 1000
        chord_spreads.append(sp)
        if sp > CHORD_UNEVEN_MS:
            uneven_measures[notes[ks[0]]["measure"]] += 1
        rh = [perf[match[k]][0] for k in ks if notes[k]["staff"] == 1]
        lh = [perf[match[k]][0] for k in ks if notes[k]["staff"] == 2]
        if rh and lh:
            hand_offsets.append((np.median(rh) - np.median(lh)) * 1000)

    # Tempo: per measure from the smoothed map.
    lo_beat, hi_beat = notes[scope[0]]["onsetBeat"], notes[scope[-1]]["onsetBeat"]
    intervals, tempi = [], []
    for m, b0, b1 in spans:
        if b1 <= lo_beat - 1e-6 or b0 > hi_beat + 1e-6:
            continue
        s0, s1 = float(smooth(b0)), float(smooth(b1))
        intervals.append({"measure": m, "startSec": round(max(0.0, s0), 3), "endSec": round(max(0.0, s1), 3)})
        if s1 - s0 > 0.05:
            tempi.append(60 * (b1 - b0) / (s1 - s0))
    detected_bpm = round(float(np.median(tempi))) if tempi else None
    tempo_var = round(float(np.std(tempi) / np.mean(tempi) * 100), 1) if len(tempi) >= 3 else None

    # Same wrong pitch, same offset, in many places: more likely the score (OMR, missing accidental).
    suspects = defaultdict(list)
    for k in scope:
        if k in wrong:
            d = int(round(perf[wrong[k]][2])) - notes[k]["pitchMidi"]
            suspects[(notes[k]["pitchMidi"] % 12, d)].append(notes[k]["measure"])
    score_suspects = [{"pitchClass": pc, "semitones": d, "count": len(ms), "measures": sorted(set(ms))[:12]}
                      for (pc, d), ms in suspects.items() if len(ms) >= 4 and len(set(ms)) >= 2]

    measure_count = max((m for m, _b, _e in spans), default=0)
    voiced = correct + wrong_n
    return {"version": VERSION, "instrument": "piano", "bpm": bpm, "mode": "note-aligned-polyphonic",
            "summary": {"pitchScore": pitch_score, "intonationScore": None,
                        "correctPitchNotes": correct, "wrongPitchNotes": wrong_n,
                        "missedNotes": missed, "extraNotes": extra, "performedNoteCount": performed,
                        "pitchScoreMethod": "note-f1",
                        "truncatedByAudioEnd": scope[-1] < len(notes) - 1,
                        "rhythmScore": rhythm_score, "timingAccuracyScore": timing_accuracy,
                        "rhythmStabilityScore": stability, "timingOffsetMs": offset,
                        "timingSpreadMs": spread,
                        "measureCount": measure_count,
                        "startMeasure": notes[scope[0]]["measure"],
                        "endMeasure": notes[scope[-1]]["measure"],
                        "noteCount": len(scope), "voicedNotes": voiced,
                        "timedNotes": len(residuals),
                        "confidence": "medium" if voiced / len(scope) >= .8 else "low",
                        "syncMode": "piano-align", "recordedFirstBeatSec": None,
                        "estimatedLatencyMs": None, "coveredSec": round(audio_sec, 3),
                        "sensors": ["piano-transcribe"], "detectedBpm": detected_bpm,
                        "tempoVariationPct": tempo_var,
                        "autoLocated": auto, "repeatsUnfolded": unfold and has_repeats(xml),
                        "chordCount": len(chord_spreads),
                        "chordSpreadMs": round(float(np.median(chord_spreads))) if chord_spreads else None,
                        "unevenChords": sum(s > CHORD_UNEVEN_MS for s in chord_spreads),
                        "unevenChordMeasures": [m for m, _c in uneven_measures.most_common(8)],
                        "handOffsetMs": round(float(np.median(hand_offsets))) if len(hand_offsets) >= 3 else None,
                        "scoreSuspects": score_suspects},
            "measureIntervals": intervals,
            "notes": aligned,
            "limitations": ["仅支持独奏钢琴；音高分为音符 F1，漏音、错音和多音都会扣分。",
                            "按录音自身的速度对齐，渐快渐慢不算错；节奏分只看相对于局部速度的不均匀。",
                            "同一错音在多个小节重复出现时，更可能是谱面（OMR）错误，请核对 scoreSuspects。"]}
