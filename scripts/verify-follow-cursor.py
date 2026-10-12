"""Real audio/PDF playback; deterministic alignment isolates cursor rendering."""
import argparse
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='https://mega-metro.online/scorefollow/')
parser.add_argument('--patched-engine', action='store_true')
parser.add_argument('--expect-hidden', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    if args.patched_engine:
        page.route('**/metro-engine.js*', lambda r: r.fulfill(
            content_type='text/javascript', body=(root / 'public/metro-engine.js').read_text()))
    result = {
        'version': 'cursor-fixture', 'instrument': 'cello', 'limitations': [], 'notes': [],
        'summary': {'pitchScore': 99, 'rhythmScore': 86, 'noteCount': 0,
                    'voicedNotes': 0, 'timedNotes': 0, 'measureCount': 79, 'confidence': 'high',
                    'timingOffsetMs': None, 'timingSpreadMs': None},
        'measureIntervals': [{'measure': m, 'startSec': (m-1)*1.4+.5,
                              'endSec': m*1.4+.5} for m in range(1, 80)],
    }
    page.route('**/jobs**', lambda r: r.fulfill(json={
        'id': 'fixture', 'status': 'queued' if r.request.method == 'POST' else 'completed',
        'result': result,
    }))
    page.goto(args.url, wait_until='networkidle')
    page.locator('input[accept=".pdf"]').set_input_files(
        '/tmp/gt-32264a94/Dotzauer Cello Etude no. 5 Book 1.pdf')
    page.get_by_text('小节').first.wait_for(timeout=90000)
    page.get_by_role('button', name=re.compile('^(Analyze|演奏分析)$')).click()
    panel = page.get_by_role('complementary', name=re.compile('Performance analysis|演奏分析'))
    panel.locator('input[accept=".xml,.musicxml"]').set_input_files(
        '/tmp/gt-193cbc0e/Dotzauer Cello Etude no. 5 Book 1.musicxml')
    panel.locator('input[accept^="audio/"]').set_input_files(
        '/tmp/gt-50bf663d/Dotzauer Cello Etude no. 5 Book 1.mp3')
    panel.get_by_role('button', name=re.compile('^(Analyze|分析这一遍)$')).click()
    try:
        panel.get_by_role('button', name=re.compile('用这一遍走谱|Follow with this take')).click()
    except Exception:
        print('PANEL_DIAGNOSTIC', panel.inner_text(), 'PAGE_ERRORS', errors)
        raise
    audio = page.locator('audio').last
    audio.evaluate('(e)=>e.play()')
    page.wait_for_function("document.querySelector('.demaat') !== null")
    frames = []
    for target in [1, 5, 60]:
        if target == 5:
            # Let playback advance naturally across measures before testing a seek.
            page.wait_for_timeout(4000)
        else:
            audio.evaluate('(e,t)=>{e.currentTime=t}', target)
            page.wait_for_timeout(400)
        frame = page.locator('.demaat').evaluate('''e=>{
            const s=getComputedStyle(e),r=e.getBoundingClientRect();
            return {opacity:s.opacity,display:s.display,visibility:s.visibility,
                x:r.x,y:r.y,w:r.width,h:r.height,left:e.style.left,top:e.style.top};
        }''')
        frame['time'] = audio.evaluate('(e)=>e.currentTime')
        assert not audio.evaluate('(e)=>e.paused'), 'Score audio unexpectedly paused'
        frames.append(frame)
    assert frames[1]['time'] > frames[0]['time'] + 3, frames
    assert len({(f['left'], f['top']) for f in frames}) == 3, frames
    for f in frames:
        assert f['w'] > 0 and f['h'] > 0, f
        if args.expect_hidden:
            assert float(f['opacity']) == 0, f
        else:
            assert float(f['opacity']) > 0 and f['display'] != 'none' and f['visibility'] == 'visible', f
    assert not errors, errors
    assert page.locator('#sga-shade').evaluate('(e)=>getComputedStyle(e).display') == 'none'
    print(json.dumps({'url': args.url, 'frames': frames, 'errors': errors}))
    browser.close()
print('HIDDEN_CURSOR_REPRODUCED' if args.expect_hidden else 'VISIBLE_FOLLOW_OK')
