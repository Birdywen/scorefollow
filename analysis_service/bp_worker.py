"""Basic Pitch note events for auto-locate (string-mono-0.12).

Runs in its own venv (SCOREFOLLOW_BP_PYTHON) so basic-pitch, onnxruntime,
librosa and numba never enter the service interpreter. Usage:
    python -I -B bp_worker.py in.wav out.json
Writes {"notes": [[start_sec, end_sec, midi], ...]} with Basic Pitch's default
note thresholds; the monophonic reduction happens in engine.py.
"""
import json
import pathlib
import sys

FPS = 22050 / 256


def main(argv):
    if len(argv) != 3:
        print('usage: bp_worker.py in.wav out.json', file=sys.stderr)
        return 2
    import basic_pitch
    from basic_pitch import note_creation
    from basic_pitch.inference import predict
    model = pathlib.Path(basic_pitch.__file__).parent / 'saved_models' / 'icassp_2022' / 'nmp.onnx'
    if not model.is_file():
        print('BP_MODEL_MISSING', file=sys.stderr)
        return 3
    output, _, _ = predict(argv[1], str(model))
    _, events = note_creation.model_output_to_notes(
        output, onset_thresh=0.5, frame_thresh=0.3,
        min_note_len=int(round(127.7 / 1000 * FPS)), min_freq=None, max_freq=None,
        melodia_trick=True)
    notes = sorted([float(e[0]), float(e[1]), float(e[2])] for e in events)
    pathlib.Path(argv[2]).write_text(json.dumps({'notes': notes}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
