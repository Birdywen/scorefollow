"""Audio evidence for the piano channel: the instrument's tuning, and "was this key struck here?".

The transcriber is the main sensor. Where it disagrees with the score (a missed, wrong or extra
note) this module re-reads the recording itself. Two spectral cues, calibrated on every take
against its own agreed notes, decide how likely a key was struck:
- salience: a peak at the key's partials standing above the spectrum 45–75 cents either side;
- gain: that peak growing across the onset (needed when the same key still rings from before).
"""
import io
import wave

import numpy as np

FFT = 8192            # 186 ms at 44.1 kHz: resolves semitones down to the bass
PAD = 2
PRE_SEC, POST_SEC = 0.10, 0.10   # frame centres before / after an onset
RINGING_SEC = 3.0     # the same key struck this recently may still sound (pedal)
MIN_TRAIN = 30
MIN_AUC = 0.75        # below this the audio cannot tell struck from unstruck keys: not used


def hz(midi: float, ref_cents: float = 0.0) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12 + ref_cents / 1200)


class Spectra:
    """Magnitude spectra on demand, cached per 1 ms of onset time."""

    def __init__(self, signal: np.ndarray, rate: int, ref_cents: float = 0.0):
        self.sig, self.rate, self.ref = np.asarray(signal, dtype=float), rate, ref_cents
        self.n = min(FFT, 1 << int(np.log2(max(1024, rate * 0.186))))
        self.win = np.hanning(self.n)
        self.scale = PAD * self.n / rate  # bins per Hz
        self.cache: dict = {}

    def frame(self, t: float) -> np.ndarray:
        key = round(t, 3)
        spec = self.cache.get(key)
        if spec is None:
            a = int(t * self.rate) - self.n // 2
            seg = np.zeros(self.n)
            lo, hi = max(0, a), min(len(self.sig), a + self.n)
            if hi > lo:
                seg[lo - a:hi - a] = self.sig[lo:hi]
            spec = self.cache[key] = np.abs(np.fft.rfft(seg * self.win, PAD * self.n))
        return spec

    def band(self, spec, f, c0, c1) -> float:
        k0 = int(f * 2 ** (c0 / 1200) * self.scale)
        k1 = int(np.ceil(f * 2 ** (c1 / 1200) * self.scale)) + 1
        if k0 >= len(spec):
            return 0.0
        return float(spec[k0:min(len(spec), max(k1, k0 + 1))].max())

    def features(self, midi: int, t: float) -> tuple[float, float]:
        """(salience, gain) in log units over the first five partials below 6 kHz: mean salience (a
        struck key lights up all its partials, a chance overlap only some), median gain."""
        f0 = hz(midi, self.ref)
        pre, post = self.frame(t - PRE_SEC), self.frame(t + POST_SEC)
        floor = post.max() * 1e-4 + 1e-9
        sal, gain = [], []
        for k in range(1, 6):
            f = k * f0
            if f > 6000 or f * 2 ** (75 / 1200) * self.scale >= len(post):
                break
            p = self.band(post, f, -25, 25)
            side = 0.5 * (self.band(post, f, -75, -45) + self.band(post, f, 45, 75))
            sal.append(np.log((p + floor) / (side + floor)))
            gain.append(np.log((p + floor) / (self.band(pre, f, -25, 25) + floor)))
        if not sal:
            return 0.0, 0.0
        return float(np.mean(sal)), float(np.median(gain))

    def peak_cents(self, midi: int, t: float) -> tuple[float | None, float]:
        """Fundamental peak within ±40 cents of the key (at the take's reference), in cents, + salience."""
        f = hz(midi, self.ref)
        spec = self.frame(t)
        k0, k1 = int(f * 2 ** (-40 / 1200) * self.scale), int(np.ceil(f * 2 ** (40 / 1200) * self.scale))
        if k1 + 2 >= len(spec) or k0 < 2:
            return None, 0.0
        k = k0 + int(np.argmax(spec[k0:k1 + 1]))
        if k <= k0 or k >= k1:
            return None, 0.0
        a, b, c = np.log(spec[k - 1:k + 2] + 1e-12)
        den = a - 2 * b + c
        if den >= 0:
            return None, 0.0
        d = 0.5 * (a - c) / den
        fp = (k + d) / self.scale  # sides relative to the peak itself, so a detuned key isn't penalised
        side = 0.5 * (spec[int(fp * 2 ** (-60 / 1200) * self.scale)] + spec[int(fp * 2 ** (60 / 1200) * self.scale)])
        return 1200 * float(np.log2(fp / f)), float(np.log(spec[k] / (side + 1e-12)))


def blind_tuning(signal: np.ndarray, rate: int) -> tuple[float, float]:
    """Offset of the instrument from A440 equal temperament, in cents within ±50, without the score:
    strong spectral peaks folded onto the semitone grid (weighted circular mean). Also returns the
    concentration (0–1); low means no stable pitched content."""
    sp = Spectra(signal, rate)
    dur = len(signal) / rate
    angles, weights = [], []
    for t in np.linspace(0.5, max(0.5, dur - 0.5), int(min(400, max(1, dur * 2)))):
        spec = sp.frame(t)[: int(4000 * sp.scale)]
        if len(spec) < 40 or spec.max() <= 1e-6:
            continue
        idx = np.argpartition(spec, -30)[-30:]
        for k in idx:
            if not (2 <= k < len(spec) - 1 and spec[k] > spec[k - 1] and spec[k] > spec[k + 1]):
                continue
            a, b, c = np.log(spec[k - 1:k + 2] + 1e-12)
            den = a - 2 * b + c
            if den >= -1e-9:
                continue
            f = (k + 0.5 * (a - c) / den) / sp.scale
            if f < 80:
                continue
            angles.append(2 * np.pi * 12 * np.log2(f / 440.0))
            weights.append(spec[k])
    if not weights:
        return 0.0, 0.0
    w = np.array(weights)
    z = np.sum(w * np.exp(1j * np.array(angles)))
    return float(np.angle(z) / (2 * np.pi) * 100), float(abs(z) / w.sum())


def retune(signal: np.ndarray, rate: int, cents: float) -> tuple[np.ndarray, float]:
    """Resample so every pitch moves by `cents`. Returns (signal, ratio); a time t in the new signal
    is t * ratio in the original."""
    r = 2 ** (cents / 1200)
    x = np.arange(0, len(signal) - 1, r)
    return np.interp(x, np.arange(len(signal)), signal), r


def wav_bytes(signal: np.ndarray, rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes((np.clip(signal, -1, 1) * 32767).astype("<i2").tobytes())
    return out.getvalue()


def _logistic(X: np.ndarray, y: np.ndarray):
    """2-feature logistic regression (IRLS with a small ridge). Returns (mean, std, weights)."""
    mu, sd = X.mean(0), X.std(0) + 1e-6
    Z = np.hstack([(X - mu) / sd, np.ones((len(X), 1))])
    w = np.zeros(Z.shape[1])
    for _ in range(30):
        p = 1 / (1 + np.exp(-Z @ w))
        g = Z.T @ (p - y) + 1e-2 * w
        H = (Z * (p * (1 - p))[:, None]).T @ Z + 1e-2 * np.eye(len(w))
        w -= np.linalg.solve(H, g)
    return mu, sd, w


def _auc(pos, neg) -> float:
    pos, neg = np.asarray(pos), np.asarray(neg)
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


class StrikeModel:
    """P(key struck at t), calibrated on this take: agreed notes are positives; keys nobody played
    at those moments (and keys still ringing from an earlier strike) are negatives."""

    def __init__(self, spectra: Spectra, perf, used: list[int]):
        self.sp = spectra
        self.on = np.array([e[0] for e in perf])
        self.pitch = np.array([int(round(e[2])) for e in perf])
        self.models: dict = {}
        self.auc: dict = {}
        rng = np.random.default_rng(0)
        used = sorted(used)
        if len(used) > 600:
            used = sorted(rng.choice(used, 600, replace=False))
        data = {"fresh": ([], []), "ringing": ([], [])}
        for j in used:
            t, p = self.on[j], self.pitch[j]
            data["ringing" if self.ringing(p, t) else "fresh"][0].append(self.sp.features(p, t))
            # Negative: a nearby key nobody struck lately, like a written note the player left out.
            busy = set(self.pitch[np.abs(self.on - t) < 0.5]) | set(self.pitch[(self.on < t) & (self.on > t - RINGING_SEC)])
            cands = [p + d for d in (3, -3, 4, -4, 5, -5, 2, -2) if p + d not in busy and 21 <= p + d <= 108]
            if cands:
                data["fresh"][1].append(self.sp.features(int(rng.choice(cands)), t))
            later = self.on[(self.on > t + 0.25) & (self.on < t + 2.5)]
            if len(later) and not np.any((self.pitch == p) & (np.abs(self.on - later[0]) < 0.2)):
                data["ringing"][1].append(self.sp.features(p, later[0]))
        for kind, (pos, neg) in data.items():
            if len(pos) < MIN_TRAIN or len(neg) < MIN_TRAIN:
                continue
            X = np.array(pos + neg)
            y = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
            mu, sd, w = _logistic(X, y)
            score = np.hstack([(X - mu) / sd, np.ones((len(X), 1))]) @ w
            self.auc[kind] = round(_auc(score[:len(pos)], score[len(pos):]), 3)
            if self.auc[kind] >= MIN_AUC:
                self.models[kind] = (mu, sd, w)

    def ringing(self, midi: int, t: float) -> bool:
        return bool(np.any((self.pitch == midi) & (self.on < t - 0.05) & (self.on > t - RINGING_SEC)))

    def prob(self, midi: int, t: float) -> float | None:
        """None when this take's audio cannot decide for this kind of note."""
        model = self.models.get("ringing" if self.ringing(midi, t) else "fresh")
        if model is None:
            return None
        mu, sd, w = model
        z = np.r_[(np.array(self.sp.features(midi, t)) - mu) / sd, 1.0] @ w
        return float(1 / (1 + np.exp(-z)))


def measure_tuning(spectra: Spectra, events) -> dict | None:
    """events: [(midi, onset, offset)] of notes the score and transcription agree on. Per key, the
    median fundamental deviation; a straight line over octaves is the stretch (normal for pianos);
    keys far off that line are out of tune."""
    dev: dict = {}
    for m, on, off in events:
        if m < 40 or m > 100 or off - on < 0.12:
            continue
        c, sal = spectra.peak_cents(m, on + 0.12)
        if c is not None and sal > 1.5:
            dev.setdefault(m, []).append(c)
    keys = sorted(k for k, v in dev.items() if len(v) >= 2)
    if len(keys) < 6:
        return None
    med = np.array([np.median(dev[k]) for k in keys])
    x = (np.array(keys) - 69) / 12.0
    keep = np.ones(len(keys), bool)
    for _ in range(3):  # robust line: drop clearly detuned keys, refit
        A = np.vstack([x[keep], np.ones(keep.sum())]).T
        slope, icpt = np.linalg.lstsq(A, med[keep], rcond=None)[0]
        resid = med - (slope * x + icpt)
        new = np.abs(resid) <= max(8.0, 3 * float(np.median(np.abs(resid[keep]))))
        if (new == keep).all() or new.sum() < 4:
            break
        keep = new
    spread = float(np.median(np.abs(resid)))
    off_keys = [{"midi": int(k), "cents": round(float(r), 1), "strikes": len(dev[k])}
                for k, r in zip(keys, resid) if abs(r) > 10]
    mild = int(sum(6 < abs(r) <= 10 for r in resid))
    score = round(max(0.0, min(100.0, 100 - 5 * max(0.0, spread - 2) - 4 * len(off_keys) - mild)))
    return {"offsetCents": round(float(icpt), 1), "stretchCentsPerOctave": round(float(slope), 1),
            "spreadCents": round(spread, 1), "measuredKeys": len(keys),
            "outOfTuneKeys": sorted(off_keys, key=lambda k: -abs(k["cents"]))[:12],
            "tuningScore": int(score)}
