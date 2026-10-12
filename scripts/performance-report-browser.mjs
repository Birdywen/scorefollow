// Real media playback + rendered chart regression, with a deterministic API fixture.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import ts from "typescript";

const preflightJs = ts.transpileModule(await readFile(new URL("../lib/analysis-preflight.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;

const root = resolve(process.env.SF_BROWSER_OUT ?? "out");
const base = process.env.SF_BROWSER_BASE ?? "/scorefollow";
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let path = resolve(root, "." + (base && url.pathname.startsWith(base + "/") ? url.pathname.slice(base.length) : url.pathname));
    if (!path.startsWith(root + "/") && path !== root) throw new Error("Invalid path");
    if (url.pathname.endsWith("/")) path += "/index.html";
    const bytes = await readFile(path);
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".html": "text/html" })[extname(path)] ?? "application/octet-stream");
    res.end(bytes);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const note = (id, measure, cents, status, pitchStatus) => ({ id, measure, pitchMidi: 69, expectedSec: .2 + (measure - 1) * .45, performedSec: null, pitchErrorCents: cents, timingErrorMs: null, confidence: .95, status, pitchStatus });
  const result = {
    version: "browser-fixture", instrument: "cello", limitations: [],
    // Deliberately stale engine verdicts: raw extreme values must still be excluded.
    notes: [note("n1", 1, 2400, "wrong_pitch", "sharp"), note("n2", 1, 1200, "wrong_pitch", "sharp"), note("n3", 2, 16, "wrong_pitch", "sharp"), note("n4", 2, -15, "correct", "correct"), note("n5", 2, 15, "correct", "correct"), note("n6", 2, -16, "wrong_pitch", "flat")],
    measureIntervals: [{ measure: 1, startSec: .2, endSec: .65 }, { measure: 2, startSec: .65, endSec: 1.1 }],
    summary: { pitchScore: 80, rhythmScore: null, noteCount: 4, voicedNotes: 4, timedNotes: 0, confidence: "medium", timingOffsetMs: null, timingSpreadMs: null, outlierNotes: 1, scoredPitchNotes: 2, correctPitchNotes: 1, wrongPitchNotes: 1 },
  };
  let submitted;
  await page.route("**/jobs**", async (route) => {
    if (route.request().method() === "POST") submitted = route.request().postDataJSON();
    const status = route.request().method() === "POST" ? { id: "fixture", status: "queued" } : { id: "fixture", status: "completed", result };
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }, body: JSON.stringify(status) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}${base}/`);
  const checks = await page.evaluate(async (source) => {
    const { inspectScoreXml } = await import(`data:text/javascript;base64,${source}`);
    const score = '<score-partwise xmlns="http://www.musicxml.org/ns/musicxml"><part id="P1"><measure><attributes><key><fifths>-1</fifths></key><time><beats>6</beats><beat-type>8</beat-type></time></attributes><note><pitch><step>B</step><octave>3</octave></pitch><duration>1</duration></note></measure></part></score-partwise>';
    return { namespaced: inspectScoreXml(score), repeat: inspectScoreXml(score.replace('</measure>', '<barline><repeat direction="backward"/></barline></measure>')),
      chord: inspectScoreXml(score.replace('<note>', '<note><chord/>')), entity: inspectScoreXml('<!ENTITY secret "x">' + score) };
  }, Buffer.from(preflightJs).toString("base64"));
  assert.deepEqual(checks.namespaced.errors, []);
  assert.equal(checks.namespaced.minMidi, 58, "Key signature must affect preflight pitch range (Bb3)");
  assert.ok(checks.namespaced.warnings.includes("compound_meter"));
  assert.ok(checks.repeat.errors.includes("repeats"));
  assert.ok(checks.chord.errors.includes("polyphonic"));
  assert.ok(checks.entity.errors.includes("entities"));
  await page.getByRole("button", { name: /^(Analyze|演奏分析)$/ }).click();
  const panel = page.getByRole("complementary", { name: /Performance analysis|演奏分析/ });
  const xml = '<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure><measure number="2"><note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>';
  await panel.locator('input[accept=".xml,.musicxml"]').setInputFiles({ name: "score.musicxml", mimeType: "application/xml", buffer: Buffer.from(xml) });
  await panel.getByRole("region", { name: /Score preflight|谱面预检/ }).getByText(/Structure check passed|结构预检通过/).waitFor();
  const rate = 22050, samples = rate * 4, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
  await panel.locator('input[accept^="audio/"]').setInputFiles({ name: "take.wav", mimeType: "audio/wav", buffer: wav });
  await panel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
  const report = page.getByRole("region", { name: /Analysis report|分析报告/ });
  await report.getByRole("heading", { name: /Frequently wrong pitches|常错音/ }).waitFor();
  const firstDot = report.locator("svg").first().locator("g circle").nth(1);
  assert.equal(await firstDot.getAttribute("fill"), "transparent", "Outlier must not render red");
  assert.equal(await report.getByRole("img", { name: "A4: 2/4, 50%", exact: true }).count(), 1, "Exclude octave/outlier and accept inclusive +/-15 cents");
  const fills = await report.locator("svg").first().locator("g circle:nth-of-type(2)").evaluateAll((dots) => dots.map((dot) => dot.getAttribute("fill")));
  assert.deepEqual(fills, ["transparent", "transparent", "#d93025", "#1a8737", "#1a8737", "#d93025"]);
  assert.equal(await report.getByRole("button", { name: /Measure 1: 0 wrong, 2 excluded|第 1 小节：0 个音不准，2 个未计分/ }).count(), 1);
  async function playMeasure(number, end) {
    await report.getByRole("button", { name: new RegExp(`^Measure ${number}:|^第 ${number} 小节：`) }).click();
    await page.waitForFunction((end) => { const audio = document.querySelector("aside audio"); return audio?.paused && Math.abs(audio.currentTime - end) < .04; }, end);
    assert.ok(await panel.locator("audio").evaluate((audio) => audio.currentTime < audio.duration - 1), "Must stop before full take ends");
  }
  await playMeasure(1, .65);
  await playMeasure(2, 1.1);
  await playMeasure(1, .65);
  await panel.getByRole("button", { name: /Play full take|播放整遍/ }).click();
  await page.waitForFunction(() => { const audio = document.querySelector("aside audio"); return audio && !audio.paused && audio.currentTime > 1.2; });
  await panel.locator("audio").evaluate((audio) => audio.pause());
  // B sync records media time (even paused or slowed), persists, and reaches POST /jobs.
  await panel.getByRole("button", { name: /^(Start B sync|开始 B 同步)$/ }).click();
  for (const time of [.2, .65, 1.1]) {
    await panel.locator("audio").evaluate((audio, time) => { audio.currentTime = time; audio.playbackRate = .5; }, time);
    await page.keyboard.press("b");
  }
  assert.equal(await panel.getByRole("spinbutton", { name: /Measure \d+ seconds/ }).count(), 3);
  await page.keyboard.press("Backspace");
  assert.equal(await panel.getByRole("spinbutton", { name: /Measure \d+ seconds/ }).count(), 2);
  await page.keyboard.press("b");
  await panel.getByRole("button", { name: /^(Confirm sync for analysis|确认同步并用于分析)$/ }).click();
  await panel.getByText(/Confirmed: analyze measures 1–2|已确认：分析 1–2 小节/).waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sf-takes-meta-v1"))[0]);
  assert.deepEqual(saved.measureSync, [{ measure: 1, audioSec: .2 }, { measure: 2, audioSec: .65 }, { measure: 3, audioSec: 1.1 }]);
  assert.equal(saved.syncScoreXml, xml);
  await panel.getByRole("button", { name: /^(Preview measure 1|回听小节 1)$/ }).click();
  await page.waitForFunction(() => { const audio = document.querySelector("aside audio"); return audio?.paused && Math.abs(audio.currentTime - .65) < .04; });
  await panel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
  await report.getByRole("heading", { name: /Frequently wrong pitches|常错音/ }).waitFor();
  assert.equal(submitted.syncMode, "manual-measures");
  assert.deepEqual(submitted.measureSync, saved.measureSync);
  assert.equal(submitted.firstBeatAudioSec, undefined);
  await page.reload();
  await page.getByRole("button", { name: /^(Analyze|演奏分析)$/ }).click();
  await panel.getByText(/Confirmed: analyze measures 1–2|已确认：分析 1–2 小节/).waitFor();
  assert.equal(await panel.getByRole("spinbutton", { name: /Measure \d+ seconds/ }).count(), 3);
  // Reuse the existing score player's timing format and its actual audio blob.
  await page.locator('input[accept="audio/*,video/*"]').setInputFiles({ name: "main-player.wav", mimeType: "audio/wav", buffer: wav });
  await page.keyboard.press("m");
  const timing = { app: "scorefollow", schema: "scorefollow-timing/2", version: "2.1", algoVersion: 29,
    measureCount: 2, times_arr: [{ mix: 0, t: .3 }, { mix: 1, t: .8 }], opt: {}, loop: { start: 0, end: 0 } };
  await page.locator("label").filter({ hasText: /^(Load timing|导入同步数据)/ }).locator('input[type="file"]').setInputFiles({ name: "timing.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(timing)) });
  await page.getByText(/loaded 2 sync points/).waitFor();
  await panel.getByRole("button", { name: /Import score-player audio \+ B sync|导入谱面播放器的音频及 B 同步/ }).click();
  await panel.getByRole("spinbutton", { name: "Measure 1 seconds", exact: true }).waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("sf-takes-meta-v1")).some((t) => t.name === "main-player.wav"));
  const imported = await page.evaluate(() => JSON.parse(localStorage.getItem("sf-takes-meta-v1")).find((t) => t.name === "main-player.wav"));
  assert.deepEqual(imported.measureSync, [{ measure: 1, audioSec: .3 }, { measure: 2, audioSec: .8 }]);
  assert.equal(imported.syncScoreXml, undefined, "Imported timing must be reviewed before confirmation");
  assert.equal(await panel.locator("audio").evaluate(async (audio) => (await (await fetch(audio.src)).arrayBuffer()).byteLength), wav.length);
  assert.deepEqual(pageErrors, []);
  // New reports and legacy payloads both distinguish actual zero from missing scores.
  const qualityCases = [
    { name: "zero", summary: { ...result.summary, pitchScore: 0, rhythmScore: 0 }, label: /Results available|结果可用/, scoreText: "0" },
    { name: "insufficient", summary: { ...result.summary, pitchScore: null, rhythmScore: null, syncAdvice: "Review alignment" }, label: /Insufficient evidence|证据不足/, scoreText: /Not scored|未计分/ },
    { name: "rescue", summary: { ...result.summary, pitchScore: 95, rhythmScore: 87, autoMeasureSync: true, octaveShift: -12, rescueReasons: ["octave", "tempo", "pause", "range"], detectedBpm: 132 }, label: /Auto-corrected|已自动补救/, scoreText: "95" },
  ];
  for (const fixture of qualityCases) {
    const testPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await testPage.addInitScript((language) => localStorage.setItem("sf-lang", language), fixture.name === "insufficient" ? "en" : "zh");
    testPage.on("pageerror", (error) => pageErrors.push(error.message));
    let posts = 0;
    const payload = { ...result, summary: fixture.summary,
      diagnostics: { analysisId: fixture.name, algorithmVersion: result.version, inputHash: "a".repeat(64), elapsedMs: 1250 } };
    if (fixture.name !== "zero") payload.quality = { version: "evidence-1", outcome: fixture.name === "insufficient" ? "insufficient_evidence" : "complete_with_rescue",
      issues: fixture.name === "insufficient" ? ["alignment_unverified"] : [], pitchCoverage: .5, timingCoverage: 0, followReady: fixture.name !== "insufficient" };
    await testPage.route("**/jobs**", async (route) => {
      const post = route.request().method() === "POST";
      if (post) posts++;
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(post ? { id: fixture.name, status: "queued" } : { id: fixture.name, status: "completed", result: payload }) });
    });
    await testPage.goto(`http://127.0.0.1:${server.address().port}${base}/`);
    await testPage.getByRole("button", { name: /^(Analyze|演奏分析)$/ }).click();
    const testPanel = testPage.getByRole("complementary", { name: /Performance analysis|演奏分析/ });
    const xmlInput = testPanel.locator('input[accept=".xml,.musicxml"]');
    await xmlInput.setInputFiles({ name: "invalid.xml", mimeType: "application/xml", buffer: Buffer.from("<broken>") });
    await testPanel.getByRole("region", { name: /Score preflight|谱面预检/ }).getByText(/not valid|不是有效/).waitFor();
    await testPanel.locator('input[accept^="audio/"]').setInputFiles({ name: "quality.wav", mimeType: "audio/wav", buffer: wav });
    await testPanel.getByRole("region", { name: /Audio preflight|音频预检/ }).waitFor();
    await testPanel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
    await testPanel.getByRole("alert").filter({ hasText: /not valid|不是有效/ }).waitFor();
    assert.equal(posts, 0, "Invalid score must not submit a job");
    await xmlInput.setInputFiles({ name: "valid.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
    await testPanel.getByRole("region", { name: /Score preflight|谱面预检/ }).getByText(/Structure check passed|结构预检通过/).waitFor();
    await testPanel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
    const testReport = testPage.getByRole("region", { name: /Analysis report|分析报告/ });
    const qualityCard = testReport.getByRole("region", { name: /Analysis quality|分析质量/ });
    await qualityCard.getByText(fixture.label).waitFor();
    const scoreCells = testReport.locator('[class*="scores"] b');
    assert.match(await scoreCells.first().innerText(), fixture.scoreText instanceof RegExp ? fixture.scoreText : new RegExp(`^${fixture.scoreText}$`));
    await qualityCard.locator("summary").click();
    await qualityCard.getByText(new RegExp(fixture.name)).waitFor();
    if (fixture.name === "rescue") await qualityCard.getByText(/Octave correction|八度修正/).waitFor();
    if (fixture.name === "insufficient") assert.equal(await testReport.getByRole("button", { name: /Follow with this take|用这一遍走谱/ }).isDisabled(), true);
    assert.equal(posts, 1);
    await testPage.close();
  }
  assert.deepEqual(pageErrors, []);
  console.log(`QUALITY_PREFLIGHT_BROWSER_OK: ${base || "/"}; viewport 390x844; zero/null/rescue, invalid XML blocks POST, diagnostics`);
  console.log("REPORT_BROWSER_OK: pitch charts; bounded playback; B sync, undo, confirmation, preview, persistence, manual-measures POST and main-player audio/timing import verified");
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
