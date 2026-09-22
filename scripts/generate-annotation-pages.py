"""Generate human-reviewable comparison pages for manual annotation.

Usage: python3 scripts/generate-annotation-pages.py [score...]
Output: benchmarks/annotations/{score}/page_{n}.html

Priority order (when no args):
  P0: toccatta p2/p3, rococo p2, serenade p4, suzuki p2
  P1: kupdf p2, swan p1, saint-preux (all), arpeggione, vivaldi, yradier
"""
import json
import base64
from pathlib import Path
from collections import defaultdict

root = Path(__file__).resolve().parents[1]
gpu_dir = root / 'benchmarks' / 'gpu'
report_path = Path('/tmp/opencode/v6-audit.json')

if not report_path.exists():
    raise SystemExit('Run: SF_BENCH_ROOT=benchmarks/gpu SF_REPORT=/tmp/opencode/v6-audit.json node scripts/homr-compare.mjs')

report = json.loads(report_path.read_text())
records_by_score = defaultdict(lambda: defaultdict(list))
for rec in report['records']:
    records_by_score[rec['score']][rec['page']].append(rec)

P0 = {'toccatta': [2, 3], 'tschaikowsky_rococo_gru_mmer_cello': [2],
      'serenade_vl_pf': [4], 'suzuki-book3-3-4': [2]}

import sys
if len(sys.argv) > 1:
    target = {s: None for s in sys.argv[1:]}
else:
    target = P0

out_root = root / 'benchmarks' / 'annotations'
out_root.mkdir(parents=True, exist_ok=True)

for score, pages in target.items():
    score_dir = gpu_dir / score
    if not score_dir.exists():
        print(f'skip {score}: no data')
        continue
    meta = json.loads((score_dir / 'meta.json').read_text())
    homr = json.loads((score_dir / 'homr.json').read_text())
    ours = json.loads((score_dir / 'ours.json').read_text())
    
    page_nums = pages if pages else sorted({r['page'] for r in records_by_score[score].values()})
    
    for pnum in page_nums:
        pm = next((p for p in meta['pages'] if p['page'] == pnum), None)
        if not pm:
            continue
        
        png_path = score_dir / f'page_{pnum}.png'
        if not png_path.exists():
            print(f'skip {score} p{pnum}: no PNG')
            continue
        
        img_b64 = base64.b64encode(png_path.read_bytes()).decode()
        op = ours['pages'][pnum - 1]
        hp = homr[pnum - 1]
        
        # Scale HOMR to our coordinates
        hspace_w = hp.get('image_size', {}).get('w', 1653)
        hspace_h = hp.get('image_size', {}).get('h', 2339)
        sx = pm['w'] / hspace_w
        sy = pm['h'] / hspace_h
        
        homr_groups = []
        for ms in hp['bbox']['staffs']:
            subs = ms['sub']
            y1 = min(s['min_y'] for s in subs) * sy
            y2 = max(s['max_y'] for s in subs) * sy
            x2 = max(s['max_x'] for s in subs) * sx
            bars = []
            for s in subs:
                for b in s['bar_lines']:
                    bars.append(b['cx'] * sx)
            # Dedupe
            bars_s = sorted(bars)
            dedup = []
            for x in bars_s:
                if not dedup or x - dedup[-1] >= 8:
                    dedup.append(x)
            bars_filtered = [x for x in dedup if abs(x - x2) > 4]
            homr_groups.append({'y1': y1, 'y2': y2, 'bars': bars_filtered})
        
        recs = records_by_score[score][pnum]
        
        html = f'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{score} page {pnum} - Manual Annotation</title>
<style>
body {{ font-family: monospace; margin: 20px; background: #1a1a1a; color: #e0e0e0; }}
.container {{ max-width: 1400px; margin: 0 auto; }}
h1 {{ color: #4a9eff; }}
.summary {{ background: #2a2a2a; padding: 15px; border-radius: 5px; margin: 20px 0; }}
.summary div {{ margin: 5px 0; }}
.controls {{ background: #2a2a2a; padding: 15px; border-radius: 5px; margin: 20px 0; }}
.controls label {{ margin-right: 20px; cursor: pointer; }}
.controls input[type=checkbox] {{ margin-right: 5px; }}
.canvas-wrap {{ position: relative; display: inline-block; background: white; }}
canvas {{ display: block; cursor: crosshair; }}
.legend {{ margin: 20px 0; }}
.legend span {{ display: inline-block; margin-right: 20px; padding: 5px 10px; border-radius: 3px; }}
.leg-ours {{ background: #00ff00; color: black; }}
.leg-homr {{ background: #ff6b6b; color: white; }}
.leg-match {{ background: #4a9eff; color: white; }}
.systems {{ margin: 20px 0; }}
.system {{ background: #2a2a2a; padding: 10px; margin: 10px 0; border-radius: 5px; }}
.system h3 {{ margin: 5px 0; color: #4a9eff; }}
.bar-item {{ display: inline-block; margin: 2px 5px; padding: 3px 8px; border-radius: 3px; }}
.bar-tp {{ background: #00ff00; color: black; }}
.bar-fp {{ background: #ff6b6b; color: white; }}
.bar-fn {{ background: #ffaa00; color: black; }}
.annotation {{ margin: 20px 0; padding: 15px; background: #2a2a2a; border-radius: 5px; }}
.annotation h2 {{ color: #4a9eff; }}
textarea {{ width: 100%; min-height: 150px; background: #1a1a1a; color: #e0e0e0; border: 1px solid #4a9eff; padding: 10px; font-family: monospace; }}
button {{ background: #4a9eff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }}
button:hover {{ background: #3a8edf; }}
.saved {{ color: #00ff00; margin-left: 10px; }}
</style>
</head>
<body>
<div class="container">
<h1>{score} — Page {pnum}</h1>
<div class="summary">
<div><strong>Image:</strong> {pm['w']}×{pm['h']} px</div>
<div><strong>Systems:</strong> Ours={len(op['systems'])} HOMR={len(homr_groups)}</div>
<div><strong>Reference total:</strong> {sum(len(g["bars"]) for g in homr_groups)} bars</div>
</div>

<div class="controls">
<label><input type="checkbox" id="showOurs" checked> Show Ours (green)</label>
<label><input type="checkbox" id="showHomr" checked> Show HOMR (red)</label>
<label><input type="checkbox" id="showSystems" checked> Show System Boxes</label>
<label>Line width: <input type="range" id="lineWidth" min="1" max="5" value="2" style="width:100px"></label>
</div>

<div class="legend">
<span class="leg-match">Match (within 4px)</span>
<span class="leg-ours">Ours only (FP candidate)</span>
<span class="leg-homr">HOMR only (FN candidate)</span>
</div>

<div class="canvas-wrap">
<canvas id="canvas" width="{pm['w']}" height="{pm['h']}"></canvas>
</div>

<div class="systems">
<h2>System Breakdown</h2>
'''
        
        for i, rec in enumerate(recs):
            status = 'UNMATCHED' if rec.get('unmatched') else 'MATCHED'
            html += f'<div class="system"><h3>System {rec["sys"]} ({status})</h3>'
            if not rec.get('unmatched'):
                tp_count = len(rec.get('want', [])) - len(rec.get('miss', []))
                html += f'<div>TP={tp_count}/{len(rec.get("want", []))} FP={len(rec.get("extra", []))} FN={len(rec.get("miss", []))}</div>'
                html += '<div>'
                for x in sorted(rec.get('internal', [])):
                    if x in rec.get('extra', []):
                        html += f'<span class="bar-item bar-fp">{round(x)}</span>'
                    else:
                        html += f'<span class="bar-item bar-tp">{round(x)}</span>'
                for x in sorted(rec.get('miss', [])):
                    html += f'<span class="bar-item bar-fn">{round(x)} miss</span>'
                html += '</div>'
            else:
                html += f'<div>FP={len(rec.get("internal", []))}</div>'
                html += '<div>'
                for x in sorted(rec.get('internal', [])):
                    html += f'<span class="bar-item bar-fp">{round(x)}</span>'
                html += '</div>'
            html += '</div>'
        
        html += f'''
</div>

<div class="annotation">
<h2>Manual Annotation</h2>
<p>Review the overlay and system breakdown above. Record:</p>
<ul>
<li>System boundaries (y1, y2) if incorrect</li>
<li>True bar positions (x coordinates)</li>
<li>Notes on ambiguous cases (double bars, repeat signs, clef changes, etc.)</li>
</ul>
<textarea id="notes" placeholder="System 1: y=[165,193] bars=[310,558,...]
System 2: ...
Notes: sys4 x=467 is a valid barline touching beam; sys7 x=238 is clef area, not a measure boundary"></textarea>
<button onclick="saveAnnotation()">Save Annotation</button>
<span id="saveStatus"></span>
</div>

<script>
const img = new Image();
img.src = 'data:image/png;base64,{img_b64}';
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const oursSystems = {json.dumps(op['systems'])};
const oursBars = {json.dumps(op['bars'])};
const homrGroups = {json.dumps(homr_groups)};
const records = {json.dumps(recs)};

img.onload = () => {{
  draw();
}};

function draw() {{
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  
  const showOurs = document.getElementById('showOurs').checked;
  const showHomr = document.getElementById('showHomr').checked;
  const showSystems = document.getElementById('showSystems').checked;
  const lineWidth = parseInt(document.getElementById('lineWidth').value);
  
  if (showSystems) {{
    ctx.strokeStyle = 'rgba(74, 158, 255, 0.5)';
    ctx.lineWidth = 1;
    oursSystems.forEach(s => {{
      ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
    }});
  }}
  
  const TOL = 4;
  const allHomr = homrGroups.flatMap(g => g.bars);
  const allOurs = oursBars.flatMap((b, i) => b.slice(1, -1).map(x => ({{x, sys: i}})));
  
  if (showOurs) {{
    allOurs.forEach(o => {{
      const matched = allHomr.some(h => Math.abs(h - o.x) <= TOL);
      ctx.strokeStyle = matched ? 'rgba(74, 158, 255, 0.7)' : 'rgba(0, 255, 0, 0.7)';
      ctx.lineWidth = lineWidth;
      const s = oursSystems[o.sys];
      ctx.beginPath();
      ctx.moveTo(o.x, s.y1);
      ctx.lineTo(o.x, s.y2);
      ctx.stroke();
    }});
  }}
  
  if (showHomr) {{
    homrGroups.forEach(g => {{
      g.bars.forEach(x => {{
        const matched = allOurs.some(o => Math.abs(o.x - x) <= TOL);
        if (!matched) {{
          ctx.strokeStyle = 'rgba(255, 107, 107, 0.7)';
          ctx.lineWidth = lineWidth;
          ctx.beginPath();
          ctx.moveTo(x, g.y1);
          ctx.lineTo(x, g.y2);
          ctx.stroke();
        }}
      }});
    }});
  }}
}}

document.getElementById('showOurs').addEventListener('change', draw);
document.getElementById('showHomr').addEventListener('change', draw);
document.getElementById('showSystems').addEventListener('change', draw);
document.getElementById('lineWidth').addEventListener('input', draw);

function saveAnnotation() {{
  const notes = document.getElementById('notes').value;
  const data = {{
    score: '{score}',
    page: {pnum},
    timestamp: new Date().toISOString(),
    notes: notes,
    systems: oursSystems.map((s, i) => ({{
      index: i + 1,
      y1: s.y1,
      y2: s.y2,
      oursBars: oursBars[i] || [],
    }})),
    homrGroups: homrGroups,
  }};
  
  const blob = new Blob([JSON.stringify(data, null, 2)], {{type: 'application/json'}});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '{score}_page{pnum}_annotation.json';
  a.click();
  
  document.getElementById('saveStatus').textContent = '✓ Saved';
  setTimeout(() => {{
    document.getElementById('saveStatus').textContent = '';
  }}, 3000);
}}
</script>
</div>
</body>
</html>
'''
        
        out_file = out_root / f'{score}_page{pnum}.html'
        out_file.write_text(html)
        print(f'Generated: {out_file}')

print(f'\\nAnnotation pages: {out_root}/')
print('Open in browser, review overlays, save JSON when done.')
