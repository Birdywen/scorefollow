"""Per-measure diagnosis of one Heller etude: where notes go missing, wrong-note pitch offsets, coverage.
Usage: python3 -m benchmarks.piano_diag N"""
import collections, sys

from benchmarks.piano_heller import DATA, load, run_clean

n = int(sys.argv[1])
xml, perf = load(DATA, n)
notes, r, unfold = run_clean(xml, perf)
tm = r["tempo"]
print(f"No{n:02d} unfold={unfold} audio {perf[0][0]:.1f}-{perf[-1][0]:.1f}s  map beats {tm.beats[0]:.1f}-{tm.beats[-1]:.1f}"
      f" secs {tm.secs[0]:.1f}-{tm.secs[-1]:.1f} last score beat {notes[-1]['onsetBeat']}")
per = collections.OrderedDict()
for i, s in enumerate(notes):
    key = (s["measure"], round(s["onsetBeat"] // 1))
    d = per.setdefault(s["measure"], [0, 0, 0, 0, []])
    d[0] += 1
    if i in r["match"]:
        d[1] += 1
    elif i in r["wrong"]:
        d[2] += 1
        d[4].append(int(round(perf[r["wrong"][i]][2])) - s["pitchMidi"])
    else:
        d[3] += 1
bad = [(m, d) for m, d in per.items() if d[3] + d[2] >= 3]
print("measures with >=3 missed/wrong:", [(m, f"{d[1]}/{d[0]} w{d[2]} x{d[3]}") for m, d in bad])
print("wrong offsets:", collections.Counter(o for d in per.values() for o in d[4]).most_common(8))
miss_staff = collections.Counter(notes[i]["staff"] for i in range(len(notes)) if i not in r["match"] and i not in r["wrong"])
print("missed by staff:", dict(miss_staff))
# missed notes with an unmatched same-pitch performed note within 0.5 s (window too tight?) or octave away
used = set(r["match"].values()) | set(r["wrong"].values())
near = oct_ = 0
for i in range(len(notes)):
    if i in r["match"] or i in r["wrong"]:
        continue
    e = r["expected"][i]
    for k, (on, _o, p, _v) in enumerate(perf):
        if k in used or abs(on - e) > 0.5:
            continue
        if int(round(p)) == notes[i]["pitchMidi"]:
            near += 1; break
        if abs(int(round(p)) - notes[i]["pitchMidi"]) == 12:
            oct_ += 1; break
print("missed with same pitch unused within 0.5s:", near, " octave-away:", oct_)
print("DIAG_DONE")
