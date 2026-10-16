// Exercise the real OCR entry point with a deterministic completed OCR response.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/snap/bin/chromium', downloadsPath: process.env.SF_DOWNLOADS_PATH || '/home/ubuntu/snap/chromium/common/score-preview-downloads', headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/omr/jobs', route => route.fulfill({ json: { id: 'preview-fixture', status: 'completed', result: { musicXml: xml, compatible: true, noteCount: 1, measureCount: 1, restoredFirstRest: false } } }));
    await page.goto(process.env.SF_UI_URL || 'http://127.0.0.1:8901/scorefollow/', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^(演奏分析|Analyze)$/ }).click();
    await page.getByText(/^(从 PDF 识别（OMR，可选）|Recognize from PDF \(OMR, optional\))$/).click();
    await page.getByLabel(/另选用于识别的 PDF|PDF for recognition/).setInputFiles({ name: 'preview.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nfixture') });
    await page.getByRole('button', { name: /^(识别 PDF|Recognize PDF)$/ }).click();
    const trigger = page.getByRole('button', { name: /预览识别乐谱|Preview recognized score/ });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: /识别乐谱预览|Recognized score preview/ });
    await dialog.locator('svg').first().waitFor();
    const box = await dialog.boundingBox();
    assert(box && box.width >= width * .85 && box.x >= 0 && box.x + box.width <= width, 'large dialog fits viewport');
    const close = dialog.getByRole('button', { name: /关闭预览|Close preview/ });
    await close.focus();
    await page.keyboard.press('Tab');
    assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'focus stays in modal');
    const before = await dialog.locator('svg').first().getAttribute('height');
    await dialog.getByLabel(/预览缩放|Preview zoom/).selectOption('200');
    await page.waitForFunction(h => document.querySelector('dialog svg')?.getAttribute('height') !== h && !!document.querySelector('dialog svg'), before);
    await dialog.getByLabel(/转调半音数|Transposition in semitones/).selectOption('2');
    await dialog.locator('svg').first().waitFor();
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /下载当前预览的 MusicXML|Download the previewed MusicXML/ }).click();
    const download = await pending;
    assert.equal(download.suggestedFilename(), 'preview_t+2.musicxml');
    const saved = readFileSync(await download.path(), 'utf8');
    assert.match(saved, /<step>D<\/step><octave>3<\/octave>/);
    await page.screenshot({ path: `/tmp/opencode/score-preview-${width}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert(await trigger.evaluate(el => el === document.activeElement), 'focus returned');
    assert.deepEqual(errors, []);
    console.log(`SCORE_PREVIEW_OK ${width}: OCR entry, large modal, focus, zoom, transposed download, Escape`);
    await page.close();
  }
} finally { await browser.close(); }
