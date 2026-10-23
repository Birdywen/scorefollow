"""Per-tone intonation for double stops and chords (string-mono-0.26).

The score (XML) is the reference: every written chord tone is checked against its own
written pitch. Basic Pitch's frame-level note activation decides whether and when each
written tone sounds (rolled chords: the bass is often short and early); the pitch itself
is read from that tone's own harmonic partials in the spectrum, two passes:

1. each tone from partials that no other written tone can reach (+-70 cents);
2. with pass-1 pitches known, partials are predicted exactly, so a partial is usable
   whenever it is resolvable from the others (measured tones are masked at their
   predicted partials instead of excluding ours).

A tone an integer multiple above a lower chord tone (octave, twelfth, ...) shares every
partial with it and is reported as not separable, never guessed.

Research (2026-10-18, real cello notes mixed into dyads/triads, truth = solo reading):
median error ~1 cent, p90 <= 5 cents for 3rds..10ths and common triads; Basic Pitch
activation >= 0.3 separated played from unplayed upper tones (99.4% hit, 0% false),
while spectral evidence alone gave 5-13% false presence.
"""
import math

import numpy as np

BP_FPS = 22050 / 256          # Basic Pitch nominal frame rate
# 0.30: Basic Pitch stitches 2 s windows of 172 frames that each cover ~10 ms less
# audio than 172 hops, so frame k is NOT k / BP_FPS: it runs ~0.5% late (0.44 s
# at 100 s). Same mapping as basic_pitch.note_creation.model_frames_to_time.
BP_HOP_SEC = 256 / 22050
BP_WINDOW_FRAMES = 172
BP_WINDOW_OFFSET = BP_HOP_SEC * (BP_WINDOW_FRAMES - (22050 * 2 - 256) / 256) + 0.0018


def bp_frame_time(k):
    """Audio second of Basic Pitch frame k."""
    return k * BP_HOP_SEC - BP_WINDOW_OFFSET * math.floor(k / BP_WINDOW_FRAMES)


def bp_time_frame(t):
    """Basic Pitch frame (float) at audio second t; inverse of bp_frame_time."""
    w = math.floor(max(0.0, t) / (BP_WINDOW_FRAMES * BP_HOP_SEC - BP_WINDOW_OFFSET))
    return (t + BP_WINDOW_OFFSET * w) / BP_HOP_SEC
BP_ACTIVE = 0.3               # note activation counted as sounding
MIN_SOUND_SEC = 0.10          # shorter runs are not a played tone
ROLL_SEC = 0.40               # rolled-chord bass may start this early
HARMONIC_INTERVALS = (12, 19, 24, 31, 36)
SEARCH_CENTS = 70.0
REFINE_CENTS = 20.0
PARTIALS = 10
MAX_PARTIAL_HZ = 5000.0


def _hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def _midi(f):
    return 69 + 12 * math.log2(f / 440.0)


def sounding_run(act, m, lo, hi):
    """Longest run (lo_sec, hi_sec) where key m is active inside [lo, hi], else None."""
    if act is None or not 21 <= int(m) <= 108:
        return None
    a, b = max(0, int(bp_time_frame(lo))), min(len(act), int(math.ceil(bp_time_frame(hi))))
    if b <= a:
        return None
    on = np.concatenate([[False], act[a:b, int(m) - 21] >= BP_ACTIVE, [False]])
    edges = np.flatnonzero(np.diff(on.astype(np.int8)))
    if not len(edges):
        return None
    starts, ends = edges[0::2], edges[1::2]
    k = int(np.argmax(ends - starts))
    return bp_frame_time(a + starts[k]), bp_frame_time(a + ends[k])


def buried(m, tones):
    return any(m - o in HARMONIC_INTERVALS for o in tones if o < m)


def _unshared(f0, others, k, guard_cents, res):
    f = k * f0
    for o in others:
        fo = _hz(o)
        j = max(1, round(f / fo))
        if abs(f - j * fo) <= f * (2 ** (guard_cents / 1200) - 1) + 1.5 * res:
            return False
    return True


def harmonic_cents(x, rate, m, lo, hi, others=(), center=None, search_cents=SEARCH_CENTS, mask=None):
    """Pitch of the tone written at m from its partials, as cents vs m, or None.
    others: tones (MIDI, may be measured) whose partials make ours unusable;
    mask: measured tones whose exact partial positions are blanked instead."""
    a, b = max(0, int(lo * rate)), min(len(x), int(hi * rate))
    if b - a < int(0.08 * rate):
        return None
    seg = np.asarray(x[a:b], dtype=np.float64)
    win = 8192 if len(seg) >= 1.2 * 8192 else min(4096, len(seg))
    hop = max(1, win // 4)
    n = 1 << int(math.ceil(math.log2(win * 8)))
    freqs = np.arange(n // 2 + 1) * rate / n
    res = rate / win
    f0 = _hz(m if center is None else center)
    top_hz = min(MAX_PARTIAL_HZ, rate / 2 - 1)
    if mask is None:
        ks = [k for k in range(1, PARTIALS + 1) if k * f0 < top_hz and _unshared(f0, others, k, search_cents, res)]
        blocked = None
    else:
        ks = [k for k in range(1, PARTIALS + 1) if k * f0 < top_hz]
        blocked = np.zeros(len(freqs), bool)
        for o in mask:
            fo = _hz(o)
            for j in range(1, int(top_hz / fo) + 2):
                rad = 1.5 * res + j * fo * (2 ** (8 / 1200) - 1)
                i0, i1 = np.searchsorted(freqs, [j * fo - rad, j * fo + rad])
                blocked[i0:i1] = True
    if len(ks) < 2:
        return None
    band = (freqs > 50) & (freqs < top_hz)
    hann = np.hanning(win)
    frames = []
    for s in range(0, len(seg) - win + 1, hop) or [0]:
        fr = seg[s:s + win]
        db = 20 * np.log10(np.abs(np.fft.rfft((fr - fr.mean()) * hann, n=n)) + 1e-12)
        floor = float(np.median(db[band]))
        need = max(floor + 15, float(db[band].max()) - 50)
        est, wt = [], []
        for k in ks:
            c = k * f0
            sel = np.flatnonzero(np.abs(freqs - c) <= max(c * (2 ** (search_cents / 1200) - 1), 1.5 * res))
            if blocked is not None:
                sel = sel[~blocked[sel]]
            if len(sel) < 3:
                continue
            i = int(sel[np.argmax(db[sel])])
            if db[i] < need or i in (sel[0], sel[-1]) or db[i] < db[i - 1] or db[i] < db[i + 1]:
                continue
            l, cc, r = db[i - 1], db[i], db[i + 1]
            d = l - 2 * cc + r
            off = max(-0.5, min(0.5, 0.5 * (l - r) / d)) if abs(d) > 1e-9 else 0.0
            est.append(_midi((i + off) * rate / n / k))
            wt.append(db[i] - floor)
        if len(est) >= 2:
            est, wt = np.array(est), np.array(wt)
            keep = np.abs(est - np.median(est)) <= 0.25
            if keep.sum() >= 2:
                frames.append(float(np.average(est[keep], weights=wt[keep])))
    if not frames:
        return None
    return round((float(np.median(frames)) - m) * 100, 1)


def chord_cents(x, rate, tones, lo, hi):
    """{tone: cents or None} for all written tones over one window (two passes)."""
    tones = list(tones)
    p1 = {m: harmonic_cents(x, rate, m, lo, hi, [o for o in tones if o != m]) for m in tones}
    cur = {m: m + (p1[m] / 100 if p1[m] is not None else 0.0) for m in tones}
    out = {}
    for m in tones:
        if buried(m, tones):
            out[m] = None
            continue
        known = p1[m] is not None
        reach = REFINE_CENTS if known else 45.0
        e = harmonic_cents(x, rate, m, lo, hi, [cur[o] for o in tones if o != m], cur[m], reach)
        if e is None and all(p1[o] is not None for o in tones if o != m):
            e = harmonic_cents(x, rate, m, lo, hi, (), cur[m], reach, mask=[cur[o] for o in tones if o != m])
        out[m] = e if e is not None else p1[m]
    return out


def measure_chord(x, rate, act, tones, on, end):
    """Per written tone: {"midi", "cents", "state"}; state is measured / missing (not played) /
    unchecked (cut by the recording edge) / inseparable (octave-type) / unmeasured."""
    out = []
    for m in tones:
        lo = max(0.0, on - ROLL_SEC)
        run = sounding_run(act, m, lo, end)
        if run is None or run[1] - run[0] < MIN_SOUND_SEC:
            state = "unchecked" if on - ROLL_SEC < 0.05 or end > len(x) / rate - 0.05 else "missing"
            out.append({"midi": m, "cents": None, "state": state})
            continue
        if buried(m, tones):
            out.append({"midi": m, "cents": None, "state": "inseparable"})
            continue
        a, b = run
        cents = chord_cents(x, rate, tones, a + max(0.05, 0.25 * (b - a)), b - 0.15 * (b - a))[m]
        out.append({"midi": m, "cents": cents, "state": "measured" if cents is not None else "unmeasured"})
    return out
