"""Deterministic golden-sample fixtures for ScoreFollow scoring.

Synthesizes audio in-process with numpy + wave only (no ffmpeg, no network,
no checked-in binaries). Ground truth is declared here, never derived from
engine output. The test module calls the real scoring path
(analysis_service.engine.analyze) with the matching minimal MusicXML.

Determinism: fixed RANDOM_SEED, no wall-clock, no unseeded randomness.
"""

import io
import wave

import numpy as np

# Fixed seed: synthesis itself is closed-form (no RNG), but the seed is set
# on import/build so any future stochastic step stays deterministic.
RANDOM_SEED = 42

SAMPLE_RATE = 22050
BPM = 60.0
INSTRUMENT = "violin"

# Score pitches: A4 B4 C5 D5 E5, one quarter note per measure.
FIXTURE_PITCHES = (69, 71, 72, 74, 76)

# Nominal performance layout at 60 bpm: quarter == 1.0 s, first onset at
# 0.12 s so the onset detector sees leading silence, matching test_engine.
NOMINAL_FIRST_ONSET_SEC = 0.12
NOTE_SPACING_SEC = 1.0
NOTE_LENGTH_SEC = 0.78
PEAK_AMPLITUDE = 0.32

# Fixture 2: single-note detune (third note, C5) by a known cent offset.
DETUNED_NOTE_INDEX = 2
DETUNE_CENTS = 60.0

# Fixture 3: single-note lateness (third note) by a known millisecond offset.
# 200 ms was chosen because 150-180 ms leaves rhythmScore tied with clean
# (96 vs 96) on the builtin detector, while 200 ms separates cleanly
# (clean 96 vs late 91) with per-note error still well inside TIMING_MS_TOL.
LATE_NOTE_INDEX = 2
LATE_OFFSET_MS = 200.0

_STEP_FOR_MIDI = {69: ("A", 4), 71: ("B", 4), 72: ("C", 5), 74: ("D", 5), 76: ("E", 5)}


def musicxml_for_pitches(pitches=FIXTURE_PITCHES):
    """Minimal matching MusicXML: one quarter note per measure."""
    measures = []
    for n, pitch in enumerate(pitches, 1):
        step, octave = _STEP_FOR_MIDI[pitch]
        measures.append(
            f'<measure number="{n}"><attributes><divisions>1</divisions></attributes>'
            f"<note><pitch><step>{step}</step><octave>{octave}</octave></pitch>"
            "<duration>1</duration></note></measure>"
        )
    return "<score-partwise><part id=\"P1\">" + "".join(measures) + "</part></score-partwise>"


def _render(pitches, detune_cents_map=None, offset_sec_map=None):
    """Render monophonic sine notes with percussive envelope to float32 audio."""
    detune_cents_map = detune_cents_map or {}
    offset_sec_map = offset_sec_map or {}
    total = (len(pitches) + 0.25) * SAMPLE_RATE
    audio = np.zeros(int(total), dtype=np.float32)
    for index, midi in enumerate(pitches):
        cents = float(detune_cents_map.get(index, 0.0))
        offset = float(offset_sec_map.get(index, 0.0))
        start = int((NOMINAL_FIRST_ONSET_SEC + index * NOTE_SPACING_SEC + offset) * SAMPLE_RATE)
        length = int(NOTE_LENGTH_SEC * SAMPLE_RATE)
        t = np.arange(length) / SAMPLE_RATE
        hz = 440.0 * 2.0 ** ((midi + cents / 100.0 - 69) / 12.0)
        envelope = np.minimum(1.0, t * 60.0) * np.minimum(1.0, (NOTE_LENGTH_SEC - t) * 30.0)
        tone = PEAK_AMPLITUDE * envelope * np.sin(2.0 * np.pi * hz * t).astype(np.float32)
        audio[start:start + length] = tone
    return audio


def _encode_wav(audio, rate=SAMPLE_RATE):
    """Encode float32 mono audio to 16-bit PCM WAV bytes (wave stdlib only)."""
    clipped = np.clip(audio, -1.0, 1.0)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, len(clipped), "NONE", "not compressed"))
        wav.writeframes((clipped * 32767).astype("<i2").tobytes())
    return output.getvalue()


def _ground_truth(detune_cents_map=None, offset_sec_map=None):
    """Declared ground truth: score onsets plus actual performed onsets."""
    detune_cents_map = detune_cents_map or {}
    offset_sec_map = offset_sec_map or {}
    truth = []
    for index, midi in enumerate(FIXTURE_PITCHES):
        score_onset = NOMINAL_FIRST_ONSET_SEC + index * NOTE_SPACING_SEC
        performed_onset = score_onset + float(offset_sec_map.get(index, 0.0))
        truth.append(
            {
                "id": f"n{index + 1}",
                "pitchMidi": midi,
                "scoreOnsetSec": round(score_onset, 3),
                "performedOnsetSec": round(performed_onset, 3),
                "renderedDetuneCents": float(detune_cents_map.get(index, 0.0)),
                "renderedOffsetMs": round(float(offset_sec_map.get(index, 0.0)) * 1000.0, 1),
            }
        )
    return truth


def build_clean():
    """Fixture 1: in-tune, on-time performance."""
    np.random.seed(RANDOM_SEED)
    wav = _encode_wav(_render(FIXTURE_PITCHES))
    return {
        "name": "clean",
        "wav": wav,
        "xml": musicxml_for_pitches(),
        "bpm": BPM,
        "instrument": INSTRUMENT,
        "ground_truth": _ground_truth(),
    }


def build_detuned():
    """Fixture 2: one note (n3) detuned by DETUNE_CENTS."""
    np.random.seed(RANDOM_SEED)
    detune = {DETUNED_NOTE_INDEX: DETUNE_CENTS}
    wav = _encode_wav(_render(FIXTURE_PITCHES, detune_cents_map=detune))
    return {
        "name": "detuned",
        "wav": wav,
        "xml": musicxml_for_pitches(),
        "bpm": BPM,
        "instrument": INSTRUMENT,
        "ground_truth": _ground_truth(detune_cents_map=detune),
        "detuned_note_id": f"n{DETUNED_NOTE_INDEX + 1}",
        "detune_cents": DETUNE_CENTS,
    }


def build_late():
    """Fixture 3: one note (n3) late by LATE_OFFSET_MS."""
    np.random.seed(RANDOM_SEED)
    offset = {LATE_NOTE_INDEX: LATE_OFFSET_MS / 1000.0}
    wav = _encode_wav(_render(FIXTURE_PITCHES, offset_sec_map=offset))
    return {
        "name": "late",
        "wav": wav,
        "xml": musicxml_for_pitches(),
        "bpm": BPM,
        "instrument": INSTRUMENT,
        "ground_truth": _ground_truth(offset_sec_map=offset),
        "late_note_id": f"n{LATE_NOTE_INDEX + 1}",
        "late_offset_ms": LATE_OFFSET_MS,
    }


# Fixture 4 (long): 24 in-tune, on-time notes (~24.25 s). The 5-note fixtures
# are too short for the QM BarBeatTracker (needs >= 4 beats; on 5.25 s of
# pure sine it returns nothing, so the short path stays beat:legacy by
# design). 24 steady quarter notes give the tracker enough context to lock,
# exercising the real non-degraded path (degraded False). Pitches cycle the
# same five score pitches so musicxml_for_pitches still applies.
LONG_NOTE_COUNT = 24
LONG_PITCHES = tuple(FIXTURE_PITCHES[i % len(FIXTURE_PITCHES)]
                     for i in range(LONG_NOTE_COUNT))


def _ground_truth_for(pitches, detune_cents_map=None, offset_sec_map=None):
    """Declared ground truth for an arbitrary pitch list (long fixture)."""
    detune_cents_map = detune_cents_map or {}
    offset_sec_map = offset_sec_map or {}
    truth = []
    for index, midi in enumerate(pitches):
        score_onset = NOMINAL_FIRST_ONSET_SEC + index * NOTE_SPACING_SEC
        performed_onset = score_onset + float(offset_sec_map.get(index, 0.0))
        truth.append(
            {
                "id": f"n{index + 1}",
                "pitchMidi": midi,
                "scoreOnsetSec": round(score_onset, 3),
                "performedOnsetSec": round(performed_onset, 3),
                "renderedDetuneCents": float(detune_cents_map.get(index, 0.0)),
                "renderedOffsetMs": round(float(offset_sec_map.get(index, 0.0)) * 1000.0, 1),
            }
        )
    return truth


def build_long():
    """Fixture 4: long in-tune, on-time performance for the vamp path."""
    np.random.seed(RANDOM_SEED)
    wav = _encode_wav(_render(LONG_PITCHES))
    return {
        "name": "long",
        "wav": wav,
        "xml": musicxml_for_pitches(LONG_PITCHES),
        "bpm": BPM,
        "instrument": INSTRUMENT,
        "ground_truth": _ground_truth_for(LONG_PITCHES),
    }
