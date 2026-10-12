# Dotzauer corpus

Prepared audio and score fixtures for cello sensor/alignment research.

- `audio/{fast,slow,full}/`: 64 FLAC clips, stored with Git LFS. Every clip was
  checked against the prepared WAV using an identical decoded PCM SHA-256 hash.
- `pdf/`: 34 individually separated Op.113 Book 1 scores, Nos.01–34.
- `source/op.113.pdf`: the original 41-page score book.
- `musicxml/`: supplied No.05 score plus raw Halbestunde OCR outputs obtained
  through the existing analysis service. OCR output is not reviewed ground truth.
- `musicxml-monophonic/`: generated single-line scoring projections. Original
  OCR files stay intact; every removed note is audited in
  `results/monophonic-normalization.json`.
- `manifest.json`: relative paths, hashes, audio properties, and score pairing.
- `score-regions.json`: source-page geometry, including the ink-free shaped
  boundary between Nos.09/10; `pdf-visual-verification.json` records Qwen checks.
- `coverage.json`: missing audio/XML and the unmatched `op120_7` clip.
- `results/`: reproducible baseline outputs and fixed execution parameters.

## Fetch the audio

```sh
git lfs install
git lfs pull
```

PDFs, manifests, MusicXML, and result summaries are ordinary Git files.
The FLACs retain the original stereo 44.1 kHz signal. The runner explicitly
converts analysis chunks to mono 22.05 kHz rather than altering the stored audio.

## Run the research baseline

From the repository root, with ffmpeg, numpy, the Python VAMP bridge, pYIN, and
QM plugins installed:

```sh
python3 -B scripts/dotzauer-corpus.py inventory
python3 -B scripts/dotzauer-corpus.py sensors --chunk-seconds 240
python3 -B scripts/dotzauer-corpus.py score-no05
python3 -B scripts/dotzauer-ocr.py
python3 -B scripts/dotzauer-normalize.py
python3 -B scripts/dotzauer-corpus.py score-corpus
```

The sensor run covers the entire duration of every clip in consecutive chunks
of at most 240 seconds. If a final tail is shorter than 20 seconds, the last
two windows are balanced so silence is not probed as an isolated tiny take;
all decoded samples remain covered exactly once. Exact window offsets, sample
hashes, and parameters are included in each result. Unchanged successful probes
are reused only when their decoded window hashes match. Detector failures are
recorded, all clips are attempted, and any failure makes the run fail.
It compares QM beat/onset grids against pYIN note starts
and builtin detected onsets using one global offset per chunk. Distances are
**detector agreement**, not accuracy against annotated note-onset ground truth.
Inherited fast/slow/full labels and segmentation are provisional, not verified
ground truth. An onset interval is not assumed to be the score's beat period.

The No.05 run uses the explicit 112 BPM, 42-second/18-second real-excerpt contract.
The corpus score probes use the same fixed excerpt window for each matched clip,
and automatically regenerate monophonic XML before any score parsing. The
projection selects the part and voice/staff with most non-chord pitched attacks
(document order breaks ties), drops added chord tones while retaining the base
note, removes auxiliary parts/voices, and reconstructs a forward-only timeline
with explicit rests for gaps. Orphan tie stops left by discarded notes are
removed; valid retained ties stay intact. This deterministic selection is not
a claim that OCR always placed the correct melody first. Repeats and meter
changes are retained rather than erased to bypass validation.
The probes run
with MusicXML sound tempo when valid, otherwise a declared 112 BPM fallback.
They record scored, failed, incompatible, and skipped cases separately. Completion
of the report is not a claim that all clips scored or OCR pitches are accurate.
`results/omr/` preserves PDF/XML hashes, service job IDs and compatibility reasons;
`results/score-corpus-summary.json` reports actual scoring coverage. The OCR runner
uses `ANALYSIS_API_TOKEN` when required and submits at most two concurrent jobs.
Production scoring is only enabled for scores with actual MusicXML; a PDF alone
does not supply machine-readable pitches and durations. Missing XML is reported
in the coverage manifest rather than silently generating grades.

The initial audio set covers 31 of the 34 Op.113 etudes: Nos.18/24/30 have no
prepared recording. The additional `op120_7` clip is retained as an unmatched
sensor fixture and is not paired with Op.113 No.07.

## Baseline recorded 2026-10-12

- Full-duration sensor probes: 64 clips, 82 windows, 12,250.776 seconds;
  every window completed. This measures detector agreement, not score accuracy.
- OCR: all 33 requested PDFs converted through the live analysis endpoint;
  together with supplied No.05, all 34 MusicXML files are present. Sixteen new
  outputs are accepted by the single-voice score parser; seventeen are rejected
  for chords, multiple voices/parts, or unexpanded repeats.
- Fixed 42s/18s scoring probes: 20 scored, 13 rejected during analysis,
  30 incompatible score inputs, 1 unmatched clip skipped. These counts refer to
  clips, not distinct etudes. The scoring baseline is **partial**, not all-pass.
- Golden/rubato regressions: 10 passed. Original No.05 real replay passed;
  corpus No.05 passage contract passed (pitch 96, rhythm 82, measures 30–42).
- Initial sensor run stopped on an isolated 0.5-second quiet tail. The recorded
  rerun balances short final windows, covers every sample, and retains the
  existing signal gate. Earlier failure is not a detector-accuracy claim.

Next investigation: distinguish genuine notation from OCR errors in rejected
scores, then inspect the 13 uncertain auto-locations with verified measure
anchors. Do not remove notes or lower scoring gates merely to increase coverage.

## Monophonic projection update

At the user's direction, treat this corpus as single-line cello and project OCR
polyphony away before scoring. All 34 projections contain one part and no chord,
backup/forward or auxiliary voice/staff elements. Thirty scores now parse; only
Nos.19/30/34 (repeats) and No.22 (meter change) remain incompatible. Original
files are byte-identical to the baseline, and all 17 previously accepted scores
retain exactly the same parsed pitches, durations and onsets.

The same 42s/18s probes now yield **32 scored, 24 analysis failures, 7 incompatible
clips, 1 unmatched skip**. Thus the number of scored clips increased from 20 to
32; polyphony-related input rejection is eliminated. This is still partial
scoring coverage, not a note-accuracy benchmark. The earlier counts above record
the raw-OCR baseline and remain available in commit `6f3fadd`.
