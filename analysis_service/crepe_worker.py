"""TorchCREPE f0 track for scoring second opinion (string-mono-0.16).

Runs in its own venv (SCOREFOLLOW_CREPE_PYTHON) so torch/torchaudio never
enter the service interpreter. Usage:
    python -I -B crepe_worker.py in.wav out.json [in2.wav out2.json ...]
All pairs are processed in ONE process (torch + full model load once, then
one inference per pair), so a job with N CREPE verdicts pays the ~10s load
once instead of N times. Per-pair audio/params are identical to the old
single-pair mode; raw frames carry CREPE CPU run-to-run jitter either way,
and verdict medians are stable to ~0.05c (far below the 25c/1000c gates).
Writes per out.json {"times": [...], "midi": [...], "voicing": [...]} at
hop 128 (~172 fps): midi is float MIDI pitch, voicing is CREPE periodicity
0..1. Engine gates on voicing >= 0.5 and needs >= 4 frames per note window.
"""
import json
import pathlib
import sys


def main(argv):
    if len(argv) < 3 or len(argv) % 2 == 0:
        print('usage: crepe_worker.py in.wav out.json [in2.wav out2.json ...]',
              file=sys.stderr)
        return 2
    import numpy as np
    import soundfile as sf
    import torch
    import torchcrepe
    pairs = [(argv[i], argv[i + 1]) for i in range(1, len(argv), 2)]
    clips = []
    for in_path, _out_path in pairs:
        audio, rate = sf.read(in_path, dtype='float32')
        if getattr(audio, 'ndim', 1) != 1:
            audio = np.mean(audio, axis=-1)
        clips.append((np.ascontiguousarray(audio, dtype=np.float32), int(rate)))
    # torchcrepe.infer caches the loaded model on first predict, so every
    # pair after the first reuses it (no reload). Same per-pair params as
    # the old single-pair mode.
    for (_in_path, out_path), (audio, rate) in zip(pairs, clips):
        track = torch.from_numpy(audio).unsqueeze(0)
        pitch, periodicity = torchcrepe.predict(
            track, rate, hop_length=128, fmin=50, fmax=2000, model='full',
            batch_size=1024, device='cpu', return_periodicity=True)
        freq = pitch.squeeze(0).numpy().astype(np.float64)
        voicing = periodicity.squeeze(0).numpy().astype(np.float64)
        with np.errstate(divide='ignore'):
            midi = 69.0 + 12.0 * np.log2(np.maximum(freq, 1e-6) / 440.0)
        times = np.arange(freq.shape[0]) * (128.0 / float(rate))
        pathlib.Path(out_path).write_text(json.dumps({
            'times': [round(float(t), 4) for t in times],
            'midi': [round(float(m), 3) for m in midi],
            'voicing': [round(float(v), 3) for v in voicing],
        }))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
