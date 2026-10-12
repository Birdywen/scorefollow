#!/usr/bin/env python3
"""Fixed-input corpus inventory, full-duration VAMP probes, and No.05 replay."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import time
import wave
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
DATA = REPO / 'datasets/dotzauer-op113'
RATE = 22050
CONFIGS = {
    'barbeat_b4': {'plugin': 'qm-vamp-plugins:qm-barbeattracker',
                   'output': 'beats', 'parameters': {'bpb': 4.0}},
    'barbeat_b3': {'plugin': 'qm-vamp-plugins:qm-barbeattracker',
                   'output': 'beats', 'parameters': {'bpb': 3.0}},
    'onset_energy_s70': {'plugin': 'qm-vamp-plugins:qm-onsetdetector',
                          'output': 'onsets',
                          'parameters': {'dftype': 3.0, 'sensitivity': 70.0}},
}


def manifest():
    return json.loads((DATA / 'manifest.json').read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    temp.replace(path)


def audio_path(clip):
    path = DATA / clip['path']
    with path.open('rb') as stream:
        assert stream.read(4) == b'fLaC', f'{path}: fetch real audio with git lfs pull'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == clip['sha256'], path
    return path


def pcm_for(path, start=None, duration=None):
    command = ['ffmpeg', '-nostdin', '-v', 'error']
    if start is not None:
        command += ['-ss', str(start)]
    command += ['-i', str(path)]
    if duration is not None:
        command += ['-t', str(duration)]
    command += ['-ac', '1', '-ar', str(RATE), '-f', 's16le', 'pipe:1']
    result = subprocess.run(command, capture_output=True, check=True, timeout=180)
    assert len(result.stdout) % 2 == 0
    return result.stdout


def wav_for(pcm):
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as out:
        out.setparams((1, 2, RATE, len(pcm) // 2, 'NONE', 'not compressed'))
        out.writeframes(pcm)
    return stream.getvalue()


def required_plugins():
    from analysis_service import vamp_features  # establishes VAMP_PATH
    import vamp
    required = {'pyin:pyin', 'qm-vamp-plugins:qm-onsetdetector',
                'qm-vamp-plugins:qm-barbeattracker'}
    available = set(vamp.list_plugins())
    assert required <= available, sorted(required - available)
    return vamp


def inventory(args):
    from analysis_service.engine import parse_score
    data = manifest()
    assert len(data['clips']) == 64
    pdfs = sorted((DATA / 'pdf').glob('*.pdf'))
    assert [p.name for p in pdfs] == [f'Dotzauer_Op113_Book1_No{n:02d}.pdf' for n in range(1, 35)]
    covered = sorted({c['etude'] for c in data['clips'] if c['etude'] is not None})
    score_regions = json.loads((DATA / 'score-regions.json').read_text())
    for score in score_regions['etudes']:
        assert hashlib.sha256((DATA / 'pdf' / score['file']).read_bytes()).hexdigest() == score['sha256']
    source_hash = hashlib.sha256((DATA / 'source/op.113.pdf').read_bytes()).hexdigest()
    assert source_hash == data['source_pdf_sha256']
    for c in data['clips']:
        audio_path(c)
        assert c['duration_sec'] > .4
        if c['pdf']:
            assert (DATA / c['pdf']).is_file()
    score = DATA / 'musicxml/Dotzauer_Op113_Book1_No05.musicxml'
    assert parse_score(score.read_text())
    required_plugins()
    print('INVENTORY', json.dumps({'clips': 64, 'pdfs': 34, 'paired_etudes': len(covered),
                                   'missing_audio': sorted(set(range(1, 35)) - set(covered)),
                                   'musicxml_etudes': sorted(int(p.stem[-2:]) for p in (DATA / 'musicxml').glob('*.musicxml')),
                                   'duration_minutes': round(sum(c['duration_sec'] for c in data['clips']) / 60, 2)}))
    print('DOTZAUER_DATASET_INVENTORY_OK')


def fit_offset(grid, events, interval):
    """Equivalent objective/search to vamp_offset_lab without an E×B matrix."""
    import numpy as np
    beats = np.asarray(grid, dtype=float)
    values = np.asarray(events, dtype=float)
    assert len(beats) >= 4 and len(values) > 0

    def distances(offset):
        shifted = beats + offset
        indices = np.searchsorted(shifted, values)
        left = shifted[np.maximum(indices - 1, 0)]
        right = shifted[np.minimum(indices, len(shifted) - 1)]
        return np.minimum(np.abs(values - left), np.abs(values - right))

    candidates = [(float(distances(k * interval / 16).mean()), k * interval / 16)
                  for k in range(-8, 9)]
    mean, offset = min(candidates)
    for k in range(-16, 17):
        trial = offset + k * interval / 64
        error = float(distances(trial).mean())
        if error < mean:
            mean, offset = error, trial
    residuals = distances(offset)
    return {'offsetSec': round(offset, 4), 'meanAbsDistanceMs': round(mean * 1000, 1),
            'within50ms': round(float((residuals <= .05).mean()), 3)}


def sensor_chunk(pcm):
    import numpy as np
    from analysis_service.engine import track, detect_builtin_onsets, read_wav
    from analysis_service.vamp_features import extract_pitch_notes
    vamp = required_plugins()
    wav = wav_for(pcm)
    signal, rate = read_wav(wav)
    notes = extract_pitch_notes(wav)
    assert notes, 'pYIN produced no usable pitch notes'
    starts = [float(n[0]) for n in notes]
    times, pitches, energy, conf = track(signal, rate)
    builtin = detect_builtin_onsets(times, pitches, energy, None)
    assert builtin, 'Builtin detector produced no onsets'
    signal = np.ascontiguousarray(signal, dtype=np.float32)
    rows = []
    for name, config in CONFIGS.items():
        collected = vamp.collect(signal, rate, config['plugin'],
                                 output=config['output'], parameters=config['parameters'])
        grid = sorted(float(e['timestamp']) for e in collected['list'])
        assert len(grid) >= 4, (name, len(grid))
        intervals = [b - a for a, b in zip(grid, grid[1:]) if .15 < b - a < 2.0]
        assert intervals, name
        interval = statistics.median(intervals)
        for reference, events in [('pyin', starts), ('builtin', builtin)]:
            fitted = fit_offset(grid, events, interval)
            assert all(math.isfinite(fitted[k]) for k in fitted)
            rows.append({'grid': name, 'reference': reference, 'events': len(events),
                         'gridEvents': len(grid), 'medianIntervalSec': round(interval, 4),
                         **fitted})
    return {'durationSec': len(signal) / rate,
            'peak': round(float(np.abs(signal).max()), 5),
            'clippedSampleFraction': round(float((np.abs(signal) >= .999).mean()), 6),
            'pyinNotes': len(notes), 'builtinOnsets': len(builtin), 'metrics': rows}


def sensors(args):
    assert .4 <= args.chunk_seconds <= 240
    import numpy as np
    from analysis_service.vamp_offset_lab import best_offset
    # Numerical acceptance against the existing brute-force research objective,
    # including events beyond either end of a grid.
    for grid, events in [([.1, .6, 1.1, 1.6, 2.1], [-.3, .32, 1.4, 2.8]),
                         ([0., .21, .64, 1.22, 1.82], [.01, .44, .71, 1.54])]:
        interval = .5
        old_error, old = best_offset(grid, events, interval)
        new = fit_offset(grid, events, interval)
        assert new['meanAbsDistanceMs'] == old_error and new['offsetSec'] == old['offsetSec']
        assert new['within50ms'] == old['within50ms']
    data = manifest()
    config = {'sample_rate': RATE, 'channels': 1, 'chunk_seconds': args.chunk_seconds,
              'chunk_policy': 'consecutive nonoverlapping windows covering all decoded samples',
              'configs': CONFIGS, 'references': ['pyin', 'builtin'],
              'metric_semantics': 'detector agreement, not annotated onset/scoring accuracy',
              'offset_fit': 'existing vamp_offset_lab objective and search; nearest-event searchsorted optimization'}
    out = DATA / 'results' / 'sensors'
    all_results = []
    started = time.monotonic()
    for clip in data['clips']:
        path = audio_path(clip)
        target = out / (clip['id'] + '.json')
        cache_key = {'audio_sha256': clip['sha256'], 'config': config}
        pcm = pcm_for(path)
        duration = len(pcm) / 2 / RATE
        assert abs(duration - clip['duration_sec']) < 2 / RATE
        size = round(args.chunk_seconds * RATE) * 2
        pieces = [pcm[start:start + size] for start in range(0, len(pcm), size)]
        # A tiny isolated tail may be only silence. Balance the final two chunks
        # when the tail is under 20 s; retain every sample and the <=240 s limit.
        if len(pieces) > 1 and len(pieces[-1]) < round(20 * RATE) * 2:
            tail = pieces.pop()
            merged = pieces.pop() + tail
            split = (len(merged) // 2 // 2) * 2
            pieces.extend([merged[:split], merged[split:]])
        assert sum(map(len, pieces)) == len(pcm)
        assert all(len(p) <= size for p in pieces)
        if target.exists():
            saved = json.loads(target.read_text())
            assert saved['cache_key'] == cache_key, f'Stale cache: {target}'
            expected_hashes = [hashlib.sha256(part).hexdigest() for part in pieces]
            previous_hashes = [c['pcm_sha256'] for c in saved['chunks']]
            # Decoder/environment or window-policy changes are checked against
            # actual PCM, not just the compressed-file hash. Unchanged passes
            # are reused; changed windows and unresolved failures are rerun.
            if saved['status'] == 'passed' and previous_hashes == expected_hashes:
                all_results.append(saved)
                print('SENSOR_CACHED', clip['id'], flush=True)
                continue
        chunks = []
        start_samples = 0
        for index, part in enumerate(pieces):
            try:
                result = sensor_chunk(part)
                result['status'] = 'passed'
            except Exception as exc:
                result = {'status': 'failed', 'durationSec': len(part) / 2 / RATE,
                          'error_type': type(exc).__name__, 'error': str(exc), 'metrics': []}
            result.update({'index': index, 'startSec': start_samples / RATE,
                           'pcm_sha256': hashlib.sha256(part).hexdigest()})
            chunks.append(result)
            start_samples += len(part) // 2
        assert start_samples == len(pcm) // 2
        assert abs(sum(c['durationSec'] for c in chunks) - duration) < 1e-7
        status = 'passed' if all(c['status'] == 'passed' for c in chunks) else 'failed'
        record = {'id': clip['id'], 'etude': clip['etude'], 'version': clip['version'],
                  'status': status, 'cache_key': cache_key,
                  'decodedDurationSec': duration, 'chunks': chunks}
        write_json(target, record)
        all_results.append(record)
        print('SENSOR_' + status.upper(), clip['id'], 'chunks', len(chunks),
              'seconds', round(duration, 2), flush=True)
    assert len(all_results) == 64
    aggregate = []
    for name in CONFIGS:
        for reference in ('pyin', 'builtin'):
            rows = [r for clip in all_results for c in clip['chunks'] for r in c['metrics']
                    if r['grid'] == name and r['reference'] == reference]
            aggregate.append({'grid': name, 'reference': reference, 'chunks': len(rows),
                              'medianMeanAbsDistanceMs': round(statistics.median(
                                  r['meanAbsDistanceMs'] for r in rows), 1),
                              'medianWithin50ms': round(statistics.median(
                                  r['within50ms'] for r in rows), 3)})
    failures = [{'id': r['id'], 'failed_chunks': [c for c in r['chunks'] if c.get('status') == 'failed']}
                for r in all_results if r['status'] != 'passed']
    summary = {'status': 'failed' if failures else 'passed', 'clips': len(all_results),
               'chunks': sum(len(r['chunks']) for r in all_results),
               'attemptedDurationSec': round(sum(r['decodedDurationSec'] for r in all_results), 3),
               'analyzedDurationSec': round(sum(c['durationSec'] for r in all_results for c in r['chunks']
                                               if c.get('status', 'passed') == 'passed'), 3),
               'failed_clips': failures,
               'covered_op113_etudes': sorted({r['etude'] for r in all_results if r['etude'] is not None}),
               'config': config, 'aggregate': aggregate,
               'runtimeSec': round(time.monotonic() - started, 2)}
    write_json(DATA / 'results/sensor-summary.json', summary)
    print('SENSOR_AGGREGATE', json.dumps(summary, ensure_ascii=False), flush=True)
    assert not failures, [(r['id'], [c['error'] for c in r['failed_chunks']]) for r in failures]
    print('ALL_64_FULL_DURATION_SENSOR_BASELINES_OK', flush=True)


def score_corpus(args):
    """Fixed 42s/18s pipeline probes, not manually annotated accuracy tests."""
    from analysis_service.engine import analyze, parse_score
    from analysis_service.vamp_features import extract_all
    # Always regenerate from original XML before parsing; never reuse a stale
    # projection after the OCR input or normalization policy changes.
    subprocess.run([sys.executable, '-B', str(REPO / 'scripts/dotzauer-normalize.py')], check=True)
    data = manifest()
    coverage = json.loads((DATA / 'coverage.json').read_text())
    available = sorted(int(p.stem[-2:]) for p in (DATA / 'musicxml').glob('*.musicxml'))
    coverage['musicxml_etudes'] = available
    coverage['missing_musicxml_etudes'] = sorted(set(range(1, 35)) - set(available))
    for clip in data['clips']:
        n = clip['etude']
        clip['musicxml'] = f'musicxml/Dotzauer_Op113_Book1_No{n:02d}.musicxml' if n in available else None
    write_json(DATA / 'manifest.json', data)
    write_json(DATA / 'coverage.json', coverage)
    records = []
    for clip in data['clips']:
        record = {'id': clip['id'], 'etude': clip['etude'], 'audio_sha256': clip['sha256'],
                  'ground_truth_verified': False}
        if not clip['musicxml']:
            record.update(status='skipped', reason='No matching MusicXML')
        else:
            normalized = DATA / 'musicxml-monophonic' / Path(clip['musicxml']).name
            score_path = normalized if normalized.exists() else DATA / clip['musicxml']
            xml = score_path.read_text()
            record['score_path'] = str(score_path.relative_to(DATA))
            record['xml_sha256'] = hashlib.sha256(xml.encode()).hexdigest()
            try:
                parse_score(xml)
            except ValueError as exc:
                record.update(status='incompatible', reason=str(exc))
            else:
                # Sound tempo is explicitly in quarter-notes/minute. Avoid
                # interpreting printed metronome units as quarter-note tempo.
                tempos = [float(s.attrib['tempo']) for s in ET.fromstring(xml).findall('.//{*}sound')
                          if 'tempo' in s.attrib]
                bpm = tempos[0] if tempos and 30 <= tempos[0] <= 200 else 112
                record['params'] = {'start_sec': 42, 'duration_sec': 18, 'bpm': bpm,
                                    'bpm_source': 'musicxml_sound' if tempos and bpm == tempos[0] else 'declared_fallback',
                                    'instrument': 'cello', 'start_measure': 0, 'sync_mode': 'vamp-beat'}
                try:
                    pcm = pcm_for(audio_path(clip), start=42, duration=18)
                    assert len(pcm) == 18 * RATE * 2, 'Incomplete fixed excerpt'
                    wav = wav_for(pcm)
                    pitches, onsets, beats = extract_all(wav)
                    assert pitches and onsets and beats, 'Missing live sensor output'
                    result = analyze(wav, xml, bpm, 'cello', start_measure=0, sync_mode='vamp-beat',
                                     pitch_notes=pitches, onset_hint=onsets, beat_map=beats)
                    record.update(status='scored', result=result)
                except Exception as exc:
                    record.update(status='failed', error_type=type(exc).__name__, reason=str(exc))
        write_json(DATA / 'results/score-corpus' / (clip['id'] + '.json'), record)
        records.append(record)
        print('SCORE_PROBE', clip['id'], record['status'], record.get('reason', ''), flush=True)
    counts = {status: sum(r['status'] == status for r in records)
              for status in ('scored', 'failed', 'incompatible', 'skipped')}
    summary = {'counts': counts, 'clips': len(records), 'scope': 'fixed 42s/18s excerpts',
               'accuracy_claim': False, 'records': [{k: v for k, v in r.items() if k != 'result'} for r in records]}
    write_json(DATA / 'results/score-corpus-summary.json', summary)
    assert len(records) == 64 and sum(counts.values()) == 64
    print('CORPUS_SCORE_PROBES_RECORDED', json.dumps(counts), flush=True)
    if counts['failed'] or counts['incompatible'] or counts['skipped']:
        print('SCORING_COVERAGE_PARTIAL', flush=True)


def score_no05(args):
    from analysis_service.engine import analyze
    from analysis_service.vamp_features import extract_all
    data = manifest()
    clips = [c for c in data['clips'] if c['etude'] == 5]
    assert len(clips) == 1
    path = audio_path(clips[0])
    pcm = pcm_for(path, start=42, duration=18)
    assert len(pcm) == 18 * RATE * 2
    wav = wav_for(pcm)
    xml = (DATA / clips[0]['musicxml']).read_text()
    pitches, onsets, beats = extract_all(wav)
    assert pitches and onsets and beats, 'No.05 real replay requires all live sensors'
    result = analyze(wav, xml, 112, 'cello', start_measure=0, sync_mode='vamp-beat',
                     pitch_notes=pitches, onset_hint=onsets, beat_map=beats)
    summary = result['summary']
    # Same passage-level assertions as test_alignment_real, using the newly
    # prepared corpus recording rather than changing the original test fixture.
    assertions = {'first_measure_30': result['notes'][0]['measure'] == 30,
                  'start_measure_30': summary['startMeasure'] == 30,
                  'end_measure_at_least_40': summary['endMeasure'] >= 40,
                  'note_count_at_most_90': summary['noteCount'] <= 90,
                  'auto_located': bool(summary['autoLocated']),
                  'pitch_score_at_least_60': summary['pitchScore'] is not None and summary['pitchScore'] >= 60}
    report = {'status': 'passed' if all(assertions.values()) else 'failed',
              'audio_id': clips[0]['id'], 'audio_sha256': clips[0]['sha256'],
              'params': {'start_sec': 42, 'duration_sec': 18, 'bpm': 112,
                         'instrument': 'cello', 'start_measure': 0, 'sync_mode': 'vamp-beat'},
              'assertions': assertions, 'result': result}
    write_json(DATA / 'results/score-no05.json', report)
    print('NO05_REPLAY', json.dumps({'assertions': assertions, 'summary': summary}, ensure_ascii=False))
    assert all(assertions.values()), assertions
    print('CORPUS_NO05_REAL_SCORING_OK')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('inventory')
    sensor_parser = sub.add_parser('sensors')
    sensor_parser.add_argument('--chunk-seconds', type=float, default=240)
    sub.add_parser('score-no05')
    sub.add_parser('score-corpus')
    args = parser.parse_args()
    globals()[args.command.replace('-', '_')](args)
