// The piano report lists where hidden rests were filled from the recording and draws each measure
// before and after (grey rests = the ones the print leaves out). Needs a built app: SF_UI_URL.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const n = (pitch, dur, voice, staff, type) => `<note>${pitch}<duration>${dur}</duration><voice>${voice}</voice><type>${type}</type><staff>${staff}</staff></note>`;
const p = (s, o) => `<pitch><step>${s}</step><octave>${o}</octave></pitch>`;
const attrs = `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
const bar = (num, a) => `<measure number="${num}">${a}${n(p("D", 5), 4, 1, 1, "quarter")}${n(p("E", 5), 4, 1, 1, "quarter")}<backup><duration>8</duration></backup>`
  + `${n(p("B", 2), 2, 6, 2, "eighth")}${n(p("C", 3), 2, 6, 2, "eighth")}</measure>`;
const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${bar(1, attrs)}${bar(2, "")}</part></score-partwise>`;
const fixes = [1, 2].map((m) => ({ part: 0, measure: m, number: String(m), staff: "2", voice: "6", from: [0, 0.5], to: [0, 1] }));
const result = {
  version: "piano-align-0.7.1", instrument: "piano", limitations: [],
  notes: [{ id: "n1", measure: 1, pitchMidi: 74, expectedSec: 0.2, performedSec: 0.21, pitchErrorCents: 0, timingErrorMs: 10, confidence: 0.95, status: "correct", pitchStatus: "correct" }],
  measureIntervals: [{ measure: 1, startSec: 0, endSec: 1 }, { measure: 2, startSec: 1, endSec: 2 }],
  summary: { pitchScore: 100, rhythmScore: 90, noteCount: 8, voicedNotes: 8, timedNotes: 8, confidence: "high", timingOffsetMs: 0, timingSpreadMs: 10,
    pitchScoreMethod: "evidence-f1", missedNotes: 0, extraNotes: 0, voiceFixes: fixes,
    scoreCheck: { pitch: "ok", rhythm: "ok", excludedNotes: 0, evidence: [{ kind: "voice_filled", measures: [1, 2], count: 2,
      zh: "第 1–2 小节：有声部被识别成挤在小节开头（谱上省略了休止符），已按录音补上隐藏休止符再评分（共 2 处，乐谱外观不变）。",
      en: "m1–2: a voice was read as packed to the start of the bar (a rest left unprinted); hidden rests were filled from the recording before scoring (2 places, printed score unchanged)." }] } },
};
const rate = 22050, samples = rate * 3, wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);

const url = process.env.SF_UI_URL || "http://127.0.0.1:8794/scorefollow/";
const shots = process.env.SF_SHOTS || "/tmp";
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/jobs**", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(route.request().method() === "POST" ? { id: `vf-${width}`, status: "queued" } : { id: `vf-${width}`, status: "completed", result }) }));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^((演奏)?分析|Analyze)$/ }).click();
    const panel = page.getByRole("complementary", { name: /Performance analysis|演奏分析/ });
    await page.evaluate(() => document.querySelectorAll("aside details").forEach((d) => { d.open = true; }));
    await panel.getByLabel(/^(乐器|Instrument)/).selectOption("piano");
    await panel.locator('input[accept=".xml,.musicxml"]').setInputFiles({ name: "score.musicxml", mimeType: "application/xml", buffer: Buffer.from(xml) });
    await panel.locator('input[accept^="audio/"]').setInputFiles({ name: "take.wav", mimeType: "audio/wav", buffer: wav });
    await panel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
    const report = page.getByRole("region", { name: /Analysis report|分析报告/ });
    await report.locator("summary").filter({ hasText: /技术细节|Technical details/ }).click();
    const zh = await report.getByText(/谱面检查/).count() > 0;
    const list = report.getByTestId("voice-fixes");
    await list.locator("summary").filter({ hasText: zh ? "查看补在哪里（2 个小节，共 2 处）" : "See where (2 measures, 2 places)" }).click();
    await list.getByText(zh ? "低音谱表声部 6：第 1、1.5 拍 → 第 1、2 拍" : "lower staff voice 6: beats 1, 1.5 → 1, 2").first().waitFor();
    const m1 = list.getByRole("button", { name: zh ? /^第 1 小节/ : /^m1/ });
    await m1.click();
    assert.equal(await m1.getAttribute("aria-expanded"), "true");
    const figs = list.locator("figure");
    await figs.nth(1).locator("svg").first().waitFor();
    assert.equal(await figs.count(), 2);
    await list.getByText(zh ? /灰色休止符是谱上省略的/ : /grey rests are the ones the print leaves out/).waitFor();
    const grey = (i) => figs.nth(i).locator("svg").evaluate((svg) => /#9aa0a6/i.test(svg.outerHTML));
    assert.equal(await grey(0), false, "before: no added rests");
    assert.equal(await grey(1), true, "after: the hidden rest is drawn grey");
    await figs.nth(1).scrollIntoViewIfNeeded();
    if (width === 1280) for (const [i, name] of [[0, "before"], [1, "after"]]) await figs.nth(i).screenshot({ path: `${shots}/voice-fix-${name}.png` });
    await page.screenshot({ path: `${shots}/voice-fix-report-${width}.png` });
    // Opening the second measure closes the first.
    await list.getByRole("button", { name: zh ? /^第 2 小节/ : /^m2/ }).click();
    assert.equal(await m1.getAttribute("aria-expanded"), "false");
    await figs.nth(1).locator("svg").first().waitFor();
    // Another score loaded now: the comparison says so instead of drawing something wrong.
    await panel.locator('input[accept=".xml,.musicxml"]').setInputFiles({ name: "other.musicxml", mimeType: "application/xml", buffer: Buffer.from(xml.replace(/<duration>2<\/duration><voice>6/g, "<duration>4</duration><voice>6").replace(/<type>eighth/g, "<type>quarter")) });
    if (await list.count()) {
      const m2 = list.getByRole("button", { name: zh ? /^第 2 小节/ : /^m2/ });
      await m2.click(); await m2.click();
      await list.getByText(zh ? /当前载入的乐谱和分析时用的不一样/ : /not the one analyzed/).waitFor();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `no horizontal page scroll (${overflow})`);
    assert.deepEqual(errors, []);
    console.log(`VOICE_FIX_REPORT_OK ${width}`);
    await page.close();
  }
} finally { await browser.close(); }
