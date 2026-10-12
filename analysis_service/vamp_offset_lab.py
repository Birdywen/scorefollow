"""Research: global-offset fit of candidate beat grids against audio events.

Not imported by the engine. For each (plugin, params) grid, compute the best
constant shift that aligns beats to pYIN note starts (and builtin onsets),
reporting residual MAD as the cursor-lag proxy. Lower MAD = tighter grid.

Usage:
  python3 -B -m analysis_service.vamp_offset_lab <mp3-or-wav> [--xml score.musicxml]
"""
import argparse
import json
import os
import statistics
import sys

os.environ.setdefault("VAMP_PATH", os.path.expanduser("~/.vamp"))

DTYPES = {0: "hfc", 1: "rcomplex", 2: "specdiff", 3: "energy", 4: "mfcc"}


def collect(signal, rate, key, output, params=None):
    import vamp
    out = vamp.collect(signal, rate, key, output=output, parameters=params or {})
    return sorted(float(e["timestamp"]) for e in out["list"])


def best_offset(beats, events, med):
    """Constant shift minimizing mean |dist|; dist = min abs diff to nearest beat+off."""
    import numpy as np
    b = np.asarray(beats)
    e = np.asarray(events)
    if len(b) < 4 or len(e) == 0:
        return None, None
    cand = []
    for k in range(-8, 9):
        off = k * med / 16.0
        d = np.abs((e[:, None] - (b + off)[None, :])).min(axis=1)
        cand.append((float(d.mean()), off))
    mad, off = min(cand)
    # refine +-med/16 at med/64 steps
    for k in range(-16, 17):
        o = off + k * med / 64.0
        d = np.abs((e[:, None] - (b + o)[None, :])).min(axis=1)
        m = float(d.mean())
        if m < mad:
            mad, off = m, o
    frac = [d for d in np.abs((e[:, None] - (b + off)[None, :])).min(axis=1)]
    within50 = sum(1 for d in frac if d <= 0.05) / len(frac)
    return round(mad * 1000, 1), {"offsetSec": round(off, 4), "within50ms": round(within50, 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    args = ap.parse_args()
    import numpy as np
    from analysis_service.vamp_lab import decode
    signal, rate = decode(args.audio)
    sig = np.ascontiguousarray(signal, dtype=np.float32)
    report = {"file": args.audio, "durationSec": round(len(signal) / rate, 2)}

    # ground-ish events: pYIN note starts (production sensor) + builtin onsets
    pyin_notes = collect(sig, rate, "pyin:pyin", "notes")
    from analysis_service.engine import track, detect_builtin_onsets
    times, pitches, energy, conf = track(signal, rate)
    builtin = detect_builtin_onsets(times, pitches, energy, None)
    report["events"] = {"pyinStarts": len(pyin_notes), "builtinOnsets": len(builtin)}

    def interval(ts):
        ivs = [b - a for a, b in zip(ts, ts[1:]) if 0.15 < b - a < 2.0]
        return statistics.median(ivs) if ivs else None

    grids = {}
    for dt in (0, 2, 3):
        for sens in (30, 50, 70):
            ts = collect(sig, rate, "qm-vamp-plugins:qm-onsetdetector", "onsets",
                         {"dftype": float(dt), "sensitivity": float(sens)})
            grids[f"onset_{DTYPES[dt]}_s{sens}"] = ts
    for method in (0, 1):
        for whiten in (0, 1):
            ts = collect(sig, rate, "qm-vamp-plugins:qm-tempotracker", "beats",
                         {"method": float(method), "whiten": float(whiten)})
            grids[f"tempo_m{method}_w{whiten}"] = ts
    for bpb in (4, 3):
        ts = collect(sig, rate, "qm-vamp-plugins:qm-barbeattracker", "beats", {"bpb": float(bpb)})
        grids[f"barbeat_b{bpb}"] = ts

    rows = []
    for name, ts in grids.items():
        med = interval(ts)
        if not med:
            continue
        for evname, ev in (("pyin", pyin_notes), ("builtin", builtin)):
            mad, extra = best_offset(ts, ev, med)
            if mad is None:
                continue
            rows.append({"grid": name, "events": evname, "beats": len(ts),
                         "medInterval": round(med, 4), "bpm": round(60 / med, 1),
                         "lagMADms": mad, **extra})
    rows.sort(key=lambda r: (r["events"], r["lagMADms"]))
    report["grids"] = rows
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print("OFFSET_LAB_OK", file=sys.stderr)


if __name__ == "__main__":
    main()
