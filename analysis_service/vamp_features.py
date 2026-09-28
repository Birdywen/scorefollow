"""Optional Vamp-plugin sensors: pYIN pitch notes + QM onset hints.

No hard dependency: without the `vamp` package or plugin .so files every
function returns None and the engine falls back to its builtin detectors.
Plugin build recipe lives in VAMP_SETUP.md next to this file.
"""

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
    except Exception:
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
    except Exception:
        return None


def extract_all(wav: bytes) -> tuple:
    """Best-effort (pitch_notes, onsets); each None independently on failure."""
    return extract_pitch_notes(wav), extract_onsets(wav)
