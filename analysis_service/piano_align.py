"""Tempo-free polyphonic alignment of a piano score to transcribed note events.

1. Score notes -> onset groups (same onsetBeat); performance notes -> onset clusters.
2. Global sequence alignment of groups vs clusters (pitch-set similarity, gaps allowed),
   so tempo changes, missed or extra chords and an unknown start do not break it.
3. Matched groups give (beat, sec) anchors -> outlier-cleaned monotone tempo map.
4. Per-pitch monotone note matching around the tempo map; leftover pairs nearby = wrong notes.
"""
from dataclasses import dataclass

import numpy as np

CLUSTER_GAP_SEC = 0.035   # onsets closer than this belong to one strike
CLUSTER_MAX_SEC = 0.09    # ...but a cluster never spans more than this
GAP_SCORE = -0.45         # skipping a score group (per group)
GAP_PERF = -0.25          # skipping a performance cluster (extras, ghosts)
MIN_TEMPO_ANCHORS = 6     # fewer matched groups: use the requested BPM instead of the take's tempo


@dataclass
class TempoMap:
    beats: np.ndarray
    secs: np.ndarray
    spb: float = 0.5  # seconds per beat used when there is a single anchor

    def __call__(self, beat):
        b, s = self.beats, self.secs
        if len(b) == 1:
            return s[0] + (np.asarray(beat, dtype=float) - b[0]) * self.spb
        x = np.asarray(beat, dtype=float)
        y = np.interp(x, b, s)
        lo_slope = (s[1] - s[0]) / (b[1] - b[0])
        hi_slope = (s[-1] - s[-2]) / (b[-1] - b[-2])
        y = np.where(x < b[0], s[0] + (x - b[0]) * lo_slope, y)
        return np.where(x > b[-1], s[-1] + (x - b[-1]) * hi_slope, y)

    def sec_per_beat(self, beat) -> float:
        h = 1.0
        return float(max(1e-3, (self(beat + h) - self(beat - h)) / (2 * h)))


def score_groups(notes):
    groups, index = [], {}
    for k, n in enumerate(notes):
        b = round(n["onsetBeat"], 4)
        if b not in index:
            index[b] = len(groups)
            groups.append({"beat": n["onsetBeat"], "notes": []})
        groups[index[b]]["notes"].append(k)
    return groups


def perf_clusters(perf):
    clusters, cur = [], []
    for k, (on, _off, _p, _v) in enumerate(perf):
        if cur and (on - perf[cur[-1]][0] > CLUSTER_GAP_SEC or on - perf[cur[0]][0] > CLUSTER_MAX_SEC):
            clusters.append(cur); cur = []
        cur.append(k)
    if cur:
        clusters.append(cur)
    return clusters


def _sim_matrix(notes, groups, perf, clusters):
    S = np.zeros((len(groups), 128), np.float32)
    for i, g in enumerate(groups):
        for k in g["notes"]:
            S[i, notes[k]["pitchMidi"]] = 1
    P = np.zeros((len(clusters), 128), np.float32)
    for j, c in enumerate(clusters):
        for k in c:
            P[j, int(round(perf[k][2]))] = 1
    inter = S @ P.T
    return 2 * inter / (S.sum(1)[:, None] + P.sum(1)[None, :])  # Dice


def align_groups(sim, free_score_start: bool):
    """Semi-global alignment. Leading/trailing performance clusters are free (silence, noise,
    passage outside the excerpt); trailing score groups are free (take stopped early); leading
    score groups are free only when the start position is unknown. Returns [(i, j)] pairs."""
    n, m = sim.shape
    reward = np.where(sim > 0, 2.0 * sim - 0.6, -1.0)
    H = np.full((n + 1, m + 1), -np.inf)
    H[0, :] = 0.0
    H[:, 0] = 0.0 if free_score_start else GAP_SCORE * np.arange(n + 1)
    ptr = np.zeros((n + 1, m + 1), np.int8)  # 1 diag, 2 up (skip score), 3 left (skip perf)
    ptr[1:, 0] = 2
    ptr[0, 1:] = 3
    cols = np.arange(m + 1)
    for i in range(1, n + 1):
        diag = H[i - 1, :-1] + reward[i - 1]
        up = H[i - 1, 1:] + GAP_SCORE
        a = np.maximum(diag, up)
        choice = np.where(diag >= up, 1, 2).astype(np.int8)
        full = np.concatenate(([H[i, 0]], a))
        # left gaps: H[i,j] = max_k<=j (full[k] + GAP_PERF*(j-k))
        run = np.maximum.accumulate(full - GAP_PERF * cols) + GAP_PERF * cols
        H[i, 1:] = run[1:]
        ptr[i, 1:] = np.where(run[1:] > a + 1e-9, 3, choice)
    # end: any j (trailing perf free), any i (trailing score free)
    i, j = np.unravel_index(int(np.argmax(H[:, :])), H.shape)
    pairs = []
    while i > 0 and j > 0:
        p = ptr[i, j]
        if p == 1:
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif p == 2:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


def tempo_map(anchors, spb: float = 0.5) -> TempoMap:
    """anchors: [(beat, sec)] sorted by beat. Drops points that break local tempo, keeps monotone."""
    a = np.array(sorted(anchors), dtype=float)
    keep = np.ones(len(a), bool)
    for _ in range(3):
        idx = np.where(keep)[0]
        if len(idx) < 4:
            break
        b, s = a[idx, 0], a[idx, 1]
        bad = np.zeros(len(idx), bool)
        for t in range(len(idx)):
            w = (np.abs(b - b[t]) <= 4) & (np.arange(len(idx)) != t)
            if w.sum() < 3:
                continue
            A = np.vstack([b[w] - b[t], np.ones(w.sum())]).T
            coef = np.linalg.lstsq(A, s[w], rcond=None)[0]
            slope = max(coef[0], 0.05)
            bad[t] = abs(s[t] - coef[1]) > max(0.12, 0.6 * slope)
        if not bad.any():
            break
        keep[idx[bad]] = False
    a = a[keep]
    # strictly increasing in both axes (longest monotone chain, greedy from the median slope)
    out = [a[0]]
    for b, s in a[1:]:
        if b > out[-1][0] + 1e-6 and s > out[-1][1] + 0.01:
            out.append((b, s))
    out = np.array(out)
    return TempoMap(out[:, 0], out[:, 1], spb)


def smooth_map(tm: TempoMap, half_window_beats: float) -> TempoMap:
    """Local-linear smoothing: the 'intended' tempo, so residuals are rhythm, not rubato."""
    b, s = tm.beats, tm.secs
    if len(b) < 4:
        return tm
    out = np.empty_like(s)
    for t in range(len(b)):
        w = np.abs(b - b[t]) <= half_window_beats
        if w.sum() < 3:
            out[t] = s[t]; continue
        A = np.vstack([b[w] - b[t], np.ones(w.sum())]).T
        out[t] = np.linalg.lstsq(A, s[w], rcond=None)[0][1]
    for t in range(1, len(out)):  # keep monotone
        out[t] = max(out[t], out[t - 1] + 1e-3)
    return TempoMap(b, out, tm.spb)


def match_notes(notes, perf, tm: TempoMap, lo_sec: float, hi_sec: float):
    """Per pitch, monotone DP between score occurrences and performed onsets.
    Returns match: score index -> perf index."""
    exp = tm(np.array([n["onsetBeat"] for n in notes]))
    win = np.array([min(0.4, max(0.12, 0.5 * tm.sec_per_beat(n["onsetBeat"]))) for n in notes])
    by_pitch_s, by_pitch_p = {}, {}
    for k, n in enumerate(notes):
        by_pitch_s.setdefault(n["pitchMidi"], []).append(k)
    for k, (on, _o, p, _v) in enumerate(perf):
        if lo_sec <= on <= hi_sec:
            by_pitch_p.setdefault(int(round(p)), []).append(k)
    match = {}
    for pitch, ss in by_pitch_s.items():
        ps = by_pitch_p.get(pitch, [])
        if not ps:
            continue
        ss = sorted(ss, key=lambda k: exp[k])
        n_s, n_p = len(ss), len(ps)
        D = np.zeros((n_s + 1, n_p + 1))
        D[:, 0] = np.arange(n_s + 1) * 1.0
        D[0, :] = np.arange(n_p + 1) * 1.0
        P = np.zeros((n_s + 1, n_p + 1), np.int8)
        for i in range(1, n_s + 1):
            e, w = exp[ss[i - 1]], win[ss[i - 1]]
            for j in range(1, n_p + 1):
                dt = abs(perf[ps[j - 1]][0] - e)
                best, ch = D[i - 1, j] + 1.0, 2          # score note missed
                if D[i, j - 1] + 1.0 < best:
                    best, ch = D[i, j - 1] + 1.0, 3      # performed note unused
                # equal timing: the stronger strike wins (pedal blur doubles are weak)
                cost = dt / w - 1e-3 * perf[ps[j - 1]][3] / 127
                if dt <= w and D[i - 1, j - 1] + cost < best:
                    best, ch = D[i - 1, j - 1] + cost, 1
                D[i, j], P[i, j] = best, ch
        i, j = n_s, n_p
        while i > 0 and j > 0:
            if P[i, j] == 1:
                match[ss[i - 1]] = ps[j - 1]; i -= 1; j -= 1
            elif P[i, j] == 2:
                i -= 1
            else:
                j -= 1
    return match, exp, win


def fill_gaps(notes, groups, perf, match, exp, lo_sec, hi_sec):
    """An unmatched note may still have been played, just off the tempo map (ritardando, fermata,
    OMR rhythm error). Look between the neighbouring matched groups for an unused same-pitch onset."""
    used = set(match.values())
    g_time = []
    for g in groups:
        t = [perf[match[k]][0] for k in g["notes"] if k in match]
        g_time.append(float(np.median(t)) if t else None)
    known = [i for i, t in enumerate(g_time) if t is not None]
    if not known:
        return match
    by_pitch = {}
    for k, (on, _o, p, _v) in enumerate(perf):
        if k not in used and lo_sec - 2 <= on <= hi_sec + 3:
            by_pitch.setdefault(int(round(p)), []).append(k)
    for gi, g in enumerate(groups):
        if g_time[gi] is not None:  # group partly matched: stay near its own time
            lo, hi = g_time[gi] - 0.15, g_time[gi] + 0.15
        else:
            prev = max((i for i in known if i < gi), default=None)
            nxt = min((i for i in known if i > gi), default=None)
            lo = g_time[prev] + 0.02 if prev is not None else g_time[nxt] - 2.0
            hi = g_time[nxt] - 0.02 if nxt is not None else g_time[prev] + 3.0
        for k in g["notes"]:
            if k in match:
                continue
            cands = [c for c in by_pitch.get(notes[k]["pitchMidi"], []) if c not in used and lo <= perf[c][0] <= hi]
            if cands:
                c = min(cands, key=lambda c: abs(perf[c][0] - exp[k]))
                match[k] = c
                used.add(c)
    return match


def pair_wrong_notes(notes, perf, match, exp, win, lo_sec, hi_sec):
    """Unmatched score note + unmatched performed note at about the same time, within a 3rd: wrong note."""
    used = set(match.values())
    free_p = [k for k, (on, _o, _p, _v) in enumerate(perf) if k not in used and lo_sec <= on <= hi_sec]
    wrong = {}
    cands = []
    for s in range(len(notes)):
        if s in match:
            continue
        for k in free_p:
            dp = abs(int(round(perf[k][2])) - notes[s]["pitchMidi"])
            dt = abs(perf[k][0] - exp[s])
            if 0 < dp <= 4 and dt <= 0.6 * win[s]:
                cands.append((dt / win[s] + 0.1 * dp, s, k))
    taken_p = set()
    for _c, s, k in sorted(cands):
        if s not in wrong and k not in taken_p:
            wrong[s] = k; taken_p.add(k)
    return wrong


def align(notes, perf, free_score_start: bool, sec_per_beat: float = 0.5):
    """Full alignment. perf: [(onset, offset, midi, vel)] sorted by onset.
    sec_per_beat (from the requested BPM) only extrapolates when there are too few anchors."""
    groups = score_groups(notes)
    clusters = perf_clusters(perf)
    if not groups or not clusters:
        raise ValueError("没有可对齐的音符")
    sim = _sim_matrix(notes, groups, perf, clusters)
    pairs = align_groups(sim, free_score_start)
    anchors = []
    for i, j in pairs:
        if sim[i, j] < 0.5:
            continue
        gp = {notes[k]["pitchMidi"] for k in groups[i]["notes"]}
        ons = [perf[k][0] for k in clusters[j] if int(round(perf[k][2])) in gp]
        anchors.append((groups[i]["beat"], float(np.median(ons))))
    if not anchors:
        raise ValueError("录音与谱面对不上：找不到共同的音")
    if len(anchors) < MIN_TEMPO_ANCHORS:
        # Too little evidence to infer the tempo from the take: requested BPM from the first anchor.
        tm = TempoMap(np.array([anchors[0][0]]), np.array([anchors[0][1]]), sec_per_beat)
    else:
        tm = tempo_map(anchors, sec_per_beat)
    # Matching is bounded per note by the tempo map; the whole take is searchable.
    lo_sec = min(tm.secs[0] - 1.0, perf[0][0])
    hi_sec = max(tm.secs[-1] + 1.0, perf[-1][0])
    first_beat, last_beat = tm.beats[0], tm.beats[-1]
    match, exp, win = match_notes(notes, perf, tm, lo_sec, hi_sec)
    match = fill_gaps(notes, groups, perf, match, exp, lo_sec, hi_sec)
    wrong = pair_wrong_notes(notes, perf, match, exp, win, lo_sec, hi_sec)
    return {"tempo": tm, "match": match, "wrong": wrong, "expected": exp, "window": win,
            "groups": groups, "clusters": clusters, "pairs": pairs, "anchors": anchors,
            "span": (first_beat, last_beat), "window_sec": (lo_sec, hi_sec)}
