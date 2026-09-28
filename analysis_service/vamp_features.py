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
