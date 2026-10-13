#!/usr/bin/env python3
"""BP value diagnostics: per-provider locate candidates, visual plots, strategy A/B.

Subcommands:
  candidates  per-provider (pyin/bp/fused) locate candidates + raw events
  plots       alignment PNGs (score notes vs bp/pyin events) into /tmp/bp-plots
  ab          compact strategy comparison (baseline / bp-first / pyin-first)

Sensor outputs are cached in /tmp/bp-value/sensors.json keyed by clip id.
Compact evidence is written to datasets/dotzauer-op113/results/bp-value/.
"""
import argparse
import importlib.util
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
_spec = importlib.util.spec_from_file_location('dotzauer_corpus', REPO / 'scripts' / 'dotzauer-corpus.py')
dc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dc)

DATA = REPO / 'datasets' / 'dotzauer-op113'
OUT = DATA / 'results' / 'bp-value'
SENCACHE = Path('/tmp/bp-value/sensors.json')
PLOTDIR = Path('/tmp/bp-plots')
BP_PY = '/home/ubuntu/.local/share/scorefollow/bpvenv/bin/python3'
RATE = 22050

NEWLY_13 = ['dotzauer_b1_no03__04_slow', 'dotzauer_b1_no23__37_s1_slow',
            'dotzauer_b1_no23__37_s0_fast', 'dotzauer_b1_no32__27_s0_fast',
            'dotzauer_b1_no27__32_s0_fast', 'dotzauer_b1_no31__19_s0_fast',
            'dotzauer_b1_no25__26_s1_slow', 'dotzauer_b1_no14__24_slow',
            'dotzauer_b1_no33__20_s0_fast', 'dotzauer_b1_no33__20_s3_full',
            'dotzauer_b1_no17__02_slow', 'dotzauer_b1_no27__32_s1_slow',
            'dotzauer_b1_no33__20_s2_full']
CONTROLS = ['dotzauer_b1_no03__00_s0_fast', 'dotzauer_b1_no03__00_s1_slow',
            'dotzauer_b1_no05__07_fast']


def manifest_clips():
    return {c['id']: c for c in json.loads((DATA / 'manifest.json').read_text())['clips']}


def bpm_for(xml):
    tempos = [float(s.attrib['tempo']) for s in ET.fromstring(xml).findall('.//{*}sound')
              if 'tempo' in s.attrib]
    return tempos[0] if tempos and 30 <= tempos[0] <= 200 else 112


def sensor_cache():
    if SENCACHE.exists():
        return json.loads(SENCACHE.read_text())
    return {}


def save_sensor_cache(cache):
    SENCACHE.parent.mkdir(parents=True, exist_ok=True)
    SENCACHE.write_text(json.dumps(cache))


def clip_inputs(clip):
    """wav bytes, xml text, bpm, (pitches, onsets, beats) with sensor caching."""
    from analysis_service.engine import parse_score
    n = clip['etude']
    xml = (DATA / 'musicxml-monophonic' / f'Dotzauer_Op113_Book1_No{n:02d}.musicxml').read_text()
    parse_score(xml)
    pcm = dc.pcm_for(dc.audio_path(clip), start=42, duration=18)
    assert len(pcm) == 18 * RATE * 2, 'Incomplete fixed excerpt'
    wav = dc.wav_for(pcm)
    cache = sensor_cache()
    key = clip['id']
    if key in cache and cache[key]['audio_sha256'] == clip['sha256']:
        s = cache[key]
        return wav, xml, bpm_for(xml), (s['pitches'], s['onsets'], s['beats'])
    from analysis_service.vamp_features import extract_all
    pitches, onsets, beats = extract_all(wav)
    assert pitches and onsets and beats, 'Missing live sensor output'
    def as_json(rows):
        if not rows:
            return []
        if isinstance(rows[0], (list, tuple)):
            return [[float(a), float(b), float(c)] for a, b, c in rows]
        return [float(x) for x in rows]
    cache[key] = {'audio_sha256': clip['sha256'], 'pitches': as_json(pitches),
                  'onsets': as_json(onsets), 'beats': as_json(beats)}
    save_sensor_cache(cache)
    return wav, xml, bpm_for(xml), (pitches, onsets, beats)


def try_locate(fn, score_notes, events, beat_map=None):
    try:
        out = fn(score_notes, events, beat_map=beat_map) if 'beat_map' in fn.__code__.co_varnames else fn(score_notes, events)
    except ValueError as exc:
        return {'ok': False, 'error': str(exc)[:80]}
    if isinstance(out, tuple):
        return {'ok': True, 'start': out[0], 'cost': round(float(out[1]), 4)}
    return {'ok': True, 'confident': bool(out.get('confident')), 'start': out.get('start'),
            'cost': round(float(out.get('cost')), 4) if out.get('cost') is not None else None}


def cmd_candidates(args):
    os.environ['SCOREFOLLOW_BP_PYTHON'] = BP_PY
    from analysis_service import engine as E
    from analysis_service.alignment import locate_excerpt, align_excerpt, usable_events
    clips = manifest_clips()
    ids = args.ids or (NEWLY_13 + CONTROLS)
    OUT.mkdir(parents=True, exist_ok=True)
    table = {}
    for cid in ids:
        clip = clips[cid]
        wav, xml, bpm, (pitches, onsets, beats) = clip_inputs(clip)
        from analysis_service.engine import parse_score
        score_notes = parse_score(xml)
        E._BP_CACHE.clear()
        # real signal path: decode wav pcm like engine.read_wav
        import wave as _wave, io as _io, numpy as _np
        with _wave.open(_io.BytesIO(wav), 'rb') as h:
            raw = h.readframes(h.getnframes())
        signal = (_np.frombuffer(raw, dtype='<i2').astype(_np.float32) / 32768.0)
        t1 = time.perf_counter()
        bp_raw = E._bp_locate_events(signal, 22050)
        bp_ms = round((time.perf_counter() - t1) * 1000)
        row = {'bpm': bpm, 'bp_ms': bp_ms,
               'bp_events': [[round(float(a), 3), round(float(b), 3), round(float(c), 2)] for a, b, c in (bp_raw or [])],
               'pyin_events': [[round(float(a), 3), round(float(b), 3), round(float(c), 2)] for a, b, c in usable_events(pitches)]}
        for name, ev in (('pyin', pitches), ('bp', bp_raw),
                         ('fused', E._fused_locate_events(signal, 22050))):
            if not ev:
                row[name] = {'ok': False, 'error': 'no events'}
                continue
            row[name] = try_locate(locate_excerpt, score_notes, ev, beats)
            try:
                row[name + '_align'] = try_locate(align_excerpt, score_notes, ev, beats)
            except Exception as exc:  # align bug must not kill the harness
                row[name + '_align'] = {'ok': False, 'error': type(exc).__name__}
        table[cid] = row
        print('CANDIDATE', cid, {k: (v.get('ok'), v.get('start'), v.get('cost')) for k, v in row.items() if isinstance(v, dict) and 'ok' in v}, flush=True)
    (OUT / 'candidates.json').write_text(json.dumps(table, indent=1, ensure_ascii=False) + '\n')
    print('CANDIDATES_RECORDED', len(table))


def cmd_plots(args):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    table = json.loads((OUT / 'candidates.json').read_text())
    PLOTDIR.mkdir(parents=True, exist_ok=True)
    for cid, row in table.items():
        rec = json.loads((DATA / 'results' / 'score-corpus' / (cid + '.json')).read_text())
        res = rec.get('result') or {}
        summ = res.get('summary') or {}
        notes = res.get('notes') or []
        fig, ax = plt.subplots(figsize=(12.8, 4.8))
        for n in notes:
            s = n.get('expectedSec')
            if s is None:
                continue
            dur = n.get('durationSec') or n.get('expectedDurSec') or min(1.2, (n.get('durationBeat') or 1) * 0.5)
            ax.barh(n['pitchMidi'], dur, left=s, height=0.7, color='#1f77b4', alpha=0.55)
        for ev in row.get('bp_events', []):
            ax.hlines(ev[2], ev[0], ev[1], colors='green', linewidths=1.6)
            ax.plot(ev[0], ev[2], 'go', ms=3)
        for ev in row.get('pyin_events', [])[:64]:
            ax.hlines(ev[2], ev[0], ev[1], colors='orange', linewidths=0.8, alpha=0.7)
        ax.set_xlim(0, 18)
        if notes:
            lo = min(n['pitchMidi'] for n in notes if n.get('expectedSec') is not None) - 3
            hi = max(n['pitchMidi'] for n in notes if n.get('expectedSec') is not None) + 3
            ax.set_ylim(lo, hi)
        ax.set_xlabel('audio sec (18s excerpt)')
        ax.set_ylabel('midi')
        cand = ' | '.join(f"{k}:{('ok@'+str(v.get('start'))+'/$'+str(v.get('cost'))) if v.get('ok') else 'FAIL'}" for k, v in row.items() if isinstance(v, dict) and 'ok' in v and not k.endswith('_align'))
        ax.set_title(f"{cid} status={rec.get('status')} start={summ.get('startMeasure')} "
                     f"cost={summ.get('locationCost')} sensors={summ.get('sensors')}\n{cand}\n"
                     f"blue=score@{summ.get('startMeasure')} green=BP orange=pYIN", fontsize=9)
        fig.tight_layout()
        fig.savefig(PLOTDIR / (cid + '.png'), dpi=100)
        plt.close(fig)
        print('PLOT', cid, flush=True)
    print('PLOTS_DONE', len(table))


def run_analyze(wav, xml, bpm, pitches, onsets, beats):
    from analysis_service import engine as E
    E._BP_CACHE.clear()
    t0 = time.perf_counter()
    try:
        r = E.analyze(wav, xml, bpm, 'cello', start_measure=0, sync_mode='vamp-beat',
                       pitch_notes=pitches, onset_hint=onsets, beat_map=beats)
        s = r['summary']
        return {'status': 'scored', 'start': s.get('startMeasure'), 'cost': s.get('locationCost'),
                'sensors': s.get('sensors'), 'pitch': s.get('pitchScore'), 'rhythm': s.get('rhythmScore'),
                'latency': round(time.perf_counter() - t0, 2)}
    except Exception as exc:
        return {'status': 'failed', 'error': str(exc)[:90], 'latency': round(time.perf_counter() - t0, 2)}


def cmd_ab(args):
    from analysis_service import engine as E
    clips = manifest_clips()
    ids = args.ids or [c['id'] for c in json.loads((DATA / 'manifest.json').read_text())['clips']]
    available = sorted(int(p.stem[-2:]) for p in (DATA / 'musicxml').glob('*.musicxml'))
    OUT.mkdir(parents=True, exist_ok=True)
    for strategy in args.strategies:
        rows = []
        for cid in ids:
            clip = clips[cid]
            if clip['etude'] not in available:
                rows.append({'id': cid, 'status': 'skipped'})
                continue
            try:
                wav, xml, bpm, (pitches, onsets, beats) = clip_inputs(clip)
            except (ValueError, FileNotFoundError, OSError) as exc:
                rows.append({'id': cid, 'status': 'incompatible', 'error': str(exc)[:80]})
                continue
            except AssertionError as exc:  # e.g. short audio: corpus counts these as failed
                rows.append({'id': cid, 'status': 'failed', 'error': str(exc)[:80]})
                print(strategy.upper(), cid, 'failed', str(exc)[:60], flush=True)
                continue
            if strategy == 'baseline':
                os.environ.pop('SCOREFOLLOW_BP_PYTHON', None)
                rows.append({'id': cid, **run_analyze(wav, xml, bpm, pitches, onsets, beats)})
            elif strategy == 'bp-first':
                os.environ['SCOREFOLLOW_BP_PYTHON'] = BP_PY
                rows.append({'id': cid, **run_analyze(wav, xml, bpm, pitches, onsets, beats)})
            elif strategy == 'pyin-first':
                os.environ.pop('SCOREFOLLOW_BP_PYTHON', None)
                first = run_analyze(wav, xml, bpm, pitches, onsets, beats)
                if first['status'] == 'scored':
                    rows.append({'id': cid, **first, 'leg': 'pyin'})
                else:
                    os.environ['SCOREFOLLOW_BP_PYTHON'] = BP_PY
                    second = run_analyze(wav, xml, bpm, pitches, onsets, beats)
                    rows.append({'id': cid, **second, 'leg': 'bp-fallback'})
            print(strategy.upper(), cid, rows[-1]['status'], rows[-1].get('start'), flush=True)
        (OUT / f'ab-{strategy}.json').write_text(json.dumps(rows, indent=1, ensure_ascii=False) + '\n')
        scored = sum(r['status'] == 'scored' for r in rows)
        print(f'AB_{strategy.upper()}_DONE scored={scored}/{len(rows)}', flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('candidates', 'plots', 'ab'):
        p = sub.add_parser(name)
        p.add_argument('--ids', nargs='*', default=None)
        if name == 'ab':
            p.add_argument('--strategies', nargs='+', default=['baseline', 'pyin-first'])
    args = ap.parse_args()
    globals()['cmd_' + args.cmd](args)


if __name__ == '__main__':
    main()
