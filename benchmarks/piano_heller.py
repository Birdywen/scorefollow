"""Piano benchmark on Heller Op.47 (real recordings, OMR scores, cached transcriptions).

Usage: python3 -m benchmarks.piano_heller [--data DIR] [--only 1,2] [--inject] [--inject-omr] [--inject-perf]
                                          [--excerpt] [--no-trust] [--no-second] [--no-fill]
  default      : aligner recall/precision per etude, and the full engine on the professional takes
                 (pitch score, false blame = mistakes reported on a professional take, scored share)
  --inject-omr : realistic OMR errors injected into the score of the professional take; every one
                 reported as the player's mistake is a false blame (lower is better)
  --no-trust   : engine without score-trust weighting; --no-second: without the Audiveris reading
  --no-fill    : without re-spacing voices with an unprinted rest from the take
  --inject     : mistakes injected into the SCORE, the real audio untouched, so the audio check sees
                 real evidence: an added written note = a key the pianist did not play (missed), a
                 re-pitched note = a wrong key (wrong, played = original), a deleted note = an extra key
  --inject-perf: aligner-only test, mistakes injected into the transcription (audio not consulted)
  --excerpt    : 20 s window from the middle with unknown start -> located beat error
Data: DIR/musicxml/Heller_Op47_NoNN.musicxml, DIR/wav/NoNN.wav, DIR/transcribed/NoNN.json,
DIR/audiveris/Heller_Op47_NoNN.mxl (second reading, optional).
"""
import argparse, json, os, random, sys, time
from collections import Counter, defaultdict
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
        self.delta = defaultdict(Counter)   # per measure: keys the edit added (+) and removed (-)
        for n in notes:
            key = (round(n["onsetBeat"], 4), n["pitchMidi"])
            if key in self.plan["deleted"]:
                self.delta[n["measure"]][n["pitchMidi"]] -= 1
                continue
            if key in self.plan["repitched"]:
                self.delta[n["measure"]][n["pitchMidi"]] -= 1
                n = {**n, "pitchMidi": self.plan["repitched"][key], "orig": n["pitchMidi"]}
                self.delta[n["measure"]][n["pitchMidi"]] += 1
            out.append(n)
        for beat, midi in self.plan["added"]:
            src = next((n for n in notes if abs(n["onsetBeat"] - beat) < 1e-4), None)
            if src is not None:
                out.append({**src, "pitchMidi": midi, "added": True})
                self.delta[src["measure"]][midi] += 1
        out.sort(key=lambda n: (n["onsetBeat"], n["pitchMidi"]))
        for i, n in enumerate(out, 1):
            n["id"] = f"n{i}"
        return out


class OmrEdit(ScoreEdit):
    """Realistic OMR errors injected into the score of a professional take (the audio is real and the
    player right): a lost accidental over a passage, a staff an octave off for a few measures, lost
    chord tones, notehead misreads one staff step off, lost noteheads and phantom noteheads. Every
    one of them the engine reports as the player's mistake is a false blame."""

    def make_plan(self, notes):
        ok = [n for n in notes if (round(n["onsetBeat"], 4), n["pitchMidi"]) in self.ok]
        key = lambda n: (round(n["onsetBeat"], 4), n["pitchMidi"])
        rng, measures = self.rng, sorted({n["measure"] for n in ok})
        repitched, deleted, added, kinds = {}, set(), [], {}
        used = set()

        def window(width):
            m0 = rng.choice(measures[: max(1, len(measures) - width)])
            return [n for n in ok if m0 <= n["measure"] < m0 + width and key(n) not in used]

        # A lost accidental: one key, every time in an 8-measure passage, a semitone off.
        for _ in range(10):
            w = window(8)
            counts = defaultdict(list)
            for n in w:
                counts[n["pitchMidi"]].append(n)
            cands = [ns for ns in counts.values() if len(ns) >= 4]
            if cands:
                ns = rng.choice(cands)
                d = rng.choice([1, -1])
                for n in ns:
                    repitched[key(n)] = n["pitchMidi"] + d; used.add(key(n)); kinds[key(n)] = "accidental"
                break
        # A lost ottava/clef: one staff, 3 measures, an octave off.
        w = [n for n in window(3) if n["staff"] == rng.choice([1, 2])]
        d = rng.choice([12, -12])
        for n in w:
            if 21 <= n["pitchMidi"] + d <= 108:
                repitched[key(n)] = n["pitchMidi"] + d; used.add(key(n)); kinds[key(n)] = "octave"
        # Lost chord tones: one note from each of up to 4 chords of 3+ notes in 6 measures.
        groups = defaultdict(list)
        for n in window(6):
            groups[round(n["onsetBeat"], 4)].append(n)
        for ns in [g for g in groups.values() if len(g) >= 3][:4]:
            n = rng.choice(ns)
            deleted.add(key(n)); used.add(key(n)); kinds[key(n)] = "chord_tone"
        rest = [n for n in ok if key(n) not in used]
        rng.shuffle(rest)
        for n in rest[:6]:                  # notehead one staff step (1-2 semitones) off
            repitched[key(n)] = n["pitchMidi"] + rng.choice([1, 2, -1, -2]); kinds[key(n)] = "misread"
        for n in rest[6:10]:                # notehead lost
            deleted.add(key(n)); kinds[key(n)] = "lost"
        for n in rest[10:13]:               # phantom notehead a third away in the same chord
            t = self.ok[key(n)]
            busy = self.sounding(t)
            choices = [n["pitchMidi"] + d for d in (3, 4, -3, -4) if n["pitchMidi"] + d not in busy]
            if choices:
                added.append((round(n["onsetBeat"], 4), rng.choice(choices)))
        self.plan = {"added": added, "repitched": repitched, "deleted": deleted, "kinds": kinds}


def mirrored_witness(edit):
    """A student mistake leaves the score right, so a second reader would read the same written keys:
    mirror the score edit into the second reading (OMR-error injection must not do this)."""
    real = piano_engine.second_witness

    def witness(xml, second_xml, parse=None):
        out = {}
        for m, (prim, sec) in real(xml, second_xml, parse).items():
            sec = Counter(sec)
            for key, d in edit.delta.get(m, {}).items():
                sec[key] = max(0, sec[key] + d)
            out[m] = (prim, sec)
        return out
    return witness


def engine(wav, xml, perf, **kw):
    return piano_engine.analyze_piano(wav, xml, 80, 1, perf=perf, **kw)


def second_reading(data, n):
    path = f"{data}/audiveris/Heller_Op47_No{n:02d}.mxl"
    if not os.path.exists(path):
        return None
    from analysis_service.omr import extract_xml
    return extract_xml(open(path, "rb").read())


def omr_blame(base, res, plan, edit):
    """(injected errors, of them reported as the player's mistakes) by kind."""
    out = defaultdict(lambda: [0, 0])
    by = {(round(x["onsetBeat"], 4), x["pitchMidi"]): x for x in res["notes"]}
    for (beat, orig), new in plan["repitched"].items():
        x = by.get((beat, new))
        if x is None:
            continue
        kind = plan["kinds"][(beat, orig)]
        out[kind][0] += 1
        out[kind][1] += x["status"] in ("missed", "wrong_pitch")
    counted = [(e["sec"], e["midi"]) for e in res["extras"] if e["counted"]]
    for beat, midi in plan["deleted"]:
        t0 = edit.ok[(beat, midi)]
        kind = plan["kinds"][(beat, midi)]
        out[kind][0] += 1
        out[kind][1] += any(abs(sec - t0) < 0.05 and m == midi for sec, m in counted)
    for beat, midi in plan["added"]:
        x = by.get((beat, midi))
        if x is None:
            continue
        out["phantom"][0] += 1
        out["phantom"][1] += x["status"] == "missed"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--only")
    ap.add_argument("--inject", action="store_true")
    ap.add_argument("--inject-perf", action="store_true")
    ap.add_argument("--excerpt", action="store_true")
    ap.add_argument("--inject-omr", action="store_true")
    ap.add_argument("--no-trust", action="store_true")
    ap.add_argument("--no-second", action="store_true")
    ap.add_argument("--no-fill", action="store_true")
    a = ap.parse_args()
    omr = defaultdict(lambda: [0, 0])
    shares = []
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
        kw = {"trust": not a.no_trust, "fill_voices": not a.no_fill, "second_xml": None if a.no_second else second_reading(a.data, n)}
        base = engine(wav, xml, perf, **kw)
        bs = base["summary"]
        chk = bs["scoreCheck"]
        mistakes = bs["wrongPitchNotes"] + bs["missedNotes"] + bs["extraNotes"]
        shares.append(chk["scoredShare"])
        pro["notes"] += bs["noteCount"]; pro["mistakes"] += mistakes; pro["doubtful"] += bs["uncertainNotes"]
        if bs["pitchScore"] is not None:
            pro["scores"].append(bs["pitchScore"])
        if "refused" in (chk["pitch"], chk["rhythm"]):
            pro["refused"].append((n, chk["pitch"], chk["rhythm"]))
        s.update({"pitch": bs["pitchScore"], "rhythm": bs["rhythmScore"], "mistakes": mistakes,
                  "doubtful": bs["uncertainNotes"], "scored": chk["scoredShare"], "second": chk["secondReading"],
                  "check": f"{chk['pitch']}/{chk['rhythm']}",
                  "evidence": sorted({e["kind"] for e in chk["evidence"]}), "fills": len(bs.get("voiceFixes", [])), "A4": bs["tuning"]["referenceHz"],
                  "sec": round(time.time() - t, 2)})
        print(f"No{n:02d}", json.dumps(s, ensure_ascii=False), flush=True)
        if a.inject:
            edit = ScoreEdit(base, perf, random.Random(n))
            with patch.object(piano_engine, "parse_piano_score", edit), \
                    patch.object(piano_engine, "second_witness", mirrored_witness(edit)):
                res = engine(wav, xml, perf, **kw)
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
        if a.inject_omr:
            edit = OmrEdit(base, perf, random.Random(1000 + n))
            with patch.object(piano_engine, "parse_piano_score", edit):
                res = engine(wav, xml, perf, **kw)
            for kind, (cnt, blamed) in omr_blame(base, res, edit.plan, edit).items():
                omr[kind][0] += cnt; omr[kind][1] += blamed
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
          "| false blame per 1000 notes", round(1000 * pro["mistakes"] / pro["notes"], 1),
          "| scored share", round(float(np.mean(shares)), 3),
          "| doubtful per 1000", round(1000 * pro["doubtful"] / pro["notes"], 1), "| refused", pro["refused"])
    if a.inject:
        print("INJECT missed", f"{inj['add_missed']}/{inj['add_n']}", f"(+{inj['add_soft']} doubtful)",
              "| wrong", f"{inj['rep_wrong']}/{inj['rep_n']}", f"played-pitch ok {inj['rep_pitch_ok']}",
              f"(+{inj['rep_soft']} doubtful)", "| extra", f"{inj['del_extra']}/{inj['del_n']}",
              "| new false mistakes", inj["false_new"], "| mean score drop", round(inj["drop"] / len(ids), 1))
    if a.inject_omr:
        cnt, blamed = sum(v[0] for v in omr.values()), sum(v[1] for v in omr.values())
        print("INJECT-OMR blamed", f"{blamed}/{cnt}", f"({100 * blamed / max(1, cnt):.0f}%)",
              " ".join(f"{k} {b}/{c}" for k, (c, b) in sorted(omr.items())))
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
