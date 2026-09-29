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

from .engine import parse_score

VERSION = "piano-midi-0.2"
MATCH_WINDOW_SEC = 0.30
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


def analyze_piano(wav: bytes, xml: str, bpm: float, start_measure: int = 1) -> dict:
    score_notes = [n for n in parse_score(xml) if n["measure"] >= start_measure]
    if not score_notes:
        raise ValueError("开始小节没有可演奏音符")
    perf = transcribe_notes(wav)
    if not perf:
        raise ValueError("钢琴转录失败，请检查录音是否为清晰的独奏钢琴")
    perf = sorted(perf, key=lambda e: (e[0], e[2]))
    sec_per_beat = 60.0 / bpm
    # Anchor on the first transcribed onset that plays the opening pitch, so a
    # leading resonance ghost (different pitch) cannot drag the whole grid.
    first_pitch = score_notes[0]["pitchMidi"]
    anchor_onset = next((o for o, _a, p, _v in perf if int(round(p)) == first_pitch), perf[0][0])
    start = anchor_onset - score_notes[0]["onsetBeat"] * sec_per_beat
    used = [False] * len(perf)
    aligned = []
    pitch_errors, timing_errors = [], []
    extra = 0
    for idx, note in enumerate(score_notes):
        expected = start + note["onsetBeat"] * sec_per_beat
        best, best_dt, best_vel = -1, MATCH_WINDOW_SEC + 1.0, -1.0
        for j, (onset, _off, pitch, vel) in enumerate(perf):
            if used[j] or int(round(pitch)) != note["pitchMidi"]:
                continue
            dt = abs(onset - expected)
            # Closest onset wins; ties (pedal blur doubles) go to the stronger strike.
            if dt < best_dt - 1e-9 or (abs(dt - best_dt) <= 1e-9 and vel > best_vel):
                best, best_dt, best_vel = j, dt, vel
        if best < 0:
            aligned.append({**note, "id": f"n{idx + 1}", "expectedSec": round(expected, 3),
                            "performedSec": None, "pitchErrorCents": None, "timingErrorMs": None,
                            "confidence": 0.0, "pitchStatus": "uncertain", "timingStatus": "uncertain",
                            "matchStatus": "missed", "status": "missed"})
            continue
        used[best] = True
        onset, _off, pitch, vel = perf[best]
        cents = round((pitch - note["pitchMidi"]) * 100, 1)
        delta = round((onset - expected) * 1000)
        pitch_errors.append(abs(cents))
        timing_errors.append(delta)
        pitch_status = "correct" if abs(cents) <= 50 else ("sharp" if cents > 0 else "flat")
        timing_status = "late" if delta > 80 else ("early" if delta < -80 else "correct")
        if pitch_status != "correct":
            status = "wrong_pitch"
        else:
            status = timing_status if timing_status in ("late", "early") else "correct"
        aligned.append({**note, "id": f"n{idx + 1}", "expectedSec": round(expected, 3),
                        "performedSec": round(onset, 3), "pitchErrorCents": cents,
                        "timingErrorMs": delta, "confidence": round(min(1.0, vel / 127.0), 2),
                        "pitchStatus": pitch_status, "timingStatus": timing_status,
                        "matchStatus": "matched", "status": status})
    # Extras only count inside the excerpt window: pedal resonance and notes from
    # outside the practiced passage must not inflate the score.
    last_expected = start + score_notes[-1]["onsetBeat"] * sec_per_beat
    for j, (onset, _off, _p, _v) in enumerate(perf):
        if not used[j] and (start - 0.5) <= onset <= (last_expected + 1.0):
            extra += 1
    last_onset = perf[-1][0]
    pitch_score = None
    correct = sum(n["pitchStatus"] == "correct" for n in aligned)
    wrong = sum(n["pitchStatus"] in ("sharp", "flat") for n in aligned)
    if pitch_errors and len(pitch_errors) / len(score_notes) >= .6:
        import numpy as np
        pitch_score = round(max(0, 100 - float(np.mean(np.minimum(
            np.array(pitch_errors, dtype=float), 100))) * 1.2))
    rhythm_score = timing_accuracy = stability = spread = offset = None
    if len(timing_errors) >= 3 and len(timing_errors) / max(1, len(score_notes)) >= .6:
        import numpy as np
        arr = np.array(timing_errors, dtype=float)
        offset = round(float(np.median(arr)))
        spread = round(float(np.median(np.abs(arr - offset))))
        stability = round(max(0, 100 - spread * .55))
        timing_accuracy = round(max(0, 100 - float(np.median(np.abs(arr))) * .4))
        rhythm_score = round(max(0, 100 - spread * .45 - abs(offset) * .3))
    import xml.etree.ElementTree as ET
    part = ET.fromstring(xml).find("./{*}part")
    measure_count = len(part.findall("./{*}measure")) if part is not None else 0
    return {"version": VERSION, "instrument": "piano", "bpm": bpm, "mode": "note-aligned-polyphonic",
            "summary": {"pitchScore": pitch_score, "intonationScore": None,
                        "correctPitchNotes": correct, "wrongPitchNotes": wrong,
                        "missedNotes": sum(n["status"] == "missed" for n in aligned),
                        "extraNotes": extra,
                        "rhythmScore": rhythm_score, "timingAccuracyScore": timing_accuracy,
                        "rhythmStabilityScore": stability, "timingOffsetMs": offset,
                        "timingSpreadMs": spread,
                        "measureCount": measure_count,
                        "startMeasure": score_notes[0]["measure"],
                        "endMeasure": score_notes[-1]["measure"],
                        "noteCount": len(score_notes), "voicedNotes": len(pitch_errors),
                        "timedNotes": len(timing_errors),
                        "confidence": "medium" if len(pitch_errors) / len(score_notes) >= .8 else "low",
                        "syncMode": "legacy", "recordedFirstBeatSec": None,
                        "estimatedLatencyMs": None, "coveredSec": round(float(last_onset), 3),
                        "sensors": ["piano-transcribe"], "detectedBpm": None},
            "notes": aligned,
            "limitations": ["仅支持独奏钢琴；多弹的音符计入 extraNotes，不逐个列出。",
                            "以首个转录起音为时间零点；首音不参与节奏分母。"]}
