"""Lightweight rhythmic-structure annotator (beats / downbeats / phrases).

No portable annotator logic was found in the repo or design docs, so this is
a minimal heuristic built only on data the engine already computes:

- beats: detected QM beat timestamps when the live vamp-beat grid is in use,
  otherwise the legacy fixed-tempo quarter-note grid subdividing each
  analyzed measure interval;
- downbeats: analyzed measure starts (one definition shared with
  ``measureIntervals``);
- phrases: consecutive groups of ``phrase_measures`` measures (default 4).

Stdlib only, deterministic, no audio access. Scoring math, thresholds and
existing result fields are untouched; the engine exposes this under the
additive top-level ``result[\"rhythm\"]`` key.
"""

# Heuristic phrase length: pop/folk phrasing most often groups in fours;
# callers analyzing long symphonic spans may pass phrase_measures=8.
PHRASE_MEASURES = 4


def _round3(value):
    return round(float(value), 3)


def annotate_rhythm(measure_intervals, beat_map=None, sec_per_beat=None,
                    phrase_measures=PHRASE_MEASURES):
    """Annotate rhythmic structure over analyzed measure intervals.

    measure_intervals: [{"measure": int, "startSec": float, "endSec": float}]
      (the engine's analyzed span, already clipped to the recording).
    beat_map: optional detected beat timestamps (seconds); used when the
      live vamp-beat grid is active, clipped to the analyzed span.
    sec_per_beat: quarter-note seconds for the legacy-grid fallback.
    Returns {"source", "beats", "downbeats", "phrases", "phraseMeasures"}.
    Total function: empty intervals yield empty lists, never an exception.
    """
    intervals = []
    for entry in measure_intervals or []:
        start = float(entry["startSec"])
        end = float(entry["endSec"])
        if end > start:
            intervals.append({"measure": int(entry["measure"]),
                              "startSec": start, "endSec": end})
    downbeats = [{"measure": m["measure"], "sec": _round3(m["startSec"])}
                 for m in intervals]
    source = "legacy-grid"
    beats: list[float] = []
    if beat_map:
        seen = sorted({float(b) for b in beat_map})
        if intervals:
            lo, hi = intervals[0]["startSec"], intervals[-1]["endSec"]
            beats = [_round3(b) for b in seen if lo - 1e-9 <= b <= hi + 1e-9]
        else:
            beats = [_round3(b) for b in seen]
        if beats:
            source = "vamp-beat"
    if not beats and intervals:
        step = float(sec_per_beat) if sec_per_beat else 0.0
        if step > 0:
            cursor = intervals[0]["startSec"]
            end = intervals[-1]["endSec"]
            while cursor <= end + 1e-9:
                beats.append(_round3(cursor))
                cursor += step
        else:
            # Degenerate fallback: no tempo information, downbeats only.
            beats = [_round3(m["startSec"]) for m in intervals]
    step = max(1, int(phrase_measures))
    phrases = []
    for offset in range(0, len(intervals), step):
        chunk = intervals[offset:offset + step]
        phrases.append({"index": len(phrases) + 1,
                        "startMeasure": chunk[0]["measure"],
                        "endMeasure": chunk[-1]["measure"],
                        "startSec": _round3(chunk[0]["startSec"]),
                        "endSec": _round3(chunk[-1]["endSec"])})
    return {"source": source, "beats": beats, "downbeats": downbeats,
            "phrases": phrases, "phraseMeasures": step}
