"""Offline CREPE audit over the Dotzauer score-corpus (research, not request path).

For each scored clip: rebuild the fixed 42s/18s probe wav, run one full-track
TorchCREPE inference, and join per-note medians against the recorded pYIN
pitchErrorCents. Writes datasets/dotzauer-op113/results/crepe-audit/
({clip}.json with track + notes, summary.json). Prints CREPE_AUDIT_OK.

Window approximation (engine's exact pYIN window is not persisted):
[anchor, expectedEnd] trimmed 25% head / 20% tail, anchor = performedSec
when present else expectedSec; needs >= 4 voiced (periodicity>=0.5) frames.
Usage: python3 -B scripts/crepe-audit-corpus.py [--start I --end J] [--list]
"""
import argparse
import importlib.util
import io
import json
import os
import sys
import time
import wave

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
os.environ.setdefault("SCOREFOLLOW_CREPE_PYTHON",
                      "/home/ubuntu/.local/share/scorefollow/crepevenv/bin/python3")

import numpy as np

from analysis_service.engine import _crepe_track

_spec = importlib.util.spec_from_file_location(
    "dotzauer_corpus", os.path.join(REPO, "scripts", "dotzauer-corpus.py"))
C = importlib.util.module_from_spec(_spec)
sys.modules["dotzauer_corpus"] = C
_spec.loader.exec_module(C)

OUT = C.DATA / "results" / "crepe-audit"


def decode_wav(raw: bytes):
    with wave.open(io.BytesIO(raw), "rb") as handle:
        assert handle.getnchannels() == 1 and handle.getsampwidth() == 2
        rate = handle.getframerate()
        pcm = (np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")
               .astype(np.float32) / 32767.0)
    return pcm, rate


def audit_clip(clip_id):
    record = json.loads((C.DATA / "results" / "score-corpus" / (clip_id + ".json")).read_text())
    assert record["status"] == "scored", record["status"]
    params = record["params"]
    clip = next(c for c in C.manifest()["clips"] if c["id"] == clip_id)
    pcm = C.pcm_for(C.audio_path(clip), start=params["start_sec"], duration=params["duration_sec"])
    signal, rate = decode_wav(C.wav_for(pcm))
    t0 = time.time()
    track = _crepe_track(signal, rate)
    infer_sec = round(time.time() - t0, 1)
    if track is None:
        return {"id": clip_id, "status": "crepe-failed", "infer_sec": infer_sec}
    times, midi, voicing = track
    notes = []
    for note in record["result"]["notes"]:
        anchor = note["performedSec"] if note["performedSec"] is not None else note["expectedSec"]
        lo = anchor + (note["expectedEndSec"] - anchor) * 0.25
        hi = note["expectedEndSec"] - (note["expectedEndSec"] - anchor) * 0.20
        sel = ((times >= lo) & (times <= hi) & np.isfinite(midi)
               & (voicing >= 0.5))
        entry = {"id": note.get("id"), "pitchMidi": note["pitchMidi"],
                 "pyinCents": note["pitchErrorCents"], "crepeCents": None,
                 "agreeAbs": None, "voicedFrames": int(np.count_nonzero(sel))}
        if entry["voicedFrames"] >= 4:
            entry["crepeCents"] = round(
                (float(np.median(midi[sel])) - note["pitchMidi"]) * 100, 1)
            if note["pitchErrorCents"] is not None:
                entry["agreeAbs"] = round(abs(entry["crepeCents"] - note["pitchErrorCents"]), 1)
        notes.append(entry)
    both = [n["agreeAbs"] for n in notes if n["agreeAbs"] is not None]
    return {"id": clip_id, "status": "audited", "infer_sec": infer_sec,
            "n_notes": len(notes), "n_both": len(both),
            "agree_med": round(float(np.median(both)), 1) if both else None,
            "track": {"times_s": [round(float(v), 4) for v in times],
                      "midi": [round(float(v), 3) for v in midi],
                      "voicing": [round(float(v), 3) for v in voicing]},
            "notes": notes}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int, default=None)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--skip-existing", action="store_true",
                        help="skip clips that already have an audited result file")
    args = parser.parse_args()
    summary = json.loads((C.DATA / "results" / "score-corpus-summary.json").read_text())
    scored = sorted(r["id"] for r in summary["records"] if r["status"] == "scored")
    if args.list:
        print(json.dumps(scored, indent=1))
        return
    OUT.mkdir(parents=True, exist_ok=True)
    todo = scored[args.start:args.end]
    if args.skip_existing:
        todo = [c for c in todo
                if not ((OUT / (c + ".json")).exists()
                        and json.loads((OUT / (c + ".json")).read_text()).get("status") == "audited")]
    for clip_id in todo:
        try:
            result = audit_clip(clip_id)
        except Exception as exc:
            result = {"id": clip_id, "status": "failed",
                      "error_type": type(exc).__name__, "reason": str(exc)[:200]}
        (OUT / (clip_id + ".json")).write_text(json.dumps(result))
        print("AUDIT_CLIP", clip_id, result["status"],
              result.get("agree_med"), result.get("infer_sec"), flush=True)
    print("CREPE_AUDIT_OK", f"{len(todo)} clips")


if __name__ == "__main__":
    main()
