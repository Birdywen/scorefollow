"""Immutable local baseline snapshot (run before changing the detector)."""
import hashlib
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
dest = root / 'benchmarks' / 'snapshots' / 'v6-before-audit'
if dest.exists():
    raise SystemExit('Snapshot exists; refusing to overwrite')
dest.mkdir(parents=True)
shutil.copy2(root / 'lib/synpdf-legacy.ts', dest / 'synpdf-legacy.ts')
manifest = []
for suite in ('gpu', 'homr'):
    for meta_path in sorted((root / 'benchmarks' / suite).glob('*/meta.json')):
        source = meta_path.parent
        target = dest / suite / source.name
        target.mkdir(parents=True)
        for name in ('meta.json', 'homr.json', 'ours.json'):
            if (source / name).exists():
                shutil.copy2(source / name, target / name)
        pdf = Path(json.loads(meta_path.read_text())['pdf'])
        manifest.append({'suite': suite, 'score': source.name,
                         'pdf_sha256': hashlib.sha256(pdf.read_bytes()).hexdigest() if pdf.exists() else None})
(dest / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(dest)
