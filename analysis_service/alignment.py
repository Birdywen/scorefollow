"""Conservative subsequence alignment for locating an audio excerpt in a score.

locate_excerpt infers only the *starting score note*. align_excerpt goes
further (start + end + measure time map) for automatic measure sync, still
without warping rhythm ground truth: it fits one global line
audioSec = t0 + slope * scoreBeat (tempo + offset only), so intra-measure
timing stays measurable. The engine keeps scoring against its independent
beat grid; the alignment selects the note range and derives measureIntervals.

Beat-tracker positions are deliberately NOT used as a rigid ruler inside the
search: over a long take, rubato accumulates beats of drift and a rigid
penalty punishes the true path (observed: true-start cost 0.315 -> 0.953 on a
6/8 take, failing the .70 gate). Time evidence enters only through the fitted
line; an optional beat-ratio sanity check is unit-agnostic (pulse ratios only).
"""

import math

import numpy as np


def usable_events(pitch_notes: list) -> list[tuple[float, float, float]]:
    """Validate sensor output before using its order or timestamps as anchors."""
    events = []
    previous_end = 0.0
    for segment in pitch_notes:
        try:
            start, end, midi = map(float, segment)
        except (TypeError, ValueError) as exc:
            raise ValueError("音高事件格式无效") from exc
        if not all(math.isfinite(v) for v in (start, end, midi)) or start < 0 or end <= start:
            raise ValueError("音高事件时间或数值无效")
        if start < previous_end - .001:
            raise ValueError("音高事件重叠或未按时间排序")
        previous_end = end
        if end - start >= .09 and 36 <= midi <= 96:
            events.append((start, end, midi))
    return events


def locate_excerpt(score_notes: list[dict], pitch_notes: list, *, max_events: int = 64,
                   beat_map: list | None = None) -> tuple[int, float]:
    """Return (score-note index, mean alignment cost); fail closed if ambiguous.

    Short, unreliable pYIN segments are skipped. Bounded edit-distance DTW
    tolerates missing/extra onsets and local tempo changes without choosing a
    pitch merely because it matches the score. Scoring uses continuous cents.
    """
    segments = usable_events(pitch_notes)[:max_events]
    events = [midi for _, _, midi in segments]
    if len(events) < 8 or len(score_notes) < 8:
        raise ValueError("片段定位需要至少 8 个可靠的音高事件；请指定起始小节")
    n = len(events)
    positions = None
    if beat_map is not None:
        beats = sorted(set(float(b) for b in beat_map if math.isfinite(float(b)) and float(b) >= 0))
        if len(beats) >= 4:
            intervals = np.diff(beats)
            med = float(np.median(intervals))
            if med > 0 and float(np.max(intervals)) <= med * 2.5:
                def position(t):
                    if t < beats[0]:
                        return (t - beats[0]) / med
                    if t > beats[-1]:
                        return len(beats) - 1 + (t - beats[-1]) / med
                    return float(np.interp(t, beats, np.arange(len(beats))))
                origin = position(segments[0][0])
                positions = [position(segment[0]) - origin for segment in segments]
    candidates = []
    for start in range(len(score_notes)):
        written = [float(note["pitchMidi"]) for note in score_notes[start:start + 2 * n + 4]]
        anchor_cents = abs(events[0] - written[0]) * 100
        # A low average cost cannot justify an unrelated opening note: it
        # shifts every later scoring window even if the passage was located.
        if min(anchor_cents, abs(anchor_cents - 1200)) > 150:
            continue
        if len(written) < max(6, int(n * .65)):
            continue
        # Force the first audio event to match the proposed first score note.
        # Otherwise leading deletions make the returned time anchor fictitious.
        prev = [0.0] + [float("inf")] * len(written)
        for i, midi in enumerate(events, 1):
            row = [float("inf")] * (len(written) + 1)
            for j, target in enumerate(written, 1):
                if abs(i - j) > max(4, n // 3):
                    continue
                cents = abs(midi - target) * 100
                # A 1200-cent discrepancy may be a pitch-tracker octave error,
                # but is never as cheap as an exact match.
                octave = abs(cents - 1200) / 100 + .75
                difference = min(2.5, cents / 100, octave)
                if positions is not None:
                    # Retain elapsed time across missing pYIN events. The grid
                    # is audio-only; DTW does not manufacture rhythm evidence.
                    score_offset = score_notes[start + j - 1]["onsetBeat"] - score_notes[start]["onsetBeat"]
                    difference += min(3.0, abs(positions[i - 1] - score_offset) * 2)
                row[j] = (prev[j - 1] + difference if i == 1 or j == 1 else
                          min(prev[j - 1] + difference,
                              prev[j] + 1.25, row[j - 1] + .85))
            prev = row
        minimum = min(prev[max(6, int(n * .65)):]) / n
        candidates.append((minimum, start))
    if not candidates:
        raise ValueError("录音与乐谱不足以定位片段；请指定起始小节")
    candidates.sort()
    best, index = candidates[0]
    # Adjacent start indices can describe the same excerpt via a single skipped
    # event; compare distinct passages instead of treating them as repeats.
    alternative = next((cost for cost, i in candidates
                        if abs(i - index) > max(3, n // 3)), float("inf"))
    # Even nearby starts are ambiguous when they fit equally well. Excluding
    # them wholesale hides short repeated motifs and picks the earliest copy.
    tied_start = any(i != index and abs(cost - best) <= 1e-8 for cost, i in candidates)
    if best > .70 or alternative - best < .16 or tied_start:
        raise ValueError("录音片段与乐谱不吻合或重复乐句无法区分；请指定起始小节")
    if n > 24:
        try:
            short_index, _ = locate_excerpt(score_notes, pitch_notes, max_events=24, beat_map=beat_map)
        except ValueError:
            pass  # More context may legitimately resolve an ambiguous prefix.
        else:
            if short_index != index:
                raise ValueError("长短片段定位起点不一致，无法可靠评分；请指定起始小节")
    return index, round(best, 3)


def _pitch_diff(midi: float, target: float) -> float:
    """Edit cost between a measured pitch and a written one.

    A 1200-cent discrepancy may be a pitch-tracker octave error, but is never
    as cheap as an exact match. Continuous cents keep near-misses ordered.
    """
    cents = abs(midi - target) * 100
    return min(2.5, cents / 100, abs(cents - 1200) / 100 + .75)


def _prefix_candidates(score_notes: list[dict], events: list[float],
                       limit: int = 64, margin: float = 0.40, cap: int = 16) -> list:
    """Pitch-only scan of the excerpt prefix; returns [(cost, start)] kept.

    Deliberately no beat-tracker positions here (see module docstring): the
    prefix only needs to INCLUDE the true start among a few rivals; the full
    path below disambiguates repeats. Same anchor gate and band rule as
    locate_excerpt so behaviour stays comparable.
    """
    k = min(len(events), limit)
    head = events[:k]
    band = max(4, k // 3)
    floor = max(6, int(k * .65))
    scored = []
    for start in range(len(score_notes)):
        written = [float(note["pitchMidi"]) for note in score_notes[start:start + 2 * k + 4]]
        anchor_cents = abs(head[0] - written[0]) * 100 if written else float("inf")
        if min(anchor_cents, abs(anchor_cents - 1200)) > 150:
            continue
        if len(written) < max(6, int(k * .65)):
            continue
        prev = [0.0] + [float("inf")] * len(written)
        for i, midi in enumerate(head, 1):
            row = [float("inf")] * (len(written) + 1)
            for j, target in enumerate(written, 1):
                if abs(i - j) > band:
                    continue
                diff = _pitch_diff(midi, target)
                row[j] = (prev[j - 1] + diff if i == 1 or j == 1 else
                          min(prev[j - 1] + diff, prev[j] + 1.25, row[j - 1] + .85))
            prev = row
        scored.append((min(prev[floor:]) / k if len(prev) > floor else float("inf"), start))
    scored.sort()
    if not scored or not math.isfinite(scored[0][0]):
        raise ValueError("录音与乐谱不足以定位片段；请指定起始小节")
    cutoff = scored[0][0] + margin
    return [(c, s) for c, s in scored if c <= cutoff][:cap]


def _full_path(score_notes: list[dict], events: list[float], start: int) -> tuple:
    """Full-length pitch-only DTW from `start`; free end over remaining score.

    Returns (mean_cost, end_j, back) with end_j the 1-based column where the
    last audio event lands, or (inf, 0, None) when the remaining score cannot
    cover the excerpt (band-unreachable: correct rejection, not an error).
    """
    n = len(events)
    written = [float(note["pitchMidi"]) for note in score_notes[start:]]
    m = len(written)
    if m < 8:
        return float("inf"), 0, None
    band = max(4, n // 3)
    floor = max(4, n // 10)
    prev = np.full(m + 1, np.inf)
    prev[0] = 0.0
    back = np.zeros((n + 1, m + 1), dtype=np.uint8)
    for i, midi in enumerate(events, 1):
        row = np.full(m + 1, np.inf)
        lo = max(1, i - band)
        hi = min(m, i + band)
        for j in range(lo, hi + 1):
            diff = _pitch_diff(midi, written[j - 1])
            if i == 1 or j == 1:
                row[j] = prev[j - 1] + diff
                back[i, j] = 1
            else:
                options = (prev[j - 1] + diff, prev[j] + 1.25, row[j - 1] + .85)
                action = int(np.argmin(options))
                row[j] = options[action]
                back[i, j] = action + 1
        prev = row
    tail = prev[floor:]
    if not np.isfinite(tail).any():
        return float("inf"), 0, None
    end_j = int(np.argmin(tail)) + floor
    return float(prev[end_j]) / n, end_j, back


def _backtrack_pairs(back: np.ndarray, n: int, end_j: int) -> list:
    """Match moves (score_col_1based, event_idx_0based) from (n, end_j)."""
    pairs = []
    i, j = n, end_j
    while i > 0 and j > 0:
        action = int(back[i, j])
        if action == 1:
            pairs.append((j, i - 1))
            i -= 1
            j -= 1
        elif action == 2:
            i -= 1
        elif action == 3:
            j -= 1
        else:
            break
    pairs.reverse()
    return pairs


def _robust_line(qs: np.ndarray, ts: np.ndarray) -> tuple:
    """Theil-Sen-lite slope + median intercept; (slope, intercept) or (None, None)."""
    slopes = []
    for k in range(len(qs)):
        dq = qs[k + 1:] - qs[k]
        mask = dq >= 2.0
        if np.any(mask):
            slopes.append((ts[k + 1:][mask] - ts[k]) / dq[mask])
    if slopes:
        slope = float(np.median(np.concatenate(slopes)))
    elif qs[-1] - qs[0] >= 0.5:
        slope = float((ts[-1] - ts[0]) / (qs[-1] - qs[0]))
    else:
        return None, None
    intercept = float(np.median(ts - slope * qs))
    return slope, intercept


_PULSE_RATIOS = (0.5, 2.0 / 3.0, 1.0, 1.5, 2.0)


def _beat_ratio_ok(beat_map, slope: float) -> bool:
    """Unit-agnostic sanity: fitted sec/quarter vs beat interval pulse ratio.

    Returns True when the beat tracker is unusable (neutral) or the ratio is
    near a musical pulse ratio; the tracker's absolute unit is never assumed,
    so 4/4 quarter-pulse and 6/8 dotted-pulse grids both pass.
    """
    if not beat_map:
        return True
    beats = sorted(set(float(b) for b in beat_map if math.isfinite(float(b)) and float(b) >= 0))
    if len(beats) < 4:
        return True
    gaps = np.diff(beats)
    med = float(np.median(gaps))
    if not med > 0 or float(np.max(gaps)) > med * 2.5:
        return True
    ratio = slope / med
    return any(abs(ratio - x) / x <= 0.2 for x in _PULSE_RATIOS)


def align_excerpt(score_notes: list[dict], pitch_notes: list,
                  beat_map: list | None = None) -> dict:
    """Locate an excerpt's start AND end; derive its measure time map.

    Two stages: pitch-only prefix scan (no rigid beat ruler) keeps a few
    rival starts; full-length pitch-only paths re-score them, which separates
    repeated phrases the prefix alone cannot (distant rivals go band-inf).
    A robust global line audioSec = t0 + slope * scoreBeat over matched pairs
    yields the tempo; supported piecewise anchors supply the boundaries. Partial takes
    align partially: the end is where the audio ends, not the score.

    Fail-closed like locate_excerpt: unrelated audio or genuinely ambiguous
    repeats raise ValueError asking for an explicit start measure.
    """
    segments = usable_events(pitch_notes)
    events = [midi for _, _, midi in segments]
    n = len(events)
    if n < 8 or len(score_notes) < 8:
        raise ValueError("片段定位需要至少 8 个可靠的音高事件；请指定起始小节")
    stage1 = _prefix_candidates(score_notes, events)
    full = []
    for _, start in stage1:
        cost, end_j, back = _full_path(score_notes, events, start)
        if math.isfinite(cost):
            full.append((cost, start, end_j, back))
    if not full:
        raise ValueError("录音与乐谱不足以定位片段；请指定起始小节")
    full.sort(key=lambda r: r[0])
    best, index, end_j, back = full[0]
    distinct = max(3, n // 3)
    alternative = next((c for c, i, _, _ in full if abs(i - index) > distinct), float("inf"))
    tied = any(i != index and abs(c - best) <= 1e-8 for c, i, _, _ in full)
    if best > 0.90:
        raise ValueError("录音片段与乐谱不吻合；请指定起始小节")
    if alternative - best < 0.16 or tied:
        raise ValueError("重复乐句的起止位置无法区分；请指定起始小节")
    pairs = _backtrack_pairs(back, n, end_j)
    if not pairs:
        raise ValueError("录音片段与乐谱不吻合；请指定起始小节")
    matched_audio = {e for _, e in pairs}
    matched = [(index + sj - 1, e) for sj, e in pairs]
    end_index = max(s for s, _ in matched)
    qs = np.array([score_notes[s]["onsetBeat"] for s, _ in matched])
    ts = np.array([segments[e][0] for _, e in matched])
    slope, intercept = _robust_line(qs, ts)
    confident = True
    med_resid = float("inf")
    if slope is None or not 0.15 <= slope <= 2.0:
        confident = False
    else:
        med_resid = float(np.median(np.abs(ts - (intercept + slope * qs))))
        if med_resid > 0.60:
            confident = False
    if len(matched) < 8 or len(matched_audio) / n < 0.5:
        confident = False
    if confident and not _beat_ratio_ok(beat_map, slope):
        confident = False
    events_map = {s: segments[e] for s, e in matched}
    # Per-measure boundaries from matched note anchors (piecewise linear, robust
    # to local outliers). One global line drifts 0.5-3 s under rubato while the
    # residual gate still passes; the line now only supplies tempo/extrapolation.
    anchors = _time_anchors(qs, ts, slope)
    # Tail beyond the notation (score shorter than the take, e.g. a one-page
    # excerpt of a complete performance): keep the anchored prefix instead of
    # discarding the whole alignment. Only trailing pairs off the anchor line
    # are dropped; the boundary gate below still runs on the new edges.
    tail_trimmed_after = None
    if anchors and slope is not None and len(matched) >= 16:
        def _on_line(pair):
            s_, e_ = pair
            return abs(anchor_time(anchors, score_notes[s_]["onsetBeat"], slope) - segments[e_][0]) <= .60
        k = len(matched)
        while k > 0 and not _on_line(matched[k - 1]):
            k -= 1
        if 0 < k < len(matched) and k >= max(8, int(.5 * len(matched))) and _on_line(matched[0]):
            matched = matched[:k]
            end_index = max(s_ for s_, _ in matched)
            events_map = {s_: segments[e_] for s_, e_ in matched}
            tail_trimmed_after = round(float(segments[matched[-1][1]][0]), 3)
    by_measure: dict[int, float] = {}
    for s in range(index, end_index + 1):
        m = score_notes[s]["measure"]
        if m not in by_measure:
            by_measure[m] = score_notes[s]["onsetBeat"]
    if anchors:
        measure_times = [{"measure": m, "audioSec": round(anchor_time(anchors, ob, slope), 3)}
                         for m, ob in sorted(by_measure.items())]
    else:
        measure_times = [{"measure": m, "audioSec": round(intercept + slope * ob, 3)}
                         for m, ob in sorted(by_measure.items())] if slope is not None else []
    # A small median residual can hide a contradictory tail (e.g. incomplete
    # notation forced onto a complete recording). Never certify its boundaries
    # from the global line after the local anchors have rejected those events.
    # A take cut mid-note hides the first note's onset: when the anchors put
    # that note's start before the recording and the matched event lies inside
    # the note, the head edge cannot be checked rather than contradicting.
    def _edge_ok(s, e, head):
        at = anchor_time(anchors, score_notes[s]["onsetBeat"], slope)
        if abs(at - segments[e][0]) <= .60:
            return True
        end = anchor_time(anchors, score_notes[s]["onsetBeat"] + score_notes[s]["durationBeat"], slope)
        return head and at <= .05 and at <= segments[e][0] < end
    boundary_supported = bool(anchors) and slope is not None and \
        _edge_ok(*matched[0], True) and _edge_ok(*matched[-1], False)
    confident = confident and boundary_supported
    last = score_notes[end_index]
    end_audio = (round(anchor_time(anchors, last["onsetBeat"] + last["durationBeat"], slope), 3)
                 if boundary_supported else None)
    return {"start": index, "end": end_index, "cost": round(best, 3),
            "quarterPeriod": round(slope, 4) if slope is not None else None,
            "t0": round(intercept, 3) if slope is not None else None,
            "measureTimes": measure_times, "endAudioSec": end_audio,
            "events": events_map, "matched": len(matched),
            "coverage": round(len(matched_audio) / n, 3),
            "residualMs": None if med_resid == float("inf") else int(round(med_resid * 1000)),
            "confident": confident, "anchors": anchors,
            "boundarySupported": boundary_supported,
            "tailTrimmedAfterSec": tail_trimmed_after,
            "matchedStartSec": segments[matched[0][1]][0],
            "matchedEndSec": segments[matched[-1][1]][1]}


def _time_anchors(qs: np.ndarray, ts: np.ndarray, slope) -> list:
    """Monotone [scoreBeat, audioSec] anchors from matched pairs.

    Same-beat pairs collapse to their median time; points deviating from a
    local line through their +-3 neighbours (> max(0.12 s, 4x median)) are
    dropped; non-increasing times are skipped. Empty when < 2 anchors remain.
    """
    if slope is None or len(qs) == 0:
        return []
    q_all = np.asarray(qs, dtype=float)
    t_all = np.asarray(ts, dtype=float)
    q = np.unique(q_all)
    t = np.array([float(np.median(t_all[q_all == b])) for b in q])
    keep = np.ones(len(q), dtype=bool)
    for _ in range(2):
        idx = np.flatnonzero(keep)
        if len(idx) < 5:
            break
        qq, tt = q[idx], t[idx]
        dev = np.zeros(len(idx))
        for k in range(len(idx)):
            nb = [j for j in range(max(0, k - 3), min(len(idx), k + 4)) if j != k]
            a, b = np.polyfit(qq[nb], tt[nb], 1)
            dev[k] = tt[k] - (a * qq[k] + b)
        bad = np.abs(dev) > max(0.12, 4 * float(np.median(np.abs(dev))))
        if not bad.any():
            break
        keep[idx[bad]] = False
    out_q: list = []
    out_t: list = []
    for a, b in zip(q[keep], t[keep]):
        if out_t and b <= out_t[-1] + 1e-3:
            continue
        out_q.append(float(a))
        out_t.append(float(b))
    if len(out_q) < 2:
        return []
    return [[round(a, 4), round(b, 4)] for a, b in zip(out_q, out_t)]


def anchor_time(anchors: list, beat: float, slope: float):
    """Audio time of a score beat: interpolate anchors, extrapolate with slope."""
    if not anchors:
        return None
    q = [a for a, _ in anchors]
    t = [b for _, b in anchors]
    if beat <= q[0]:
        return t[0] + (beat - q[0]) * slope
    if beat >= q[-1]:
        return t[-1] + (beat - q[-1]) * slope
    return float(np.interp(beat, q, t))
