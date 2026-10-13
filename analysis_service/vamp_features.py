"""Optional Vamp-plugin sensors: pYIN pitch notes + QM onset hints.

No hard dependency: without the `vamp` package or plugin .so files every
function returns None and the engine falls back to its builtin detectors.
Plugin build recipe lives in VAMP_SETUP.md next to this file.
"""

import logging
import os

os.environ.setdefault("VAMP_PATH", os.path.expanduser("~/.vamp"))

MERGE_GAP = 0.15


def _load(signal, rate):
    import numpy as np

    return np.ascontiguousarray(signal, dtype=np.float32)


def extract_pitch_notes(wav: bytes) -> list | None:
    """pYIN note track -> [(start_sec, end_sec, midi)]. None when unavailable."""
    try:
        import numpy as np
        import vamp
        from .engine import read_wav
        signal, rate = read_wav(wav)
        out = vamp.collect(_load(signal, rate), rate, "pyin:pyin", output="notes")
        notes = []
        for seg in out["list"]:
            hz = float(np.asarray(seg["values"], dtype=float).flat[0])
            if hz <= 0:
                continue
            t = float(seg["timestamp"])
            notes.append((t, t + float(seg["duration"]), 69 + 12 * np.log2(hz / 440.0)))
        return notes or None
    except Exception as e:
        logging.warning(f"extract_pitch_notes 降级 (builtin): {e}")
        return None


def extract_onsets(wav: bytes, sensitivity: int = 20) -> list | None:
    """QM spectral-difference onsets, merged within MERGE_GAP, release tail kept
    only if it lands past the last pitched region (handled by caller length check).
    None when unavailable."""
    try:
        import vamp
        from .engine import read_wav
        signal, rate = read_wav(wav)
        out = vamp.collect(_load(signal, rate), rate,
                           "qm-vamp-plugins:qm-onsetdetector",
                           output="onsets", parameters={"sensitivity": sensitivity})
        raw = sorted(float(e["timestamp"]) for e in out["list"])
        merged: list[float] = []
        for t in raw:
            if merged and t - merged[-1] < MERGE_GAP:
                continue
            merged.append(t)
        return merged or None
    except Exception as e:
        logging.warning(f"extract_onsets 降级 (builtin): {e}")
        return None


def extract_beats(wav: bytes) -> list | None:
    """QM BarBeatTracker 拍点时间轴（秒）。标签相位不可信，只取时间戳；
    不足 4 个拍点视为无效。None = 不可用。"""
    try:
        import vamp
        from .engine import read_wav
        signal, rate = read_wav(wav)
        out = vamp.collect(_load(signal, rate), rate,
                           "qm-vamp-plugins:qm-barbeattracker", output="beats")
        beats = sorted(float(e["timestamp"]) for e in out["list"])
        return beats if len(beats) >= 4 else None
    except Exception as e:
        logging.warning(f"extract_beats 降级 (legacy): {e}")
        return None


def extract_all(wav: bytes) -> tuple:
    """Best-effort (pitch_notes, onsets, beats); 各自独立失败即 None。"""
    return extract_pitch_notes(wav), extract_onsets(wav), extract_beats(wav)


FUSED_ONSET_SENSITIVITY = 20
FUSED_MAX_SEGMENT = 0.6
_FUSED_CACHE: dict = {}


def extract_fused_events(signal, rate, sensitivity: int = FUSED_ONSET_SENSITIVITY) -> list | None:
    """QM onsets segment + pYIN smoothed pitch track (median per segment) ->
    [(start_sec, end_sec, midi)]. Recovers fast passages that pYIN's note
    tracker merges; adjacent segments within half a semitone are merged
    (re-bow / vibrato splits). None when unavailable."""
    try:
        import hashlib
        import numpy as np
        import vamp
        x = _load(signal, rate)
        key = (hashlib.blake2b(x.tobytes(), digest_size=16).digest(), int(rate), int(sensitivity))
        if key in _FUSED_CACHE:
            return _FUSED_CACHE[key]
        step, track = vamp.collect(x, rate, "pyin:pyin", output="smoothedpitchtrack",
                                   parameters={"outputunvoiced": 2})["vector"]
        step = float(step.to_float() if hasattr(step, "to_float") else step)
        f = np.asarray(track, dtype=float)
        duration = len(x) / rate
        # outputunvoiced=2 keeps every frame (unvoiced <= 0): index * step is time.
        if step <= 0 or abs(len(f) * step - duration) > 0.05 * duration + 0.1:
            raise ValueError("pitch track frames misaligned")
        t = np.arange(len(f)) * step
        res = vamp.collect(x, rate, "qm-vamp-plugins:qm-onsetdetector", output="onsets",
                           parameters={"sensitivity": sensitivity})
        onsets = sorted(float(o["timestamp"]) for o in res["list"])
        events = []
        bounds = onsets + [duration]
        for a, b in zip(bounds, bounds[1:]):
            b = min(b, a + FUSED_MAX_SEGMENT)
            mask = (t >= a + 0.01) & (t < b) & (f > 0)
            if mask.sum() < 3:
                continue
            midi = float(np.median(69 + 12 * np.log2(f[mask] / 440.0)))
            if events and abs(events[-1][2] - midi) < 0.5 and a - events[-1][1] < 0.05:
                events[-1] = (events[-1][0], b, events[-1][2])
                continue
            events.append((a, b, midi))
        out = events or None
        if len(_FUSED_CACHE) >= 4:
            _FUSED_CACHE.clear()
        _FUSED_CACHE[key] = out
        return out
    except Exception as e:
        logging.warning(f"extract_fused_events 降级: {e}")
        return None


def degradation_reasons(pitch_notes=None, onset_hint=None, beat_map=None,
                        beat_requested: bool = True, beat_rejected: bool = False) -> list:
    """Explicit optional-plugin degradation, derived from live detector outputs.

    Each sensor is independent: None/empty means that detector is unavailable
    and the engine falls back (builtin pitch/onset, legacy tempo grid).
    Callers pass the *effective* sensor values (after engine guards such as
    the single-note pitch guard); never hardcode True. Empty list = no
    degradation (vamp available and used).
    """
    reasons: list[str] = []
    if not pitch_notes:
        reasons.append("pitch:builtin")
    if not onset_hint:
        reasons.append("onset:builtin")
    # A beat grid is only a requirement when the caller asked for beat
    # following (vamp-beat). Legacy and manual timelines never consume it,
    # so its absence there is not a fallback and must not warn the user.
    if beat_requested and not beat_map:
        # beat:rejected = tracker ran but its grid lost the pitch-evidence vote;
        # beat:legacy = no usable grid at all.
        reasons.append("beat:rejected" if beat_rejected else "beat:legacy")
    return reasons


def is_degraded(pitch_notes=None, onset_hint=None, beat_map=None) -> bool:
    """True when any optional detector fell back; see degradation_reasons."""
    return bool(degradation_reasons(pitch_notes, onset_hint, beat_map))
