"""Research harness: A/B QM plugin sensors vs builtin detectors.

Not imported by the engine. Run from repo root:
  python3 -B -m analysis_service.vamp_lab <mp3-or-wav-path> [--truth beats.json]

Outputs one JSON per audio file to stdout with, for each sensor:
  onsets      : builtin (energy/pitch-track) vs qm-onsetdetector(sens 10/20/30)
  tempo       : builtin grid bpm vs qm-tempotracker median beat interval
  beats       : qm-barbeattracker vs qm-tempotracker agreement (median abs diff)
Truth (--truth): {"onsets": [sec...]} optional; reports recall/precision at +/-50ms.
"""
import argparse
import json
import os
import statistics
import sys

os.environ.setdefault("VAMP_PATH", os.path.expanduser("~/.vamp"))

MERGE_GAP = 0.15


def _collect(signal, rate, key, output, params=None):
    import vamp
    out = vamp.collect(signal, rate, key, output=output, parameters=params or {})
    return out["list"]


def merged(times):
    out = []
    for t in sorted(float(x) for x in times):
        if out and t - out[-1] < MERGE_GAP:
            continue
        out.append(t)
    return out


def builtin_onsets(path):
    from analysis_service.engine import track, detect_builtin_onsets
    signal, rate = decode(path)
    times, pitches, energy, conf = track(signal, rate)
    return detect_builtin_onsets(times, pitches, energy, None)


def decode(path):
    import numpy as np
    import subprocess
    if path.lower().endswith(".wav"):
        from analysis_service.engine import read_wav
        return read_wav(open(path, "rb").read())
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path,
                          "-ac", "1", "-ar", "22050", "-f", "s16le", "pipe:1"],
                         capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0, 22050


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--truth")
    args = ap.parse_args()
    import numpy as np
    signal, rate = decode(args.audio)
    sig = np.ascontiguousarray(signal, dtype=np.float32)

    report = {"file": args.audio, "rate": rate, "durationSec": round(len(signal) / rate, 2)}

    b_onsets = builtin_onsets(args.audio)
    report["builtinOnsets"] = {"count": len(b_onsets), "first3": [round(t, 3) for t in b_onsets[:3]]}

    for sens in (10, 20, 30):
        try:
            evs = _collect(sig, rate, "qm-vamp-plugins:qm-onsetdetector", "onsets",
                           {"sensitivity": float(sens)})
            m = merged([e["timestamp"] for e in evs])
            report[f"qmOnsets{sens}"] = {"count": len(m), "first3": [round(t, 3) for t in m[:3]]}
        except Exception as exc:
            report[f"qmOnsets{sens}"] = {"error": str(exc)}

    if args.truth:
        truth = json.load(open(args.truth)).get("onsets", [])
        tol = 0.05
        names = ["builtinOnsets"] + [f"qmOnsets{s}" for s in (10, 20, 30)]
        for name in names:
            got = report[name].get("all") or []
            hits = sum(1 for x in truth if any(abs(x - y) <= tol for y in got))
            fp = sum(1 for y in got if not any(abs(x - y) <= tol for x in truth))
            report[name + "VsTruth"] = {
                "recall": round(hits / len(truth), 3) if truth else None,
                "falsePositives": fp}

    # tempo sensors
    for key, out, label in [
        ("qm-vamp-plugins:qm-tempotracker", "beats", "tempoBeats"),
        ("qm-vamp-plugins:qm-tempotracker", "tempo", "tempoDirect"),
        ("qm-vamp-plugins:qm-barbeattracker", "beats", "barBeatBeats"),
    ]:
        try:
            evs = _collect(sig, rate, key, out)
            if out == "tempo":
                vals = [float(np.asarray(e["values"], dtype=float)[0]) for e in evs]
                report[label] = {"bpm": round(statistics.median(vals), 1) if vals else None, "frames": len(vals)}
            else:
                ts = sorted(float(e["timestamp"]) for e in evs)
                ivs = [b - a for a, b in zip(ts, ts[1:]) if 0.15 < b - a < 2.0]
                med = statistics.median(ivs) if ivs else None
                report[label] = {"beats": len(ts), "medianInterval": round(med, 4) if med else None,
                                 "bpm": round(60 / med, 1) if med else None}
        except Exception as exc:
            report[label] = {"error": str(exc)}

    tb = report.get("tempoBeats", {}).get("medianInterval")
    bb = report.get("barBeatBeats", {}).get("medianInterval")
    if tb and bb:
        report["beatAgreement"] = {"medianAbsDiffSec": round(abs(tb - bb), 4),
                                   "ratio": round(tb / bb, 3)}

    print(json.dumps(report, ensure_ascii=False, indent=1))
    print("VLAB_OK", file=sys.stderr)


if __name__ == "__main__":
    main()
