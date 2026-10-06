// Real media playback + rendered chart regression, with a deterministic API fixture.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";

const root = resolve("out");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let path = resolve(root, "." + url.pathname.replace(/^\/scorefollow/, ""));
    if (!path.startsWith(root + "/") && path !== root) throw new Error("Invalid path");
    if (url.pathname.endsWith("/")) path += "/index.html";
    const bytes = await readFile(path);
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html" })[extname(path)] ?? "application/octet-stream");
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
  await page.route("**/jobs**", async (route) => {
    const status = route.request().method() === "POST" ? { id: "fixture", status: "queued" } : { id: "fixture", status: "completed", result };
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }, body: JSON.stringify(status) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/scorefollow/`);
  await page.getByRole("button", { name: /^(Analyze|演奏分析)$/ }).click();
  const panel = page.getByRole("complementary", { name: /Performance analysis|演奏分析/ });
  await panel.locator('input[accept=".xml,.musicxml"]').setInputFiles({ name: "score.musicxml", mimeType: "application/xml", buffer: Buffer.from('<score-partwise><part id="P1"/></score-partwise>') });
  const rate = 22050, samples = rate * 4, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
  await panel.locator('input[accept^="audio/"]').setInputFiles({ name: "take.wav", mimeType: "audio/wav", buffer: wav });
  await panel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
  const report = page.getByRole("region", { name: /Performance report|分析报告/ });
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
  assert.deepEqual(pageErrors, []);
  console.log("REPORT_BROWSER_OK: stale outliers hollow; +/-15 green, +/-16 red; A4 2/4 wrong; bounded measures 1,2,1; full playback restored");
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
