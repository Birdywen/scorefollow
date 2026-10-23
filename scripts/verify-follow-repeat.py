"""Follow a real take that plays the repeats: the button is enabled, the shade goes back to
bar 1 for the second pass, and every bar switch leads its played downbeat.
Inputs are a stored analysis job (result.json + score.musicxml) plus the PDF and the take."""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8795/scorefollow/')
parser.add_argument('--job', required=True, help='stored analysis job dir')
parser.add_argument('--pdf', required=True)
parser.add_argument('--audio', required=True)
parser.add_argument('--seconds', type=float, default=34.0)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
job = Path(args.job)
raw = json.loads((job / 'result.json').read_text())
result = raw.get('result', raw)
# Re-assess with this tree's quality rules, as the service will after deploy.
q = subprocess.run([sys.executable, '-c', 'import json,sys; from analysis_service.quality import assess_quality;'
                    'r=json.load(sys.stdin); print(json.dumps(assess_quality(r)))'],
                   input=json.dumps(result), capture_output=True, text=True, cwd=root, check=True)
result['quality'] = json.loads(q.stdout)
assert result['quality']['followReady'], result['quality']
# Bar starts the app will use (same function as the page).
import tempfile
_rf = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
json.dump(result, _rf)
_rf.close()
starts = json.loads(subprocess.run(['node', '--input-type=module', '-'], cwd=root, capture_output=True, text=True, check=True, input='''
import ts from "typescript"; import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { join } from "node:path";
import { tmpdir } from "node:os"; import { pathToFileURL } from "node:url";
const d = mkdtempSync(join(tmpdir(), "sf-rep-"));
writeFileSync(join(d, "fa.mjs"), ts.transpileModule(readFileSync("lib/follow-anchors.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
const { followAnchors } = await import(pathToFileURL(join(d, "fa.mjs")));
const r = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(followAnchors(r.measureIntervals, r.notes, r.syncSuggestion?.appliedOffsetSec ?? 0).starts));
'''.replace('readFileSync(0, "utf8")', 'readFileSync(process.env.R, "utf8")'), env={'R': _rf.name, 'PATH': '/usr/bin:/bin:/usr/local/bin'}).stdout)

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    reqs = []
    page.on('request', lambda r: reqs.append(r.method + ' ' + r.url) if '_next' not in r.url and r.resource_type in ('fetch', 'xhr') else None)
    page.route('**/jobs**', lambda r: r.fulfill(json={
        'id': 'fixture', 'status': 'queued' if r.request.method == 'POST' else 'completed', 'result': result}))
    page.goto(args.url, wait_until='networkidle')
    page.locator('input[accept=".pdf"]').set_input_files(args.pdf)
    page.get_by_text('小节').first.wait_for(timeout=90000)
    page.get_by_role('button', name=re.compile('^((演奏)?分析|Analyze)$')).click()
    panel = page.get_by_role('complementary', name=re.compile('Performance analysis|演奏分析'))
    panel.locator('input[accept=".xml,.musicxml"]').set_input_files(str(job / 'score.musicxml'))
    panel.locator('select:has(option[value=piano])').select_option('piano', force=True)
    panel.locator('input[accept^="audio/"]').set_input_files(args.audio)
    panel.get_by_role('button', name=re.compile('^(Analyze|分析这一遍)$')).click()
    follow = page.get_by_role('dialog', name=re.compile('演奏报告|Performance report')).get_by_role(
        'button', name=re.compile('用这一遍走谱|Follow with this take'))
    try:
        follow.wait_for(timeout=60000)
    except Exception:
        print('REQS', reqs[-10:], 'PANEL_TEXT', panel.inner_text()[:1200], 'DIALOGS', page.evaluate(
            "[...document.querySelectorAll('[role=dialog]')].map(d=>d.getAttribute('aria-label')+': '+d.innerText.slice(0,600))"), errors)
        raise
    assert follow.is_enabled(), 'follow button disabled'
    follow.click()
    audio = page.locator('audio').last
    first_pass_end = next(s['startSec'] for i, s in enumerate(starts) if i and s['measure'] < starts[i - 1]['measure'])
    t0 = max(0, first_pass_end - args.seconds / 2)
    audio.evaluate('(e,t)=>{e.currentTime=t;return e.play()}', t0)
    page.wait_for_function("document.querySelector('.demaat') !== null")
    switches = page.evaluate('''(ms) => new Promise((done) => {
        const a = [...document.querySelectorAll('audio')].pop(), out = []; let last = null;
        const t0 = performance.now();
        const loop = () => {
            const d = document.querySelector('.demaat'), key = d && d.style.left + ',' + d.style.top;
            if (key !== last) { out.push({ t: a.currentTime, key }); last = key; }
            if (performance.now() - t0 < ms) requestAnimationFrame(loop); else done(out);
        };
        requestAnimationFrame(loop);
    })''', args.seconds * 1000)
    notes = page.locator('[role=status], p').filter(has_text=re.compile('阴影可能错位|shade may misalign')).count()
    browser.close()

# Each switch belongs to the next bar start after it; the shade's position must match that bar.
key_of_measure, leads, bad = {}, [], []
for s in switches[1:]:
    nxt = min((b for b in starts if b['startSec'] >= s['t'] - 0.02), key=lambda b: b['startSec'], default=None)
    if not nxt:
        continue
    lead = round(nxt['startSec'] - s['t'], 3)
    leads.append(lead)
    prev = key_of_measure.setdefault(nxt['measure'], s['key'])
    if prev != s['key']:
        bad.append((nxt['measure'], prev, s['key']))
back = [b for i, b in enumerate(starts) if i and b['measure'] < starts[i - 1]['measure'] and t0 < b['startSec'] < t0 + args.seconds]
print(json.dumps({'switches': len(switches), 'repeatJumps': len(back), 'leadMin': min(leads), 'leadMax': max(leads),
                  'leadMedian': sorted(leads)[len(leads) // 2], 'misplaced': bad[:3], 'mismatchWarning': notes, 'errors': errors}))
assert len(leads) >= 10 and back, 'expected a repeat jump inside the window'
assert not bad, 'a bar showed in two places'
assert all(0.07 < l < 0.2 for l in leads), sorted(leads)
assert not errors, errors
print('FOLLOW_REPEAT_OK')
