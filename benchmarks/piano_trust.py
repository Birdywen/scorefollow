"""Fit and check the score-trust tables (analysis_service/score_trust.py) on Heller Op.47.

On a professional take nearly every score/take disagreement is the score's or the transcriber's
fault. Measures with an OMR symptom show more of them than clean measures; the excess share is the
symptom's doubt: (rate with symptom - clean rate) / rate with symptom.

Usage: python3 -m benchmarks.piano_trust [--data DIR] [--cache FILE]
  Fits on all etudes, and also on odd / even etudes to show how stable each number is.
  Second readings: DIR/audiveris/Heller_Op47_NoNN.mxl (Audiveris 5.11, tools/omr_second.py).
"""
import argparse, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from analysis_service import piano_engine  # noqa: E402
from analysis_service.omr import extract_xml  # noqa: E402
from analysis_service.score_trust import check_score, compare_readings, read_as_printed  # noqa: E402
from benchmarks.piano_heller import DATA, load  # noqa: E402

BINS = [0.95, 0.8, 0.6, 0.0]   # agreement bins of the second reading, high to low
PRIOR = 10                     # pseudo-measures at the clean rate: small samples shrink to no doubt


def second_reading(data, n):
    path = f"{data}/audiveris/Heller_Op47_No{n:02d}.mxl"
    return extract_xml(open(path, "rb").read()) if os.path.exists(path) else None


def measure_rows(data, n):
    """[(measure, disagreements, symptom kinds, agreement)] from the engine with trust off."""
    xml, perf, wav = load(data, n)
    r = piano_engine.analyze_piano(wav, xml, 80, 1, perf=perf, trust=False)
    left = defaultdict(int)
    for x in r["notes"]:
        if x["status"] in ("missed", "wrong_pitch"):
            left[x["measure"]] += 1
    for x in r["extras"]:
        if x["counted"] and x["measure"] is not None:
            left[x["measure"]] += 1
    found = check_score(xml)
    second = second_reading(data, n)
    agree = compare_readings(read_as_printed(xml), read_as_printed(second)) if second else {}
    measures = sorted({x["measure"] for x in r["notes"]})
    return [(m, left[m], sorted({i["kind"] for i in found.get(m, [])}), agree.get(m, {}).get("pitch"))
            for m in measures]


def fit(rows):
    clean = [d for _m, d, kinds, a in rows if not kinds and (a is None or a >= BINS[0])]
    base = sum(clean) / max(1, len(clean))
    def doubt(ds):
        rate = (sum(ds) + PRIOR * base) / (len(ds) + PRIOR)
        return max(0.0, (rate - base) / rate) if rate > 0 else 0.0, len(ds), sum(ds)
    kinds = sorted({k for _m, _d, ks, _a in rows for k in ks})
    sym = {k: doubt([d for _m, d, ks, _a in rows if k in ks]) for k in kinds}
    agr, lo_prev = {}, 1.01
    for lo in BINS:
        # Among structurally clean measures, so the two signals are measured separately.
        ds = [d for _m, d, ks, a in rows if not ks and a is not None and lo <= a < lo_prev]
        agr[lo] = doubt(ds)
        lo_prev = lo
    return base, sym, agr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--cache")
    a = ap.parse_args()
    if a.cache and os.path.exists(a.cache):
        rows_by = {int(k): v for k, v in json.load(open(a.cache)).items()}
    else:
        rows_by = {}
        for n in range(1, 25):
            rows_by[n] = measure_rows(a.data, n)
            print(f"No{n:02d} measures {len(rows_by[n])} disagreements {sum(r[1] for r in rows_by[n])}", flush=True)
        if a.cache:
            json.dump(rows_by, open(a.cache, "w"))
    for name, ids in (("all", range(1, 25)), ("odd", range(1, 25, 2)), ("even", range(2, 25, 2))):
        rows = [r for n in ids for r in rows_by[n]]
        base, sym, agr = fit(rows)
        print(f"[{name}] measures {len(rows)}  clean rate {base:.2f}/measure")
        for k, (d, cnt, tot) in sorted(sym.items(), key=lambda kv: -kv[1][0]):
            print(f"  symptom {k:24s} doubt {d:.2f}  measures {cnt:4d}  disagreements {tot}")
        for lo, (d, cnt, tot) in agr.items():
            print(f"  agreement >= {lo:.2f}            doubt {d:.2f}  measures {cnt:4d}  disagreements {tot}")
    print("PIANO_TRUST_DONE")


if __name__ == "__main__":
    main()
