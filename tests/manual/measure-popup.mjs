import { chromium } from '@playwright/test';

const URL = 'http://localhost:3000/scorefollow/';
const PDF = '/home/user/scorefollow/public/chopin.pdf';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('header', { timeout: 30000 });

// load the real score
const inputs = page.locator('input[type="file"]');
const count = await inputs.count();
let loaded = false;
for (let i = 0; i < count; i++) {
  const accept = (await inputs.nth(i).getAttribute('accept')) || '';
  if (accept.includes('pdf')) {
    await inputs.nth(i).setInputFiles(PDF);
    loaded = true;
    break;
  }
}
if (!loaded) { console.log('NO_PDF_INPUT', { count }); await browser.close(); process.exit(1); }

await page.waitForSelector('[data-testid="score-load-status"][data-has-score="true"]', { timeout: 60000 });
await page.waitForTimeout(1500);

// enter adjust mode (existing shortcut)
await page.keyboard.press('j');
await page.waitForTimeout(500);

const box = await page.locator('#notation').first().boundingBox();
if (!box) { console.log('NO_NOTATION_BOX'); await browser.close(); process.exit(1); }

const POPUP = 'div[role="dialog"]:has(input#sf-barno)';
const results = [];

// probe several taps across the measures
const fracs = [
  [0.20, 0.25], [0.50, 0.25], [0.80, 0.25],
  [0.20, 0.60], [0.50, 0.60], [0.80, 0.60],
];

for (const [fx, fy] of fracs) {
  const tx = box.x + box.width * fx;
  const ty = box.y + box.height * fy;
  await page.mouse.click(tx, ty);
  await page.waitForTimeout(400);

  const pop = page.locator(POPUP).first();
  const visible = await pop.isVisible().catch(() => false);
  if (!visible) { results.push({ fx, fy, popup: false }); continue; }

  const r = await pop.boundingBox();
  const contains = tx >= r.x && tx <= r.x + r.width && ty >= r.y && ty <= r.y + r.height;
  const dx = Math.max(r.x - tx, tx - (r.x + r.width), 0);
  const dy = Math.max(r.y - ty, ty - (r.y + r.height), 0);
  const gap = Math.hypot(dx, dy);
  const inView = r.x >= 0 && r.y >= 0 && r.x + r.width <= 1280 && r.y + r.height <= 800;
  results.push({
    fx, fy,
    popup: true,
    popupBox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    tap: { x: Math.round(tx), y: Math.round(ty) },
    coversTapPoint: contains,
    gapToTapPx: Math.round(gap),
    fullyInViewport: inView,
  });
}

await page.screenshot({ path: '/tmp/popup-check.png' });
console.log(JSON.stringify(results, null, 2));
console.log('covers=' + results.filter((r) => r.coversTapPoint).length + '/' + results.filter((r) => r.popup).length);
console.log('offscreen=' + results.filter((r) => r.popup && !r.fullyInViewport).length);

await browser.close();
