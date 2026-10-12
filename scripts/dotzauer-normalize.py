#!/usr/bin/env python3
"""Create scoring projections; preserve all original OCR MusicXML files."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from analysis_service.monophonic_xml import normalize_monophonic
from analysis_service.engine import parse_score

DATA = ROOT / 'datasets/dotzauer-op113'


def main():
    output = DATA / 'musicxml-monophonic'
    output.mkdir(exist_ok=True)
    records = []
    for source in sorted((DATA / 'musicxml').glob('*.musicxml')):
        raw = source.read_text()
        xml, report = normalize_monophonic(raw)
        target = output / source.name
        target.write_text(xml)
        report.update(etude=int(source.stem[-2:]), source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                      output_sha256=hashlib.sha256(target.read_bytes()).hexdigest())
        try:
            notes = parse_score(xml)
            report.update(compatible=True, note_count=len(notes))
        except ValueError as exc:
            report.update(compatible=False, reason=str(exc))
        records.append(report)
        print('MONOPHONIC_XML', report['etude'], report['compatible'], report.get('reason', ''), flush=True)
    summary = {'records': records, 'compatible': sum(r['compatible'] for r in records)}
    (DATA / 'results/monophonic-normalization.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    assert len(records) == 34
    assert not any(any(word in r.get('reason', '') for word in ('双音', '和弦', '多声部', '单个乐器声部')) for r in records)
    print('ALL_34_XML_POLYPHONY_REMOVED', summary['compatible'], flush=True)


if __name__ == '__main__':
    main()
