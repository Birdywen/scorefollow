"""Piano alignment benchmark on Heller Op.47 (real recordings, OMR scores, cached transcriptions).

Usage: python3 -m benchmarks.piano_heller [--data DIR] [--only 1,2] [--inject] [--excerpt]
  clean    : recall (score notes matched) / precision (performed notes used) per etude
  --inject : synthetic mistakes on the real take -> detection recall/precision of missed/wrong/extra
  --excerpt: 20 s window from the middle with unknown start -> located beat error
Data: DIR/musicxml/Heller_Op47_NoNN.musicxml, DIR/transcribed/NoNN.json (see Piano train/tools).
"""
import argparse, json, os, random, sys, time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from analysis_service.piano_align import align  # noqa: E402
from analysis_service.piano_score import has_repeats, parse_piano_score  # noqa: E402

DATA = "/home/ubuntu/n/Piano train/heller-op47"


def load(data, n):
    xml = open(f"{data}/musicxml/Heller_Op47_No{n:02d}.musicxml", encoding="utf-8").read()
    perf = [tuple(e) for e in json.load(open(f"{data}/transcribed/No{n:02d}.json"))]
    return xml, sorted(perf)


def run_clean(xml, perf):
    """Align; with repeats, try unfolded and as-printed and keep the better recall."""
    best = None
    for unfold in ([True, False] if has_repeats(xml) else [True]):
        notes = parse_piano_score(xml, unfold=unfold)
        r = align(notes, perf, free_score_start=False)
        rec = (len(r["match"]) + len(r["wrong"])) / len(notes)
        if best is None or rec > best[0]:
            best = (rec, notes, r, unfold)
    return best[1:]


def stats(notes, perf, r):
    lo, hi = r["window_sec"]
    in_win = sum(lo <= p[0] <= hi for p in perf)
    m, w = len(r["match"]), len(r["wrong"])
    bpm = 60 / np.median(np.diff(r["tempo"].secs) / np.diff(r["tempo"].beats))
    in_win = int(in_win)
    return {"notes": len(notes), "matched": m, "wrong": w, "missed": len(notes) - m - w,
            "recall": round(m / len(notes), 3), "precision": round(m / max(1, in_win), 3),
            "extra": in_win - m - w, "anchors": len(r["tempo"].beats), "qbpm": round(float(bpm))}


def inject(perf, match, rng):
    """Delete 4% / re-pitch 4% of matched performed notes, insert 3% extras. Returns new perf + truth."""
    matched = sorted(match.items())
    rng.shuffle(matched)
    k = max(1, int(0.04 * len(matched)))
    deleted = {p for _s, p in matched[:k]}
    repitched = {p: rng.choice([-2, -1, 1, 2]) for _s, p in matched[k:2 * k]}
    s_of = {p: s for s, p in match.items()}
    out, truth = [], {"missed": {s_of[p] for p in deleted}, "wrong": {s_of[p]: d for p, d in repitched.items()}}
    for i, (on, off, pitch, vel) in enumerate(perf):
        if i in deleted:
            continue
        out.append((on, off, pitch + repitched.get(i, 0), vel))
    t0, t1 = perf[0][0], perf[-1][0]
    n_extra = max(1, int(0.03 * len(matched)))
    for _ in range(n_extra):
        out.append((rng.uniform(t0, t1), 0, float(rng.randint(40, 84)), 60.0))
    truth["extra"] = n_extra
    return sorted(out), truth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--only")
    ap.add_argument("--inject", action="store_true")
    ap.add_argument("--excerpt", action="store_true")
    a = ap.parse_args()
    ids = [int(x) for x in a.only.split(",")] if a.only else list(range(1, 25))
    tot = {"notes": 0, "matched": 0, "wrong": 0, "used": 0, "in": 0}
    inj = {"miss_tp": 0, "miss_n": 0, "miss_fp": 0, "wrong_tp": 0, "wrong_pitch_ok": 0, "wrong_n": 0, "wrong_fp": 0}
    exc = []
    for n in ids:
        xml, perf = load(a.data, n)
        t = time.time()
        notes, r, unfold = run_clean(xml, perf)
        s = stats(notes, perf, r)
        s["sec"] = round(time.time() - t, 2)
        s["unfold"] = unfold
        print(f"No{n:02d}", json.dumps(s), flush=True)
        tot["notes"] += s["notes"]; tot["matched"] += s["matched"]; tot["wrong"] += s["wrong"]
        tot["in"] += s["matched"] + s["extra"] + s["wrong"]
        if a.inject:
            rng = random.Random(n)
            p2, truth = inject(perf, r["match"], rng)
            r2 = align(notes, p2, free_score_start=False)
            flagged_missed = {i for i in range(len(notes)) if i not in r2["match"] and i not in r2["wrong"]}
            base_missed = {i for i in range(len(notes)) if i not in r["match"]}
            inj["miss_n"] += len(truth["missed"])
            inj["miss_tp"] += len(truth["missed"] & flagged_missed)
            inj["miss_fp"] += len(flagged_missed - truth["missed"] - base_missed - set(truth["wrong"]))
            inj["wrong_n"] += len(truth["wrong"])
            for sidx, d in truth["wrong"].items():
                if sidx in r2["wrong"]:
                    inj["wrong_tp"] += 1
                    played = int(round(p2[r2["wrong"][sidx]][2]))
                    inj["wrong_pitch_ok"] += played == notes[sidx]["pitchMidi"] + d
            inj["wrong_fp"] += len(set(r2["wrong"]) - set(truth["wrong"]) - set(r["wrong"]))
        if a.excerpt and len(r["match"]) > 50:
            ons = sorted(perf[p][0] for p in r["match"].values())
            mid = ons[len(ons) // 2]
            sub = [e for e in perf if mid - 10 <= e[0] <= mid + 10]
            beat_of = {p: notes[s]["onsetBeat"] for s, p in r["match"].items()}
            try:
                r3 = align(notes, sub, free_score_start=True)
                errs = [abs(notes[s]["onsetBeat"] - beat_of[perf.index(sub[p])]) for s, p in r3["match"].items()
                        if perf.index(sub[p]) in beat_of]
                exc.append((n, float(np.median(errs)) if errs else 99.0, len(r3["match"]), len(sub)))
            except ValueError as e:
                exc.append((n, 99.0, 0, len(sub)))
    print("TOTAL recall", round(tot["matched"] / tot["notes"], 4), "wrong", tot["wrong"],
          "precision", round(tot["matched"] / max(1, tot["in"]), 4))
    if a.inject:
        print("INJECT missed recall", round(inj["miss_tp"] / max(1, inj["miss_n"]), 3),
              "new false missed", inj["miss_fp"],
              "| wrong recall", round(inj["wrong_tp"] / max(1, inj["wrong_n"]), 3),
              "played-pitch correct", round(inj["wrong_pitch_ok"] / max(1, inj["wrong_tp"]), 3),
              "new false wrong", inj["wrong_fp"], json.dumps(inj))
    if a.excerpt:
        ok = sum(e[1] <= 0.5 for e in exc)
        print("EXCERPT located", f"{ok}/{len(exc)}", [(n, round(err, 2)) for n, err, _m, _s in exc])
    print("PIANO_HELLER_DONE")


if __name__ == "__main__":
    main()
