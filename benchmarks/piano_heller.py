"""Piano benchmark on Heller Op.47 (real recordings, OMR scores, cached transcriptions).

Usage: python3 -m benchmarks.piano_heller [--data DIR] [--only 1,2] [--inject] [--inject-perf] [--excerpt]
  default      : aligner recall/precision per etude, and the full engine on the professional takes
                 (pitch score, confirmed mistakes, doubtful notes, score-check verdicts, tuning)
  --inject     : mistakes injected into the SCORE, the real audio untouched, so the audio check sees
                 real evidence: an added written note = a key the pianist did not play (missed), a
                 re-pitched note = a wrong key (wrong, played = original), a deleted note = an extra key
  --inject-perf: aligner-only test, mistakes injected into the transcription (audio not consulted)
  --excerpt    : 20 s window from the middle with unknown start -> located beat error
Data: DIR/musicxml/Heller_Op47_NoNN.musicxml, DIR/wav/NoNN.wav, DIR/transcribed/NoNN.json.
"""
import argparse, json, os, random, sys, time
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from analysis_service import piano_engine  # noqa: E402
from analysis_service.piano_align import align  # noqa: E402
from analysis_service.piano_score import has_repeats, parse_piano_score  # noqa: E402

DATA = "/home/ubuntu/n/Piano train/heller-op47"


def load(data, n):
    xml = open(f"{data}/musicxml/Heller_Op47_No{n:02d}.musicxml", encoding="utf-8").read()
    perf = [tuple(e) for e in json.load(open(f"{data}/transcribed/No{n:02d}.json"))]
    wav = open(f"{data}/wav/No{n:02d}.wav", "rb").read()
    return xml, sorted(perf), wav


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
    in_win = int(sum(lo <= p[0] <= hi for p in perf))
    m, w = len(r["match"]), len(r["wrong"])
    return {"notes": len(notes), "matched": m, "wrong": w, "missed": len(notes) - m - w,
            "recall": round(m / len(notes), 3), "precision": round(m / max(1, in_win), 3),
            "extra": in_win - m - w}


def inject_perf(perf, match, rng):
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
    for _ in range(max(1, int(0.03 * len(matched)))):
        out.append((rng.uniform(t0, t1), 0, float(rng.randint(40, 84)), 60.0))
    return sorted(out), truth


class ScoreEdit:
    """Edits applied to every score reading the engine parses; records the truth by (onsetBeat, pitch)."""

    def __init__(self, base_result, perf, rng, rate=0.03):
        self.rng, self.rate = rng, rate
        # Only notes the clean run agreed on are candidates, so a 'mistake' is never an OMR error.
        self.ok = {(round(n["onsetBeat"], 4), n["pitchMidi"]): n["performedSec"]
                   for n in base_result["notes"] if n["matchStatus"] == "matched" and n["status"] != "wrong_pitch"}
        self.on = np.array([e[0] for e in perf])
        self.pitch = np.array([int(round(e[2])) for e in perf])
        self.plan = None
        self.real = parse_piano_score

    def sounding(self, t, window=0.5):
        return set(self.pitch[np.abs(self.on - t) < window])

    def make_plan(self, notes):
        keys = sorted(k for k in self.ok if self.ok[k] is not None)
        self.rng.shuffle(keys)
        n = max(2, int(self.rate * len(keys)))
        added, repitched, deleted = [], {}, []
        for beat, midi in keys[:n]:            # add a written note nobody played
            t = self.ok[(beat, midi)]
            busy = self.sounding(t)
            choices = [midi + d for d in (3, 4, -3, -4, 5, -5) if 21 <= midi + d <= 108 and midi + d not in busy]
            if choices:
                added.append((beat, self.rng.choice(choices)))
        for beat, midi in keys[n:2 * n]:       # the written key is not the one played
            t = self.ok[(beat, midi)]
            busy = self.sounding(t)
            choices = [midi + d for d in (1, -1, 2, -2) if midi + d not in busy]
            if choices:
                repitched[(beat, midi)] = self.rng.choice(choices)
        deleted = keys[2 * n:3 * n]            # a played key the score doesn't have
        self.plan = {"added": added, "repitched": repitched, "deleted": set(deleted)}

    def __call__(self, xml, unfold=True, spans=None, issues=None):
        notes = self.real(xml, unfold=unfold, spans=spans, issues=issues)
        if self.plan is None:
            self.make_plan(notes)
        out = []
        for n in notes:
            key = (round(n["onsetBeat"], 4), n["pitchMidi"])
            if key in self.plan["deleted"]:
                continue
            if key in self.plan["repitched"]:
                n = {**n, "pitchMidi": self.plan["repitched"][key], "orig": n["pitchMidi"]}
            out.append(n)
        for beat, midi in self.plan["added"]:
            src = next((n for n in notes if abs(n["onsetBeat"] - beat) < 1e-4), None)
            if src is not None:
                out.append({**src, "pitchMidi": midi, "added": True})
        out.sort(key=lambda n: (n["onsetBeat"], n["pitchMidi"]))
        for i, n in enumerate(out, 1):
            n["id"] = f"n{i}"
        return out


def engine(wav, xml, perf):
    return piano_engine.analyze_piano(wav, xml, 80, 1, perf=perf)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--only")
    ap.add_argument("--inject", action="store_true")
    ap.add_argument("--inject-perf", action="store_true")
    ap.add_argument("--excerpt", action="store_true")
    a = ap.parse_args()
    ids = [int(x) for x in a.only.split(",")] if a.only else list(range(1, 25))
    tot = {"notes": 0, "matched": 0, "wrong": 0, "in": 0}
    pro = {"notes": 0, "mistakes": 0, "doubtful": 0, "scores": [], "refused": []}
    inj = {k: 0 for k in ("add_n", "add_missed", "add_soft", "rep_n", "rep_wrong", "rep_pitch_ok", "rep_soft",
                          "del_n", "del_extra", "false_new", "drop")}
    injp = {"miss_tp": 0, "miss_n": 0, "miss_fp": 0, "wrong_tp": 0, "wrong_pitch_ok": 0, "wrong_n": 0, "wrong_fp": 0}
    exc = []
    for n in ids:
        xml, perf, wav = load(a.data, n)
        t = time.time()
        notes, r, unfold = run_clean(xml, perf)
        s = stats(notes, perf, r)
        tot["notes"] += s["notes"]; tot["matched"] += s["matched"]; tot["wrong"] += s["wrong"]
        tot["in"] += s["matched"] + s["extra"] + s["wrong"]
        base = engine(wav, xml, perf)
        bs = base["summary"]
        chk = bs["scoreCheck"]
        mistakes = bs["wrongPitchNotes"] + bs["missedNotes"] + bs["extraNotes"]
        pro["notes"] += bs["noteCount"]; pro["mistakes"] += mistakes; pro["doubtful"] += bs["uncertainNotes"]
        if bs["pitchScore"] is not None:
            pro["scores"].append(bs["pitchScore"])
        if "refused" in (chk["pitch"], chk["rhythm"]):
            pro["refused"].append((n, chk["pitch"], chk["rhythm"]))
        s.update({"pitch": bs["pitchScore"], "rhythm": bs["rhythmScore"], "mistakes": mistakes,
                  "doubtful": bs["uncertainNotes"], "check": f"{chk['pitch']}/{chk['rhythm']}",
                  "evidence": sorted({e["kind"] for e in chk["evidence"]}), "A4": bs["tuning"]["referenceHz"],
                  "sec": round(time.time() - t, 2)})
        print(f"No{n:02d}", json.dumps(s, ensure_ascii=False), flush=True)
        if a.inject:
            edit = ScoreEdit(base, perf, random.Random(n))
            with patch.object(piano_engine, "parse_piano_score", edit):
                res = engine(wav, xml, perf)
            plan = edit.plan
            by = {(round(x["onsetBeat"], 4), x["pitchMidi"]): x for x in res["notes"]}
            soft = lambda x: x["status"] == "uncertain"
            for beat, midi in plan["added"]:
                x = by.get((beat, midi))
                if x is None:
                    continue
                inj["add_n"] += 1
                inj["add_missed"] += x["status"] == "missed"
                inj["add_soft"] += soft(x)
            for (beat, orig), new in plan["repitched"].items():
                x = by.get((beat, new))
                if x is None:
                    continue
                inj["rep_n"] += 1
                if x["status"] == "wrong_pitch":
                    inj["rep_wrong"] += 1
                    inj["rep_pitch_ok"] += x.get("playedMidi") == orig
                inj["rep_soft"] += soft(x)
            extras = [(e["sec"], e["midi"]) for e in res["extras"] if e["audioCheck"]["result"] in ("heard", "unchecked")]
            for beat, midi in plan["deleted"]:
                t0 = edit.ok[(beat, midi)]
                inj["del_n"] += 1
                inj["del_extra"] += any(abs(sec - t0) < 0.05 and m == midi for sec, m in extras)
            base_bad = {(round(x["onsetBeat"], 4), x["pitchMidi"]) for x in base["notes"]
                        if x["status"] in ("missed", "wrong_pitch", "uncertain", "excluded")}
            touched = {(b, m) for b, m in plan["added"]} | {(b, m) for (b, _o), m in plan["repitched"].items()}
            inj["false_new"] += sum(1 for k, x in by.items() if x["status"] in ("missed", "wrong_pitch")
                                    and k not in base_bad and k not in touched)
            if bs["pitchScore"] is not None and res["summary"]["pitchScore"] is not None:
                inj["drop"] += bs["pitchScore"] - res["summary"]["pitchScore"]
        if a.inject_perf:
            rng = random.Random(n)
            p2, truth = inject_perf(perf, r["match"], rng)
            r2 = align(notes, p2, free_score_start=False)
            flagged = {i for i in range(len(notes)) if i not in r2["match"] and i not in r2["wrong"]}
            base_missed = {i for i in range(len(notes)) if i not in r["match"]}
            injp["miss_n"] += len(truth["missed"])
            injp["miss_tp"] += len(truth["missed"] & flagged)
            injp["miss_fp"] += len(flagged - truth["missed"] - base_missed - set(truth["wrong"]))
            injp["wrong_n"] += len(truth["wrong"])
            for sidx, d in truth["wrong"].items():
                if sidx in r2["wrong"]:
                    injp["wrong_tp"] += 1
                    injp["wrong_pitch_ok"] += int(round(p2[r2["wrong"][sidx]][2])) == notes[sidx]["pitchMidi"] + d
            injp["wrong_fp"] += len(set(r2["wrong"]) - set(truth["wrong"]) - set(r["wrong"]))
        if a.excerpt and len(r["match"]) > 50:
            ons = sorted(perf[p][0] for p in r["match"].values())
            mid = ons[len(ons) // 2]
            sub = [e for e in perf if mid - 10 <= e[0] <= mid + 10]
            beat_of = {p: notes[s_]["onsetBeat"] for s_, p in r["match"].items()}
            try:
                r3 = align(notes, sub, free_score_start=True)
                errs = [abs(notes[s_]["onsetBeat"] - beat_of[perf.index(sub[p])]) for s_, p in r3["match"].items()
                        if perf.index(sub[p]) in beat_of]
                exc.append((n, float(np.median(errs)) if errs else 99.0))
            except ValueError:
                exc.append((n, 99.0))
    print("TOTAL align recall", round(tot["matched"] / tot["notes"], 4), "precision", round(tot["matched"] / max(1, tot["in"]), 4))
    print("PRO pitch mean", round(float(np.mean(pro["scores"])), 1), "min", min(pro["scores"]),
          "| mistakes per 1000 notes", round(1000 * pro["mistakes"] / pro["notes"], 1),
          "| doubtful per 1000", round(1000 * pro["doubtful"] / pro["notes"], 1), "| refused", pro["refused"])
    if a.inject:
        print("INJECT missed", f"{inj['add_missed']}/{inj['add_n']}", f"(+{inj['add_soft']} doubtful)",
              "| wrong", f"{inj['rep_wrong']}/{inj['rep_n']}", f"played-pitch ok {inj['rep_pitch_ok']}",
              f"(+{inj['rep_soft']} doubtful)", "| extra", f"{inj['del_extra']}/{inj['del_n']}",
              "| new false mistakes", inj["false_new"], "| mean score drop", round(inj["drop"] / len(ids), 1))
    if a.inject_perf:
        print("INJECT-PERF missed recall", round(injp["miss_tp"] / max(1, injp["miss_n"]), 3), "new false missed", injp["miss_fp"],
              "| wrong recall", round(injp["wrong_tp"] / max(1, injp["wrong_n"]), 3),
              "played-pitch correct", round(injp["wrong_pitch_ok"] / max(1, injp["wrong_tp"]), 3), "new false wrong", injp["wrong_fp"])
    if a.excerpt:
        ok = sum(e[1] <= 0.5 for e in exc)
        print("EXCERPT located", f"{ok}/{len(exc)}", [(n, round(err, 2)) for n, err in exc])
    print("PIANO_HELLER_DONE")


if __name__ == "__main__":
    main()
