#!/usr/bin/env python3
"""Resume corpus OCR through the existing analysis service; preserve raw outputs."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from analysis_service.engine import parse_score

DATA = ROOT / 'datasets/dotzauer-op113'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8765')
    parser.add_argument('--workers', type=int, choices=(1, 2), default=2)
    args = parser.parse_args()
    token = os.getenv('ANALYSIS_API_TOKEN', '')

    def request(route, payload=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Analysis-Token'] = token
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(args.base_url.rstrip('/') + route, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)

    assert request('/health')['status'] == 'ok'

    def convert(number):
        stem = f'Dotzauer_Op113_Book1_No{number:02d}'
        pdf = DATA / 'pdf' / (stem + '.pdf')
        target = DATA / 'musicxml' / (stem + '.musicxml')
        receipt = DATA / 'results/omr' / (stem + '.json')
        digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
        record = {'etude': number, 'pdf_sha256': digest,
                  'source': 'analysis-service /omr/jobs', 'reviewed_ground_truth': False}
        try:
            old = json.loads(receipt.read_text()) if receipt.exists() else {}
            assert not old or old['pdf_sha256'] == digest, 'PDF changed; review previous OCR receipt'
            if old.get('status') == 'completed' and target.exists():
                assert hashlib.sha256(target.read_bytes()).hexdigest() == old['xml_sha256']
                print('OCR_CACHED', number, flush=True)
                return old
            assert not target.exists(), 'Untracked existing MusicXML; refusing overwrite'
            # Keep the remote id immediately, so interruptions do not duplicate jobs.
            if old.get('status') in ('submitted', 'poll_timeout'):
                record.update(old)
            else:
                submitted = request('/omr/jobs', {'filename': pdf.name,
                    'pdfBase64': base64.b64encode(pdf.read_bytes()).decode()})
                record.update(job_id=submitted['id'], status='submitted')
                save(receipt, record)
            deadline = time.monotonic() + 900
            while True:
                state = request('/omr/jobs/' + record['job_id'])
                if state['status'] in ('completed', 'failed'):
                    break
                if time.monotonic() >= deadline:
                    record['status'] = 'poll_timeout'
                    save(receipt, record)
                    return record
                time.sleep(5)
            if state['status'] == 'failed':
                raise ValueError(state.get('error', 'OCR failed'))
            result = state['result']
            xml = result['musicXml']
            try:
                notes = parse_score(xml)
                compatible, reason = True, None
            except ValueError as exc:
                notes = []
                compatible, reason = False, str(exc)
            assert compatible == result['compatible'], 'Local/service parser compatibility mismatch'
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix('.musicxml.tmp')
            temp.write_text(xml)
            temp.replace(target)
            record.update(status='completed', compatible=compatible, reason=reason,
                          note_count=len(notes), measure_count=result['measureCount'],
                          musicxml=str(target.relative_to(DATA)),
                          xml_sha256=hashlib.sha256(target.read_bytes()).hexdigest())
        except Exception as exc:
            record.update(status='failed', error_type=type(exc).__name__, error=str(exc))
        save(receipt, record)
        print('OCR_RESULT', number, record['status'], record.get('compatible'), record.get('reason'), flush=True)
        return record

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        records = list(pool.map(convert, [n for n in range(1, 35) if n != 5]))
    summary = {'requested': 33, 'completed': sum(r['status'] == 'completed' for r in records),
               'compatible': sum(r.get('compatible') is True for r in records),
               'existing_etudes': [5], 'records': records}
    save(DATA / 'results/omr-summary.json', summary)
    print('OCR_SUMMARY', summary['completed'], summary['compatible'], flush=True)
    assert summary['completed'] == 33, 'Some OCR jobs failed; inspect saved receipts'
    print('ALL_33_OCR_OUTPUTS_SAVED', flush=True)


if __name__ == '__main__':
    main()
