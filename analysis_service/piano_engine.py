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
from .piano_audio import Spectra, StrikeModel, blind_tuning, measure_tuning, retune, wav_bytes
from .piano_score import has_repeats, parse_piano_score
from .score_trust import SYMPTOM_TEXT, assess, note_doubt, second_witness
from .validation import validate_instrument, validate_bpm
from .voice_fill import W as VOICE_W, fill_all, place

VERSION = "piano-align-0.7"
RETUNE_MIN_CENTS = 12            # a piano this far from A440 is resampled to A440 before transcription
SHIFT_MARGIN = 1.3               # a semitone-shifted reading must beat the written one by this factor
HEARD, ABSENT = 0.7, 0.3         # audio verdict thresholds on P(key struck)
MASK_INTERVALS = (12, 19, 24)    # a key whose partials are a lower sounding key's partials
RELIABLE_ERROR_RATE = 0.05       # a take this clean elsewhere: a garbled passage is more likely the score
REFUSE_EXCLUDED_SHARE = 0.3      # more doubtful notes than this: no pitch score
REFUSE_BAD_MEASURE_SHARE = 0.25  # more measures with impossible durations than this: no rhythm score
MIN_COVERAGE = 0.3               # fewer written notes found than this: score and take don't match
TEMPO_QPM_RANGE = (15, 360)      # quarter notes per minute a written score can plausibly imply
SYSTEMATIC_MIN = 4               # the same score/take conflict this often...
SYSTEMATIC_GAP_MEASURES = 4      # ...with no more than this many measures between neighbours = the score
SYSTEMATIC_CONSISTENCY = 0.7     # a lost accidental changes (nearly) every such note in its passage
SMOOTH_HALF_WINDOW_BEATS = 2.0   # tempo shaping slower than this is rubato, faster is rhythm
CHORD_UNEVEN_MS = 50             # chord notes spread wider than this sound split
VOICE_HIT, VOICE_MISS = 3.0, 1.5  # a short voice's written key found / not found in the take at a candidate onset
VOICE_AUDIO_MARGIN = 2.0         # the take must prefer the re-spaced voice by this much (beyond the score-only cue)
DOUBT_EXCLUDE = 0.5              # a measure the score is this doubtful about: its disagreements are not scored
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
        issues: list = []
        notes = parse_piano_score(xml, unfold=unfold, spans=spans, issues=issues)
        if start_measure > 0:
            starts = [b for m, b, _e in spans if m == start_measure]
            if not starts:
                continue
            notes = [n for n in notes if n["onsetBeat"] >= starts[0] - 1e-6]
            spans = [s for s in spans if s[1] >= starts[0] - 1e-6]
        if notes:
            yield unfold, notes, spans, issues


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


def _transcribe(signal, rate: int, wav: bytes, blind: float, concentration: float):
    """The transcriber assumes A440: a piano tuned away from it is resampled to A440 first."""
    if abs(blind) >= RETUNE_MIN_CENTS and concentration >= 0.5:
        shifted, ratio = retune(signal, rate, -blind)
        perf = transcribe_notes(wav_bytes(shifted, rate))
        if perf:
            return [(on * ratio, off * ratio, p, v) for on, off, p, v in perf], True
    return transcribe_notes(wav), False


def _best_alignment(xml: str, perf, start_measure: int, bpm: float, audio_sec: float):
    """Best (score reading, semitone shift) by note F1. A shift is the instrument sounding a semitone
    off the written pitch (e.g. baroque A415); it must clearly beat the unshifted reading."""
    auto = start_measure == 0
    best = None
    for shift in (0, 1, -1):
        if shift and best is not None and best[0] >= 0.7:
            break
        shifted = [(on, off, p + shift, v) for on, off, p, v in perf] if shift else perf
        for unfold, notes, spans, issues in _candidates(xml, start_measure):
            try:
                r = align(notes, shifted, free_score_start=auto, sec_per_beat=60.0 / bpm)
            except ValueError:
                continue
            scope = _scope(notes, r, audio_sec, auto)
            lo, hi = r["window_sec"]
            heard = sum(lo <= e[0] <= hi for e in shifted)
            quality = 2 * len(r["match"]) / max(1, len(scope) + heard) / (SHIFT_MARGIN if shift else 1.0)
            if best is None or quality > best[0]:
                best = (quality, shift, shifted, unfold, notes, spans, issues, r, scope)
    return best


def _fill_voices_from_take(xml: str, best):
    """Voices the OMR packed to the start of a bar (an unprinted rest): a pianist who plays both voices
    does not shift one inside a bar, so place each such voice where the take has its keys. Order and
    durations stay as written and beam groups are never split; only clear wins are applied, as
    invisible <forward> gaps. Returns (xml, fixes)."""
    _q, _shift, perf, _unfold, _notes, spans, _issues, r, _scope = best
    used = [perf[j][0] for j in dict(r["match"]).values()]
    if len(used) < 8:
        return xml, []
    lo, hi = min(used), max(used)
    smooth = smooth_map(r["tempo"], SMOOTH_HALF_WINDOW_BEATS)
    on = np.array([e[0] for e in perf])
    pitch = np.array([int(round(e[2])) for e in perf])
    starts = defaultdict(list)
    for m, b0, _b1 in spans:
        starts[m].append(b0)

    def choose(v):
        occ = [b0 for b0 in starts.get(v.measure + 1, []) if lo - 0.25 <= float(smooth(b0)) <= hi + 0.25]
        if not occ:
            return None
        step = v.beat
        for e in v.events:
            step = int(np.gcd(step, e.dur))

        def heard(i, t):
            e = v.events[i]
            if e.rest or not e.midis:
                return 0.0
            c = 0.0
            for b0 in occ:
                b = b0 + t / v.divisions
                sec = float(smooth(b))
                tol = min(0.12, 0.4 * step / v.divisions * (float(smooth(b + 1)) - sec))
                near = np.abs(on - sec) < tol
                for mm in e.midis:
                    c += -VOICE_HIT if bool(np.any(near & (pitch == mm))) else VOICE_MISS
            return c / len(occ)
        res = place(v, heard)
        if not res:
            return None
        onsets, best_cost, current_cost = res
        if all(t == e.pos for t, e in zip(onsets, v.events)):
            return None
        audio_gain = sum(heard(i, e.pos) for i, e in enumerate(v.events)) - sum(heard(i, t) for i, t in enumerate(onsets))
        if audio_gain < VOICE_AUDIO_MARGIN or current_cost - best_cost < VOICE_W["margin"]:
            return None
        return onsets
    return fill_all(xml, choose)


def _check(model, midi: int, t: float, masked: bool):
    """Audio verdict on 'key `midi` struck at t': (probability or None, label)."""
    p = model.prob(midi, t) if model is not None else None
    if p is None:
        return None, "unchecked"
    if masked:  # the key's partials coincide with a lower note's: the audio can only half-decide
        p = 0.5 + (p - 0.5) * 0.5
    return p, "heard" if p >= HEARD else "absent" if p <= ABSENT else "unclear"


def _miss_weight(p, label) -> float:
    """How much an unconfirmed note counts as a mistake."""
    return 0.0 if label == "heard" else 1.0 if label in ("absent", "unchecked") else 1.0 - p


def _span_index(spans, beat: float) -> int:
    starts = [s[1] for s in spans]
    return max(0, int(np.searchsorted(starts, beat + 1e-6, side="right")) - 1)


def _ranges(ms) -> str:
    ms = sorted(set(ms))
    out, i = [], 0
    while i < len(ms):
        j = i
        while j + 1 < len(ms) and ms[j + 1] == ms[j] + 1:
            j += 1
        out.append(f"{ms[i]}–{ms[j]}" if j > i else f"{ms[i]}")
        i = j + 1
    return "、".join(out[:8]) + ("…" if len(out) > 8 else "")


PC_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]


def _dense_runs(items, measure_of, gap: int = SYSTEMATIC_GAP_MEASURES, min_count: int = SYSTEMATIC_MIN):
    """Split items (in time order) into runs whose neighbours are at most `gap` measures apart and
    keep runs with at least `min_count` items in two or more measures: a pattern, not chance."""
    items = sorted(items, key=measure_of)
    runs, cur = [], []
    for it in items:
        if cur and measure_of(it) - measure_of(cur[-1]) > gap:
            runs.append(cur); cur = []
        cur.append(it)
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= min_count and len({measure_of(i) for i in r}) >= 2]


def midi_name(m: int) -> str:
    return f"{PC_NAMES[m % 12]}{m // 12 - 1}"


def analyze_piano(wav: bytes, xml: str, bpm: float, start_measure: int = 1, perf: list | None = None,
                  second_xml: str | None = None, trust: bool = True, fill_voices: bool = True) -> dict:
    """start_measure 0 = locate the excerpt automatically. perf: pre-transcribed events (tests/benchmarks).
    second_xml: an independent OMR reading of the same page. trust=False ignores score doubt (benchmarks).
    fill_voices: re-space voices with an unprinted rest where the take shows them (see _fill_voices_from_take)."""
    validate_instrument("piano", ["piano"])
    validate_bpm(bpm, 30, 200)
    signal, rate = read_wav(wav)
    audio_sec = len(signal) / rate
    blind, concentration = blind_tuning(signal, rate)
    retuned = False
    if perf is None:
        perf, retuned = _transcribe(signal, rate, wav, blind, concentration)
        if not perf:
            raise ValueError("钢琴转录失败，请检查录音是否为清晰的独奏钢琴")
    perf = sorted((tuple(e) for e in perf if 0 <= e[0] < audio_sec), key=lambda e: (e[0], e[2]))
    if not perf:
        raise ValueError("钢琴转录未返回录音范围内的音符")
    auto = start_measure == 0
    best = _best_alignment(xml, perf, start_measure, bpm, audio_sec)
    if best is None:
        raise ValueError("开始小节没有可演奏音符" if start_measure > 0 else "录音与谱面对不上")
    voice_fixes = []
    if fill_voices:
        filled, voice_fixes = _fill_voices_from_take(xml, best)
        again = _best_alignment(filled, perf, start_measure, bpm, audio_sec) if voice_fixes else None
        if again is not None and again[0] >= best[0]:
            xml, best = filled, again
        else:
            voice_fixes = []
    _q, shift, perf, unfold, notes, spans, issues, r, scope = best
    if not scope:
        raise ValueError("录音与谱面对不上：没有匹配到谱面音符")
    match, wrong = dict(r["match"]), dict(r["wrong"])
    # How far each measure of the score can be trusted, from the score alone and a second reading.
    trust_map = assess(xml, second_xml, parse=parse_piano_score) if trust else {}
    doubt_of = lambda m: trust_map[m]["doubt"] if m in trust_map else 0.0
    wit = second_witness(xml, second_xml, parse=parse_piano_score) if trust else {}
    smooth = smooth_map(r["tempo"], SMOOTH_HALF_WINDOW_BEATS)
    on_arr = np.array([e[0] for e in perf])
    pitch_arr = np.array([int(round(e[2])) for e in perf])
    masked = lambda m, t: bool(np.isin([m - d for d in MASK_INTERVALS], pitch_arr[np.abs(on_arr - t) < 0.08]).any())

    # --- Audio check of every disagreement, calibrated on the notes both sensors agree on.
    ref_cents = blind - 100 * shift            # the instrument's pitch relative to the written score
    spectra = Spectra(signal, rate, ref_cents)
    agreed = [match[k] for k in scope if k in match]
    model = StrikeModel(spectra, perf, agreed) if len(agreed) >= 30 else None
    gtime = defaultdict(list)
    for k in scope:
        if k in match:
            gtime[round(notes[k]["onsetBeat"], 4)].append(perf[match[k]][0])
    verdict = {}
    for k in scope:
        if k in match:
            continue
        n = notes[k]
        group_t = gtime.get(round(n["onsetBeat"], 4))
        t = perf[wrong[k]][0] if k in wrong else float(np.median(group_t)) if group_t else float(smooth(n["onsetBeat"]))
        p, label = _check(model, n["pitchMidi"], t, masked(n["pitchMidi"], t))
        if k in wrong:
            j = wrong[k]
            if label == "heard":
                wrong.pop(k)       # the written key sounded: the transcriber's neighbour is not the player's
            elif label == "absent":
                pp, plabel = _check(model, int(pitch_arr[j]), t, masked(int(pitch_arr[j]), t))
                if plabel == "absent":
                    wrong.pop(k)   # neither key sounded: a missed note, the neighbour was a ghost
        verdict[k] = {"t": t, "p": p, "label": label, "weight": _miss_weight(p, label)}

    # --- Extras: unused performed notes inside the played span, each checked in the audio. A
    # same-pitch onset right after a used one is the transcriber splitting a held note.
    used = {match[k] for k in scope if k in match} | {wrong[k] for k in scope if k in wrong}
    used_times = [perf[j][0] for j in used] or [v["t"] for v in verdict.values()]
    lo_t, hi_t = min(used_times) - 0.3, max(used_times) + 0.5
    by_pitch_used = defaultdict(list)
    for j in used:
        by_pitch_used[int(pitch_arr[j])].append(perf[j][0])
    extras = []
    for j, (on, _off, _p, _v) in enumerate(perf):
        m = int(pitch_arr[j])
        if j in used or not lo_t <= on <= hi_t or any(0 < on - t < 0.1 for t in by_pitch_used[m]):
            continue
        hidden = masked(m, on)
        p, label = _check(model, m, on, hidden)
        weight = 0.0 if label == "absent" else 1.0 if label in ("heard", "unchecked") else p
        # Every partial of this key is a partial of a lower key sounding with it: the audio cannot tell
        # a struck key from the transcriber hearing an overtone, and adding an octave is a rare mistake.
        extras.append({"j": j, "t": on, "midi": m, "p": p, "label": label, "weight": weight,
                       "overtone": hidden and label != "absent"})

    # --- Timeline per measure from the smoothed tempo map.
    lo_beat, hi_beat = notes[scope[0]]["onsetBeat"], notes[scope[-1]]["onsetBeat"]
    intervals, tempi, span_secs = [], [], {}
    for si, (m, b0, b1) in enumerate(spans):
        if b1 <= lo_beat - 1e-6 or b0 > hi_beat + 1e-6:
            continue
        s0, s1 = float(smooth(b0)), float(smooth(b1))
        span_secs[si] = (s0, s1)
        intervals.append({"measure": m, "startSec": round(max(0.0, s0), 3), "endSec": round(max(0.0, s1), 3)})
        if s1 - s0 > 0.05:
            tempi.append(60 * (b1 - b0) / (s1 - s0))
    detected_bpm = round(float(np.median(tempi))) if tempi else None

    def measure_at(t):
        for item in intervals:
            if item["startSec"] <= t < item["endSec"]:
                return item["measure"]
        return None
    tempo_var = round(float(np.std(tempi) / np.mean(tempi) * 100), 1) if len(tempi) >= 3 else None

    # --- Is the score itself trustworthy here? Each finding carries its evidence.
    evidence, excluded = [], {}
    if voice_fixes:
        ms = sorted({f["measure"] for f in voice_fixes})
        evidence.append({"kind": "voice_filled", "measures": ms, "count": len(voice_fixes),
                         "zh": f"第 {_ranges(ms)} 小节：有声部被识别成挤在小节开头（谱上省略了休止符），已按录音补上隐藏休止符再评分"
                               f"（共 {len(voice_fixes)} 处，乐谱外观不变）。",
                         "en": f"m{_ranges(ms)}: a voice was read as packed to the start of the bar (a rest left unprinted); "
                               f"hidden rests were filled from the recording before scoring ({len(voice_fixes)} places, printed score unchanged)."})
    subs = defaultdict(list)
    for k in scope:
        if k in wrong and verdict[k]["label"] != "unclear":
            subs[(notes[k]["pitchMidi"] % 12, int(pitch_arr[wrong[k]]) - notes[k]["pitchMidi"])].append(k)
    # The same key written in two voices of one staff close together, struck once: a shared notehead
    # whose rest the OMR lost (one copy lands off the beat). Not the player's miss.
    dup = []
    by_key = defaultdict(list)
    for k in scope:
        by_key[(notes[k]["staff"], notes[k]["pitchMidi"])].append(k)
    for k in scope:
        v = verdict.get(k)
        if v is None or k in wrong or v["label"] == "heard":
            continue
        n = notes[k]
        if any(k2 in match and notes[k2]["voice"] != n["voice"] and 0 < abs(notes[k2]["onsetBeat"] - n["onsetBeat"]) <= 1.0
               for k2 in by_key[(n["staff"], n["pitchMidi"])]):
            excluded[k] = "voice_duplicate"
            dup.append(k)
    if dup:
        ms = sorted({notes[k]["measure"] for k in dup})
        evidence.append({"kind": "voice_duplicate", "measures": ms, "count": len(dup),
                         "zh": f"第 {_ranges(ms)} 小节：同一个音在同一谱表的两个声部里相隔不到一拍各写了一次，录音只弹了一次"
                               f"（共 {len(dup)} 处）。多半是识别时漏了休止符，把共用的音头排错了位置；这些音不计分。",
                         "en": f"m{_ranges(ms)}: the same key is written in two voices of one staff less than a beat apart but "
                               f"struck once ({len(dup)} places). Likely a lost rest that misplaced a shared notehead; not scored."})
    score_suspects = []
    runs_found = []
    for (pc, d), all_ks in subs.items():
        for ks in _dense_runs(all_ks, lambda k: notes[k]["measure"], gap=2 * SYSTEMATIC_GAP_MEASURES):
            a, b = min(notes[k]["measure"] for k in ks), max(notes[k]["measure"] for k in ks)
            keys = {notes[k]["pitchMidi"] for k in ks}   # an accidental holds for its own octave
            written = [k for k in scope if notes[k]["pitchMidi"] in keys and a <= notes[k]["measure"] <= b]
            # A misreading player slips now and then; a score missing an accidental is wrong every time.
            if len(ks) >= SYSTEMATIC_CONSISTENCY * len(written):
                runs_found.append(((pc, d), ks))
    for (pc, d), ks in sorted(runs_found, key=lambda kv: -len(kv[1])):
        ms = sorted({notes[k]["measure"] for k in ks})
        for k in ks:
            excluded[k] = "systematic"
        confirmed = sum(verdict[k]["label"] == "absent" for k in ks)
        played = PC_NAMES[(pc + d) % 12]
        score_suspects.append({"pitchClass": pc, "semitones": d, "count": len(ks), "measures": ms[:12]})
        evidence.append({"kind": "systematic_pitch", "measures": ms, "count": len(ks), "audioConfirmed": confirmed,
                         "zh": f"谱面的 {PC_NAMES[pc]} 在第 {_ranges(ms)} 小节共 {len(ks)} 次，录音里都是 {played}"
                               f"（频谱确认 {confirmed}/{len(ks)} 次谱面音没有响）。可能是谱面识别漏了临时记号或调号变化，"
                               f"也可能是一直弹错；这些音不计入音高分，请核对谱面。",
                         "en": f"Written {PC_NAMES[pc]} sounds as {played} {len(ks)} times in m{_ranges(ms)} (audio confirms "
                               f"the written key silent {confirmed}/{len(ks)}). Likely a missed accidental or key change in the "
                               f"score, or a consistent misreading; these notes are not scored. Check the score."})
    # Measures where most written notes are confirmed absent, in a take that is otherwise clean.
    span_of = {k: _span_index(spans, notes[k]["onsetBeat"]) for k in scope}
    per_span = defaultdict(lambda: [0, 0.0])
    for k in scope:
        if k in excluded:
            continue
        per_span[span_of[k]][0] += 1
        per_span[span_of[k]][1] += verdict[k]["weight"] if k in verdict else 0.0
    bad = sorted(si for si, (cnt, err) in per_span.items() if cnt >= 3 and err / cnt >= 0.5)
    runs, cur = [], []
    for si in bad:
        if cur and si != cur[-1] + 1:
            runs.append(cur); cur = []
        cur.append(si)
    if cur:
        runs.append(cur)
    runs = [run for run in runs if len(run) >= 2]
    in_runs = {si for run in runs for si in run}
    rest = [(cnt, err) for si, (cnt, err) in per_span.items() if si not in in_runs]
    rest_rate = sum(e for _c, e in rest) / max(1, sum(c for c, _e in rest))
    if runs and rest_rate < RELIABLE_ERROR_RATE:
        for run in runs:
            ks = [k for k in scope if span_of[k] in run and k not in excluded]
            gone = sum(1 for k in ks if k in verdict and verdict[k]["label"] in ("absent", "unchecked"))
            ms = [spans[si][0] for si in run]
            for k in ks:
                excluded[k] = "region"
            evidence.append({"kind": "region_mismatch", "measures": ms, "count": len(ks),
                             "zh": f"第 {_ranges(ms)} 小节：谱面 {len(ks)} 个音中 {gone} 个在录音里既没有转录到、频谱里也听不到，"
                                   f"而其余部分的错误率只有 {rest_rate * 100:.1f}%。更可能是这几小节谱面识别有误，此段不计分。",
                             "en": f"m{_ranges(ms)}: {gone} of {len(ks)} written notes are neither transcribed nor audible, while the "
                                   f"rest of the take has a {rest_rate * 100:.1f}% error rate. The score is more likely wrong here; "
                                   f"these measures are not scored."})
    # Written notes missing an octave away from where the take has an unexplained note, again and
    # again: an ottava sign or clef the score reader lost or invented.
    free = [x for x in extras if x["label"] != "absent"]
    octave = defaultdict(list)
    taken = set()
    for k in scope:
        v = verdict.get(k)
        if v is None or k in wrong or k in excluded or v["label"] == "heard":
            continue
        for d in (12, -12, 24, -24):
            x = next((x for x in free if id(x) not in taken and x["midi"] == notes[k]["pitchMidi"] + d
                      and abs(x["t"] - v["t"]) <= 0.15), None)
            if x is not None:
                taken.add(id(x))
                octave[d].append((k, x))
                break
    for d, pairs in [(d, run) for d, all_pairs in octave.items()
                     for run in _dense_runs(all_pairs, lambda kx: notes[kx[0]]["measure"])]:
        ms = sorted({notes[k]["measure"] for k, _x in pairs})
        for k, x in pairs:
            excluded[k] = "octave"
            x["scoreMissing"] = True
        up = d > 0
        evidence.append({"kind": "octave_shift", "measures": ms, "count": len(pairs),
                         "zh": f"第 {_ranges(ms)} 小节：谱面上的音比录音{'低' if up else '高'} {abs(d) // 12} 个八度（共 {len(pairs)} 次，"
                               f"如谱面 {midi_name(notes[pairs[0][0]]['pitchMidi'])}、录音 {midi_name(pairs[0][1]['midi'])}）。"
                               f"多半是谱面识别弄错了八度记号（8va）或谱号；这些音不计分。",
                         "en": f"m{_ranges(ms)}: written notes are {abs(d) // 12} octave(s) {'below' if up else 'above'} what was played "
                               f"({len(pairs)} times, e.g. written {midi_name(notes[pairs[0][0]]['pitchMidi'])}, played "
                               f"{midi_name(pairs[0][1]['midi'])}). The score likely lost an ottava sign or clef; not scored."})

    # The same key added to the written chords again and again: the score lost a chord tone.
    chord_times = np.array(sorted(float(np.median(v)) for v in gtime.values() if len(v) >= 2))
    added = defaultdict(list)
    for x in extras:
        if x["label"] != "absent" and len(chord_times) and np.min(np.abs(chord_times - x["t"])) <= 0.05:
            added[x["midi"]].append(x)
    for m, all_xs in added.items():
        for xs in _dense_runs([x for x in all_xs if measure_at(x["t"]) is not None], lambda x: measure_at(x["t"])):
            ms = sorted({measure_at(x["t"]) for x in xs})
            for x in xs:
                x["scoreMissing"] = True
            evidence.append({"kind": "missing_chord_tone", "measures": ms, "count": len(xs),
                             "zh": f"第 {_ranges(ms)} 小节：录音的和弦里反复多出 {midi_name(m)}（共 {len(xs)} 次），谱面上没有。"
                                   f"多半是谱面识别漏掉了这个和弦音；这些不算多音。",
                             "en": f"m{_ranges(ms)}: {midi_name(m)} is added to the written chords {len(xs)} times. The score "
                                   f"likely lost this chord tone; not counted as extra notes."})
    # Measures the score itself is doubtful about (its structure, or a second reading disagrees): their
    # disagreements count only as far as the score is trusted, and not at all above DOUBT_EXCLUDE.
    # Per disagreement, a second reading refines the measure's doubt: agreeing with the written key, the
    # player decides; siding with the take, the score is at fault.
    doubtful_hits, hit_reasons, note_d = defaultdict(int), set(), {}
    for k in scope:
        if k in excluded or k not in verdict or verdict[k]["label"] == "heard":
            continue
        m = notes[k]["measure"]
        played = int(pitch_arr[wrong[k]]) if k in wrong else None
        d, why = note_doubt(doubt_of(m), wit.get(m), "wrong" if k in wrong else "missed", notes[k]["pitchMidi"], played)
        note_d[k] = d
        if d >= DOUBT_EXCLUDE:
            excluded[k] = "score_doubtful"
            doubtful_hits[m] += 1
            hit_reasons.update(trust_map[m]["reasons"] if m in trust_map and why != "contradicted" else [])
            hit_reasons.update(["reading_sides_with_take"] if why == "contradicted" else [])
    for x in extras:
        m = measure_at(x["t"])
        if m is None or x.get("scoreMissing") or x["overtone"] or x["label"] == "absent":
            continue
        x["doubt"], why = note_doubt(doubt_of(m), wit.get(m), "extra", played=x["midi"])
        if x["doubt"] >= DOUBT_EXCLUDE:
            x["scoreDoubt"] = True
            doubtful_hits[m] += 1
            hit_reasons.update(trust_map[m]["reasons"] if m in trust_map and why != "contradicted" else [])
            hit_reasons.update(["reading_sides_with_take"] if why == "contradicted" else [])
    if doubtful_hits:
        ms = sorted(doubtful_hits)
        reasons = sorted(hit_reasons - {"reading_disagrees"}) or sorted(hit_reasons)
        hits = sum(doubtful_hits.values())
        evidence.append({"kind": "score_doubtful", "measures": ms, "count": hits, "reasons": reasons,
                         "zh": f"第 {_ranges(ms)} 小节：谱面本身有疑点（{'；'.join(SYMPTOM_TEXT[w][0] for w in reasons)}），"
                               f"这些小节里录音与谱面的 {hits} 处不一致不计为错误。",
                         "en": f"m{_ranges(ms)}: the score itself is doubtful here ({'; '.join(SYMPTOM_TEXT[w][1] for w in reasons)}); "
                               f"{hits} disagreements with the take are not counted as mistakes."})
    excluded_spans = {span_of[k] for k, why in excluded.items() if why == "region"}
    excluded_secs = [span_secs[si] for si in excluded_spans if si in span_secs]

    # Rhythm: measures whose written durations don't fill the bar, and an impossible tempo.
    scoped_measures = sorted({notes[k]["measure"] for k in scope})
    bad_len = [i for i in issues if i["measure"] in set(scoped_measures)]
    bad_len_measures = {i["measure"] for i in bad_len}
    rhythm_refused = False
    if bad_len:
        ex = bad_len[0]
        share = len(bad_len_measures) / max(1, len(scoped_measures))
        rhythm_refused = share > REFUSE_BAD_MEASURE_SHARE
        evidence.append({"kind": "measure_length", "measures": sorted(bad_len_measures),
                         "zh": f"第 {_ranges(bad_len_measures)} 小节的音符时值合计与拍号不符（如第 {ex['measure']} 小节为 "
                               f"{ex['beats']:g} 拍，拍号要求 {ex['expected']:g} 拍）"
                               + ("，占分析小节的 {:.0f}%，节奏不评分。".format(share * 100) if rhythm_refused else "；这些小节不计入节奏分。"),
                         "en": f"Written durations in m{_ranges(bad_len_measures)} don't fill the time signature (m{ex['measure']}: "
                               f"{ex['beats']:g} beats, expected {ex['expected']:g})"
                               + (f"; {share * 100:.0f}% of the measures, so rhythm is not scored." if rhythm_refused
                                  else "; these measures are not used for rhythm.")})
    if detected_bpm is not None and not TEMPO_QPM_RANGE[0] <= detected_bpm <= TEMPO_QPM_RANGE[1]:
        rhythm_refused = True
        q = hi_beat - lo_beat
        sec = float(smooth(hi_beat)) - float(smooth(lo_beat))
        evidence.append({"kind": "tempo_implausible", "measures": [],
                         "zh": f"按谱面时值，这段共 {q:.0f} 拍（四分音符），录音用了 {sec:.0f} 秒，相当于每分钟 {detected_bpm} 拍，"
                               f"超出钢琴演奏的合理范围（{TEMPO_QPM_RANGE[0]}–{TEMPO_QPM_RANGE[1]}）。多半是谱面时值（符杠、附点、拍号）"
                               f"识别错误，节奏不评分。",
                         "en": f"The written durations add up to {q:.0f} quarter beats played in {sec:.0f} s, i.e. {detected_bpm} per "
                               f"minute, outside a playable range ({TEMPO_QPM_RANGE[0]}–{TEMPO_QPM_RANGE[1]}). The score's rhythm "
                               f"(beams, dots, time signature) was likely misread; rhythm is not scored."})

    # --- Pitch: evidence-weighted note F1 over the notes the score can be trusted for.
    pitch_notes = [k for k in scope if k not in excluded]
    heard = [k for k in pitch_notes if k in verdict and verdict[k]["label"] == "heard"]
    found = sum(1 for k in pitch_notes if k in match) + len(heard)
    coverage = found / max(1, len(pitch_notes))
    excluded_share = len(excluded) / len(scope)
    pitch_refused = not pitch_notes or excluded_share > REFUSE_EXCLUDED_SHARE or coverage < MIN_COVERAGE
    if pitch_notes and coverage < MIN_COVERAGE:
        rhythm_refused = True
        evidence.append({"kind": "low_coverage", "measures": [],
                         "zh": f"谱面 {len(pitch_notes)} 个音中只有 {found} 个在录音里找到（{coverage * 100:.0f}%）。"
                               f"请确认谱面与录音是同一首、起始小节正确；本次不评分。",
                         "en": f"Only {found} of {len(pitch_notes)} written notes were found in the take ({coverage * 100:.0f}%). "
                               f"Check that score and take are the same piece and the start measure is right; not scored."})
    elif excluded_share > REFUSE_EXCLUDED_SHARE:
        evidence.append({"kind": "too_many_excluded", "measures": [],
                         "zh": f"谱面可疑之处涉及 {len(excluded)}/{len(scope)} 个音（{excluded_share * 100:.0f}%），"
                               f"超过 {REFUSE_EXCLUDED_SHARE * 100:.0f}%，音高不评分。请先修正谱面。",
                         "en": f"Doubtful score passages cover {len(excluded)}/{len(scope)} notes ({excluded_share * 100:.0f}%), "
                               f"over {REFUSE_EXCLUDED_SHARE * 100:.0f}%; pitch is not scored. Fix the score first."})

    def in_excluded_time(t):
        return any(a <= t < b for a, b in excluded_secs)

    counted_extras = [x for x in extras if not in_excluded_time(x["t"]) and not x.get("scoreMissing")
                      and not x.get("scoreDoubt") and not x["overtone"]]
    n_notes = len(pitch_notes)
    # A disagreement is the player's mistake only as far as the score is trusted in its measure.
    trusted = lambda k: 1.0 - note_d.get(k, doubt_of(notes[k]["measure"]))
    err_missed = sum(verdict[k]["weight"] * trusted(k) for k in pitch_notes if k in verdict and k not in wrong)
    err_wrong = sum(verdict[k]["weight"] * trusted(k) for k in pitch_notes if k in wrong)
    err_extra = sum(x["weight"] * (1.0 - x.get("doubt", 0.0)) for x in counted_extras)
    good = n_notes - err_missed - err_wrong
    performed_w = good + err_wrong + err_extra
    pitch_score = None if pitch_refused else round(200 * good / max(1e-9, n_notes + performed_w))

    # --- Per-note report.
    aligned, residuals = [], []
    first_group_beat = notes[scope[0]]["onsetBeat"]
    for idx, k in enumerate(scope):
        n = notes[k]
        expected = float(smooth(n["onsetBeat"]))
        base = {**n, "id": f"n{idx + 1}", "expectedSec": round(expected, 3)}
        v = verdict.get(k)
        audio = {"audioCheck": {"result": v["label"], "p": None if v["p"] is None else round(v["p"], 2)}} if v else {}
        if k in excluded:
            aligned.append({**base, **audio, "performedSec": None, "pitchErrorCents": None, "timingErrorMs": None,
                            "confidence": 0.0, "pitchStatus": "uncertain", "timingStatus": "uncertain",
                            "matchStatus": "uncertain", "status": "excluded", "excludedReason": excluded[k],
                            **({"playedMidi": int(pitch_arr[wrong[k]])} if k in wrong else {})})
        elif k in match or (k in wrong and v["label"] != "unclear"):
            j = match.get(k, wrong.get(k))
            onset, _off, _pitch, vel = perf[j]
            played = int(pitch_arr[j])
            cents = (played - n["pitchMidi"]) * 100
            first = abs(n["onsetBeat"] - first_group_beat) < 1e-6
            delta = round((onset - expected) * 1000)
            spb = smooth.sec_per_beat(n["onsetBeat"])
            thr = min(120, max(50, 150 * spb))
            no_rhythm = first or n["measure"] in bad_len_measures
            timing = "unscored" if no_rhythm else "late" if delta > thr else "early" if delta < -thr else "correct"
            if not no_rhythm and k in match:
                residuals.append(delta)
            pitch_status = "correct" if k in match else ("sharp" if cents > 0 else "flat")
            status = "wrong_pitch" if k in wrong else (timing if timing in ("late", "early") else "correct")
            aligned.append({**base, **audio, "performedSec": round(onset, 3), "playedMidi": played,
                            "pitchErrorCents": cents, "timingErrorMs": None if no_rhythm else delta,
                            "confidence": round(min(1.0, vel / 127.0), 2), "pitchStatus": pitch_status,
                            "timingStatus": timing, "matchStatus": "matched", "status": status})
        elif v["label"] == "heard":
            aligned.append({**base, **audio, "performedSec": None, "playedMidi": n["pitchMidi"], "pitchErrorCents": 0,
                            "timingErrorMs": None, "confidence": round(v["p"], 2), "pitchStatus": "correct",
                            "timingStatus": "uncertain", "matchStatus": "audio", "status": "correct"})
        elif v["label"] == "unclear":
            aligned.append({**base, **audio, "performedSec": None, "pitchErrorCents": None, "timingErrorMs": None,
                            "confidence": 0.0, "pitchStatus": "uncertain", "timingStatus": "uncertain",
                            "matchStatus": "uncertain", "status": "uncertain",
                            **({"playedMidi": int(pitch_arr[wrong[k]])} if k in wrong else {})})
        else:
            aligned.append({**base, **audio, "performedSec": None, "pitchErrorCents": None, "timingErrorMs": None,
                            "confidence": 0.0, "pitchStatus": "uncertain", "timingStatus": "uncertain",
                            "matchStatus": "missed", "status": "missed"})

    counted = [k for k in pitch_notes if k not in verdict or verdict[k]["label"] != "unclear"]
    correct = sum(1 for k in pitch_notes if k in match) + len(heard)
    wrong_n = sum(1 for k in counted if k in wrong)
    missed = sum(1 for k in counted if k in verdict and k not in wrong and verdict[k]["label"] != "heard")
    uncertain = len(pitch_notes) - len(counted) + sum(1 for x in counted_extras if x["label"] == "unclear")
    extra = sum(1 for x in counted_extras if x["label"] in ("heard", "unchecked"))
    ghosts = sum(1 for x in counted_extras if x["label"] == "absent")

    rhythm_score = timing_accuracy = stability = spread = offset = None
    if not rhythm_refused and len(residuals) >= 3 and len(residuals) / max(1, len(scope) - 1) >= .5:
        arr = np.array(residuals, dtype=float)
        offset = round(float(np.median(arr)))
        spread = round(float(np.median(np.abs(arr - offset))))
        stability = round(max(0, 100 - spread * .55))
        timing_accuracy = round(max(0, 100 - float(np.median(np.abs(arr))) * .4))
        rhythm_score = round(max(0, 100 - spread * .45 - abs(offset) * .3))

    # Chord evenness and hand coordination, from groups with two or more matched notes.
    groups = defaultdict(list)
    for k in scope:
        if k in match and k not in excluded:
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

    # --- Tuning of the instrument: reported on its own, never part of the pitch score.
    tun = measure_tuning(spectra, [(notes[k]["pitchMidi"], perf[match[k]][0], perf[match[k]][1])
                                   for k in scope if k in match and k not in excluded])
    total = ref_cents + (tun["offsetCents"] if tun else 0.0)
    tuning = {"offsetCents": round(total, 1), "referenceHz": round(440 * 2 ** (total / 1200), 1),
              "stretchCentsPerOctave": None, "spreadCents": None, "measuredKeys": 0, "outOfTuneKeys": [],
              "tuningScore": None, **({k: v for k, v in tun.items() if k != "offsetCents"} if tun else {}),
              "retunedForTranscription": retuned, "semitoneShift": -shift}

    def status_of(refused, partial):
        return "refused" if refused else "partial" if partial else "ok"

    scoped_set = set(scoped_measures)
    score_check = {"pitch": status_of(pitch_refused, bool(excluded)),
                   "rhythm": status_of(rhythm_refused, bool(bad_len_measures)),
                   "excludedNotes": len(excluded), "evidence": evidence,
                   "secondReading": bool(second_xml) and trust,
                   "doubtfulMeasures": sorted(m for m in trust_map if m in scoped_set and doubt_of(m) >= DOUBT_EXCLUDE),
                   "scoredShare": round(1 - len(excluded) / len(scope), 3)}
    measure_count = max((n["measure"] for n in notes), default=0)  # OMR may append empty measures
    voiced = correct + wrong_n
    return {"version": VERSION, "instrument": "piano", "bpm": bpm, "mode": "note-aligned-polyphonic",
            "summary": {"pitchScore": pitch_score, "intonationScore": None,
                        "correctPitchNotes": correct, "wrongPitchNotes": wrong_n,
                        "missedNotes": missed, "extraNotes": extra, "performedNoteCount": correct + wrong_n + extra,
                        "uncertainNotes": uncertain, "audioRescuedNotes": len(heard), "ghostExtras": ghosts,
                        "pitchScoreMethod": "evidence-f1",
                        "truncatedByAudioEnd": scope[-1] < len(notes) - 1,
                        "rhythmScore": rhythm_score, "timingAccuracyScore": timing_accuracy,
                        "rhythmStabilityScore": stability, "timingOffsetMs": offset,
                        "timingSpreadMs": spread,
                        "measureCount": measure_count,
                        "startMeasure": notes[scope[0]]["measure"],
                        "endMeasure": notes[scope[-1]]["measure"],
                        "noteCount": len(scope), "voicedNotes": voiced,
                        "timedNotes": len(residuals),
                        "confidence": "medium" if coverage >= .8 else "low",
                        "syncMode": "piano-align", "recordedFirstBeatSec": None,
                        "estimatedLatencyMs": None, "coveredSec": round(audio_sec, 3),
                        "sensors": ["piano-transcribe"] + (["spectrum-check"] if model and model.models else []),
                        "audioCheck": {"available": bool(model and model.models), "auc": model.auc if model else {}},
                        "detectedBpm": detected_bpm, "tempoVariationPct": tempo_var,
                        "autoLocated": auto, "repeatsUnfolded": unfold and has_repeats(xml),
                        "chordCount": len(chord_spreads),
                        "chordSpreadMs": round(float(np.median(chord_spreads))) if chord_spreads else None,
                        "unevenChords": sum(s > CHORD_UNEVEN_MS for s in chord_spreads),
                        "unevenChordMeasures": [m for m, _c in uneven_measures.most_common(8)],
                        "handOffsetMs": round(float(np.median(hand_offsets))) if len(hand_offsets) >= 3 else None,
                        "scoreSuspects": score_suspects, "scoreCheck": score_check, "tuning": tuning,
                        "voiceFixes": voice_fixes},
            "measureIntervals": intervals,
            "notes": aligned,
            # Unused performed notes: counted ones are extra keys; the rest are explained (transcriber
            # ghosts the audio doesn't support, or keys the score lost).
            "extras": [{"sec": round(x["t"], 3), "midi": x["midi"], "measure": measure_at(x["t"]),
                        "counted": x in counted_extras and x["label"] != "absent",
                        "reason": "score_missing" if x.get("scoreMissing") else "excluded_measure" if in_excluded_time(x["t"])
                        else "ghost" if x["label"] == "absent" else "overtone" if x["overtone"]
                        else "score_doubtful" if x.get("scoreDoubt") else None,
                        "audioCheck": {"result": x["label"], "p": None if x["p"] is None else round(x["p"], 2)}}
                       for x in extras][:300],
            "limitations": ["仅支持独奏钢琴。音高分为按证据加权的音符 F1：转录与谱面不一致时回到频谱核实，"
                            "确认没弹的才算错，拿不准的按概率计，确认弹了的不扣分。",
                            "钢琴整体音高（如 A=442 或 A=415）不影响音高分；调律情况单独报告。",
                            "按录音自身的速度对齐，渐快渐慢不算错；节奏分只看相对于局部速度的不均匀。",
                            "谱面可疑（系统性错音、整段对不上、时值与拍号不符）时相应部分不计分，问题过多时拒绝评分并给出证据。"]}
