"""Follow-a-take timing: the shade must switch bars slightly before the bar's first note
(measure start - 35 ms map lead - 100 ms playback lead), never after it.
Same fixtures as verify-follow-cursor.py; known measure starts isolate the player side."""
import argparse
import json
import re
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8795/scorefollow/')
parser.add_argument('--rate', type=float, default=1.0)
args = parser.parse_args()
START = lambda m: (m - 1) * 1.4 + .5
EXPECT_LEAD = 0.035 + 0.1 * args.rate  # media seconds before the measure start
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    result = {
        'version': 'cursor-fixture', 'instrument': 'cello', 'limitations': [], 'notes': [],
        'summary': {'pitchScore': 99, 'rhythmScore': 86, 'noteCount': 0, 'voicedNotes': 0, 'timedNotes': 0,
                    'measureCount': 79, 'confidence': 'high', 'timingOffsetMs': None, 'timingSpreadMs': None},
        'measureIntervals': [{'measure': m, 'startSec': START(m), 'endSec': START(m + 1)} for m in range(1, 80)],
    }
    page.route('**/jobs**', lambda r: r.fulfill(json={
        'id': 'fixture', 'status': 'queued' if r.request.method == 'POST' else 'completed', 'result': result}))
    page.goto(args.url, wait_until='networkidle')
    page.locator('input[accept=".pdf"]').set_input_files('/tmp/gt-32264a94/Dotzauer Cello Etude no. 5 Book 1.pdf')
    page.get_by_text('小节').first.wait_for(timeout=90000)
    page.get_by_role('button', name=re.compile('^((演奏)?分析|Analyze)$')).click()
    panel = page.get_by_role('complementary', name=re.compile('Performance analysis|演奏分析'))
    panel.locator('input[accept=".xml,.musicxml"]').set_input_files('/tmp/gt-193cbc0e/Dotzauer Cello Etude no. 5 Book 1.musicxml')
    panel.locator('input[accept^="audio/"]').set_input_files('/tmp/gt-50bf663d/Dotzauer Cello Etude no. 5 Book 1.mp3')
    panel.get_by_role('button', name=re.compile('^(Analyze|分析这一遍)$')).click()
    page.get_by_role('dialog', name=re.compile('演奏报告|Performance report')).get_by_role(
        'button', name=re.compile('用这一遍走谱|Follow with this take')).click()
    audio = page.locator('audio').last
    audio.evaluate('(e)=>{e.currentTime=2.5;return e.play()}')
    page.wait_for_function("document.querySelector('.demaat') !== null")
    # The player applies its own speed on play; change the rate after that, as a user would.
    audio.evaluate('(e,r)=>{e.playbackRate=r}', args.rate)
    rate = audio.evaluate('(e)=>e.playbackRate')
    # Log every shade move against the audio clock, on each animation frame.
    switches = page.evaluate('''(ms) => new Promise((done) => {
        const a = [...document.querySelectorAll('audio')].pop(), out = []; let last = null;
        const t0 = performance.now();
        const loop = () => {
            const d = document.querySelector('.demaat'), key = d && d.style.left + ',' + d.style.top;
            if (key !== last) { out.push({ t: a.currentTime, key }); last = key; }
            if (performance.now() - t0 < ms) requestAnimationFrame(loop); else done(out);
        };
        requestAnimationFrame(loop);
    })''', 9000 / args.rate)
    browser.close()
leads = []
for s in switches[1:]:
    m = min(range(1, 80), key=lambda k: abs(START(k) - s['t']))
    leads.append(round(START(m) - s['t'], 3))
assert abs(rate - args.rate) < 1e-6, rate
print(json.dumps({'rate': rate, 'expectLead': EXPECT_LEAD, 'leads': leads, 'errors': errors}))
assert len(leads) >= 4, switches
# A frame is ~17 ms; currentTime itself moves in steps, so allow 60 ms either side.
assert all(abs(l - EXPECT_LEAD) < 0.06 for l in leads), leads
assert not errors, errors
print(f'FOLLOW_LEAD_OK {args.rate}')
