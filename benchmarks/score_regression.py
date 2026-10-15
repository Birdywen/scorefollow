#!/usr/bin/env python3
"""Dotzauer 语料打分回归: 用当前仓库引擎跑固定片段, 输出逐段分数; 给 --baseline 时按门槛判定.

用法:
  env -u SCOREFOLLOW_CREPE_URL -u SCOREFOLLOW_CREPE_PYTHON -u SCOREFOLLOW_BP_PYTHON \
    python3 benchmarks/score_regression.py --out /tmp/run.json \
      [--data ~/n/scorefollow/datasets/dotzauer-op113] [--baseline benchmarks/score-baseline.json]

片段选择与参数沿用 0.18 评测: score-corpus-summary.json 中 status 为 scored/failed 且
不是 'Incomplete fixed excerpt' 的记录 (55 段), 按记录 params 截取 (默认 42s 起 18s),
大提琴, start_measure=0, vamp-beat. 不带 CREPE 运行, 结果可复现.
退出码: 0 = 通过或未给基准; 1 = 回归不合格; 2 = 输入问题.
"""
import argparse
import io
import json
import subprocess
import sys
import time
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
RATE = 22050


def wav_of(pcm):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm)
    return buf.getvalue()


def pct(values, q):
    v = sorted(values)
    if not v:
        return None
    k = (len(v) - 1) * q
    lo = int(k); hi = min(lo + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo), 1)


def stats(rows, key):
    v = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
    return {'n': len(v), 'median': pct(v, .5), 'p25': pct(v, .25), 'p10': pct(v, .1)}


def run(args):
    from analysis_service import engine as eng
    from analysis_service.vamp_features import extract_all
    try:
        from analysis_service.quality import assess_quality
    except Exception:
        assess_quality = None
    data = Path(args.data).expanduser()
    summary = json.load(open(data / 'results/score-corpus-summary.json', encoding='utf-8'))
    recs = [r for r in summary['records']
            if r.get('status') in ('failed', 'scored') and r.get('reason') != 'Incomplete fixed excerpt']
    if args.limit:
        recs = recs[:args.limit]
    print('ENGINE', eng.VERSION, 'CREPE', eng.crepe_backend(), 'CLIPS', len(recs), flush=True)
    rows = []
    if getattr(args, 'corpus', None):
        keep = {c for e in json.load(open(args.corpus, encoding='utf-8'))['etudes'] for c in e['clips']}
        recs = [r for r in recs if r.get('id') in keep]
        if not args.limit:
            assert len(recs) == len(keep), 'corpus clips %d, matched %d' % (len(keep), len(recs))
        import hashlib
        for e in json.load(open(args.corpus, encoding='utf-8'))['etudes']:
            xp = data / 'musicxml-monophonic' / ('Dotzauer_Op113_Book1_No%02d.musicxml' % e['etude'])
            assert hashlib.sha256(xp.read_bytes()).hexdigest() == e['monophonic_xml_sha256'], 'stale score XML %s; --data must hold the corpus XML' % xp
    for r in recs:
        p = r.get('params') or {}
        row = {'id': r['id']}
        t0 = time.monotonic()
        try:
            flac = next(data.glob('audio/*/%s.flac' % r['id']))
            with open(flac, 'rb') as fh:
                if fh.read(4) != b'fLaC':
                    raise RuntimeError('not a FLAC file (Git LFS pointer?)')
            pcm = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(p.get('start_sec', 42)),
                                  '-t', str(p.get('duration_sec', 18)), '-i', str(flac),
                                  '-ac', '1', '-ar', str(RATE), '-f', 's16le', '-'],
                                 capture_output=True, check=True, timeout=60).stdout
            wav = wav_of(pcm)
            xml = (data / r['score_path']).read_text(encoding='utf-8')
            pitch_notes, onset_hint, beat_map = extract_all(wav)
            res = eng.analyze(wav, xml, p.get('bpm', 112), p.get('instrument', 'cello'),
                              start_measure=p.get('start_measure', 0), sync_mode=p.get('sync_mode', 'vamp-beat'),
                              pitch_notes=pitch_notes, onset_hint=onset_hint, beat_map=beat_map)
            s = res.get('summary', {}) or {}
            row.update(status='scored', pitch=s.get('pitchScore'), rhythm=s.get('rhythmScore'),
                       measures='%s-%s' % (s.get('startMeasure'), s.get('endMeasure')),
                       rescue=s.get('rescueReasons') or [], degraded=s.get('degradedReasons') or [])
            if assess_quality:
                try:
                    row['outcome'] = assess_quality(res).get('outcome')
                except Exception as exc:
                    row['outcome'] = 'quality_error:' + type(exc).__name__
        except StopIteration:
            row.update(status='failed', error='audio file not found')
        except Exception as exc:
            row.update(status='failed', error='%s: %s' % (type(exc).__name__, str(exc)[:160]))
        row['sec'] = round(time.monotonic() - t0, 2)
        rows.append(row)
        print('%-42s %-7s pitch=%-5s rhythm=%-5s %5.1fs' % (row['id'][:42], row['status'], row.get('pitch'),
                                                         row.get('rhythm'), row['sec']), flush=True)
    return {'engine': eng.VERSION, 'crepe': eng.crepe_backend(),
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'clips': len(rows), 'scored': sum(r['status'] == 'scored' for r in rows),
            'pitch': stats(rows, 'pitch'), 'rhythm': stats(rows, 'rhythm'), 'rows': rows}


def compare(cur, base, median_drop, clip_drop):
    bad = []
    if cur['scored'] < base['scored']:
        bad.append('scored %d < baseline %d' % (cur['scored'], base['scored']))
    for k in ('pitch', 'rhythm'):
        c, b = cur[k]['median'], base[k]['median']
        if b is not None and (c is None or c < b - median_drop):
            bad.append('%s median %s < baseline %s - %s' % (k, c, b, median_drop))
    old = {r['id']: r for r in base['rows']}
    for r in cur['rows']:
        o = old.get(r['id'])
        if not o:
            continue
        if o['status'] == 'scored' and r['status'] != 'scored':
            bad.append('%s no longer scored (%s)' % (r['id'], r.get('error')))
        for k in ('pitch', 'rhythm'):
            a, b = r.get(k), o.get(k)
            if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a < b - clip_drop:
                bad.append('%s %s %s < baseline %s' % (r['id'], k, a, b))
            elif b is not None and a is None:
                bad.append('%s %s missing (baseline %s)' % (r['id'], k, b))
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--data', default=str(Path.home() / 'n/scorefollow/datasets/dotzauer-op113'))
    ap.add_argument('--baseline')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--corpus', help='whitelist JSON (benchmarks/clean-corpus.json): score only its clips')
    ap.add_argument('--median-drop', type=float, default=2.0)
    ap.add_argument('--clip-drop', type=float, default=10.0)
    args = ap.parse_args()
    if not (Path(args.data).expanduser() / 'results/score-corpus-summary.json').exists():
        print('DATA_MISSING', args.data); sys.exit(2)
    cur = run(args)
    Path(args.out).write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding='utf-8')
    print('SUMMARY clips=%d scored=%d pitch=%s rhythm=%s' % (cur['clips'], cur['scored'],
                                                           json.dumps(cur['pitch']), json.dumps(cur['rhythm'])))
    if not args.baseline:
        print('SCORE_REGRESSION NO_BASELINE'); return
    bad = compare(cur, json.load(open(args.baseline, encoding='utf-8')), args.median_drop, args.clip_drop)
    for b in bad[:30]:
        print('REGRESSION', b)
    print('SCORE_REGRESSION', 'FAIL' if bad else 'PASS', len(bad))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
