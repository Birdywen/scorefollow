"""TorchCREPE f0 track for scoring second opinion (string-mono-0.14).

Runs in its own venv (SCOREFOLLOW_CREPE_PYTHON) so torch/torchaudio never
enter the service interpreter. Usage:
    python -I -B crepe_worker.py in.wav out.json
Writes {"times": [...], "midi": [...], "voicing": [...]} at hop 128
(~172 fps): midi is float MIDI pitch, voicing is CREPE periodicity 0..1.
Engine gates on voicing >= 0.5 and needs >= 4 frames per note window.
"""
import json
import pathlib
import sys


def main(argv):
    if len(argv) != 3:
        print('usage: crepe_worker.py in.wav out.json', file=sys.stderr)
        return 2
    import numpy as np
    import soundfile as sf
    import torch
    import torchcrepe
    audio, rate = sf.read(argv[1], dtype='float32')
    if getattr(audio, 'ndim', 1) != 1:
        audio = np.mean(audio, axis=-1)
    track = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).unsqueeze(0)
    pitch, periodicity = torchcrepe.predict(
        track, int(rate), hop_length=128, fmin=50, fmax=2000, model='full',
        batch_size=1024, device='cpu', return_periodicity=True)
    freq = pitch.squeeze(0).numpy().astype(np.float64)
    voicing = periodicity.squeeze(0).numpy().astype(np.float64)
    with np.errstate(divide='ignore'):
        midi = 69.0 + 12.0 * np.log2(np.maximum(freq, 1e-6) / 440.0)
    times = np.arange(freq.shape[0]) * (128.0 / float(rate))
    pathlib.Path(argv[2]).write_text(json.dumps({
        'times': [round(float(t), 4) for t in times],
        'midi': [round(float(m), 3) for m in midi],
        'voicing': [round(float(v), 3) for v in voicing],
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
