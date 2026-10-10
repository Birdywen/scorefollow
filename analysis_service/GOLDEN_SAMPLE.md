# ScoreFollow scoring golden sample

Deterministic regression for scoring accuracy: synthetic audio with declared
ground truth, fixed tolerances, no external recordings and no network.

## Fixtures (`analysis_service/golden_fixtures.py`)

Synthesis is in-process with `numpy` + `wave` only. No ffmpeg, no network,
no checked-in binaries. `RANDOM_SEED = 42` is set on every build; synthesis
is closed-form (no RNG draws) so output is bit-deterministic.

Score: A4 B4 C5 D5 E5, one quarter note per measure, 60 bpm
(`NOTE_SPACING_SEC = 1.0`), first onset at 0.12 s, note length 0.78 s,
22050 Hz mono 16-bit PCM.

Ground truth is declared in the fixture (note ids, score pitches, score and
performed onset seconds), never derived from engine output:

1. **clean** — in-tune, on-time. `performedOnset == scoreOnset` for all notes.
2. **detuned** — note `n3` (C5) rendered +60 cents sharp (`DETUNE_CENTS`).
   Score pitch stays 72; the deviation is in the performance.
3. **late** — note `n3` rendered +200 ms late (`LATE_OFFSET_MS`). Score onset
   stays nominal; the deviation is in the performance.
4. **long** — 24 in-tune, on-time notes (~24.25 s, pitches cycle the same
   five score pitches). Exists so the real vamp chain has enough audio for
   the QM BarBeatTracker to lock; see Degraded below.

Each builder returns `{name, wav, xml, bpm, instrument, ground_truth}` plus
the variant's target note id and offset. Tests call the real scoring path
`analysis_service.engine.analyze(wav, xml, bpm, instrument)` in legacy
builtin mode (no `pitch_notes` / `onset_hint` / `beat_map`).

## Tolerances (named constants in `test_golden_scoring.py`)

| Constant | Value | Why |
|---|---|---|
| `PITCH_CENTS_TOL` | 10.0 c | ~93 ms Hann + parabolic lag interp jitters ~1 c on pure sines (measured); 10 c covers it while a 60 c detune stays 4x above the 15 c correct/sharp boundary. |
| `TIMING_MS_TOL` | 40 ms | ~12 ms hop + envelope attack + drift-median alignment; clean probes err <= 13 ms, late probe errs ~9 ms. 40 ms covers jitter yet stays below the 80 ms correct/late boundary (clean 13+40 < 80 < 200-40). |
| `CLEAN_PITCH_SCORE_MIN` | 95 | Builtin scores 100 on pure sines; 95 allows float/BLAS wobble without hiding a regression (one 60 c wrong note already drops to 89). |
| `CLEAN_RHYTHM_SCORE_MIN` | 90 | Clean measures 96; 90 allows jitter while the late variant (91) stays separable via the strict ordering assertion. |
| `DETUNE_PITCH_DROP_MIN` | 5 | One 60 c wrong note drops pitchScore 100 -> 89 (delta 11); requiring >= 5 proves the penalty without overfitting the number. |
| `LATE_ACCURACY_DROP_MIN` | 5 | One 200 ms late note drops timingAccuracy 96 -> 77 (delta 19); requiring >= 5 proves the penalty without overfitting. |

Why 200 ms, not 150/180 ms: on the builtin detector 150 ms and 180 ms
leave `rhythmScore` tied with clean (96 vs 96), so a strict `>` ordering on
rhythmScore cannot hold. 200 ms separates cleanly (96 vs 91) while the
per-note error (191 ms measured, 9 ms off) stays well inside `TIMING_MS_TOL`.
No assertion was weakened to force a pass; the offset was chosen so the
honest ordering holds.

## Measured values, short fixtures (builtin/legacy, 2026-10-10)

| Fixture | pitchScore | rhythmScore | timingAccuracy | stability | offsetMs | spreadMs | wrong | per-note pitch (c) | per-note timing (ms) |
|---|---|---|---|---|---|---|---|---|---|
| clean | 100 | 96 | 96 | 98 | -10 | 3 | 0 | n1..n5 ≈ -0.7 | n2 -6, n3 -13, n4 -7, n5 -13 (n1 unscored anchor) |
| detuned n3 +60 c | 89 | 96 | 96 | 98 | -10 | 3 | 1 | n3 59.3 (sharp/wrong_pitch), rest ≈ -0.7 | same as clean |
| late n3 +200 ms | 100 | 91 | 77 | 91 | 6 | 16 | 0 | all correct (≈ -0.7) | n3 191 (late), n2 -6, n4 17, n5 -13 |

## Measured values, long fixture (live vamp, 2026-10-10)

`extract_all` on the long wav: pYIN 24 segments, QM onsets 48 (attack +
release per note, merged), QM beats 25. `analyze(..., sync_mode="vamp-beat")`:

| Fixture | pitchScore | rhythmScore | timingAccuracy | stability | offsetMs | spreadMs | wrong/correct | degraded | sensors |
|---|---|---|---|---|---|---|---|---|---|
| long 24-note | 100 | 94 | 95 | 98 | -14 | 4 | 0 / 24 | False (`[]`) | fused-pitch, qm-onset |

`detectedBpm` 60.1, `coveredSec` 24.25. `rhythm.source == "vamp-beat"` with
24 beats (0.104…23.104, clipped to the analyzed span), 24 downbeats and
6 phrases of 4 measures. The same long wav through the legacy path stays
`degraded: True` with pitch 100 / rhythm 96.

Ordering (asserted, not just absolute): clean pitchScore 100 >
detuned 89 (drop 11 >= 5); clean timingAccuracy 96 > late 77
(drop 19 >= 5); clean rhythmScore 96 > late 91.

Degraded: the three short fixtures run with no optional sensors, so
`sensors == ["builtin"]`, `summary.degraded is True`, and
`degradedReasons == ["pitch:builtin", "onset:builtin", "beat:legacy"]`.
This is structural, not environmental: the QM BarBeatTracker needs >= 4
beats and returns nothing on 5.25 s of pure sine (measured beats = 0 on the
5-note fixture, 17 on 8 notes, 25 on 24 notes), so short fixtures can never
clear `beat:legacy` no matter which plugins are installed. The long fixture
is the counter-proof: with all three live sensors firing, `degraded is
False` and `degradedReasons == []`. The original test still drives
`vamp_features.extract_all` through the real `import vamp` failure path
(`sys.modules {"vamp": None}`) and asserts `(None, None, None)` before
checking the engine payload; the new long tests skip with an explicit
reason only when the bridge or plugin `.so` files are genuinely absent.

## Determinism

Fixed `RANDOM_SEED`, no unseeded randomness, no wall-clock, no temp files.
Audio is synthesized fresh on each test run; no binary audio is committed.

## Run

```sh
python3 -B -m unittest analysis_service.test_golden_scoring -v
npm run analysis-test
git diff --check
```
