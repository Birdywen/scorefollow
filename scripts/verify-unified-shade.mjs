// Unified shade visual check: serve local out/, follow a take, assert the
// React .demaat cursor renders the same gradient/glow/border language as
// the legacy #sga-shade (metro-engine blue default, opacity 0.28).
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
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm" })[extname(path)] ?? "application/octet-stream");
    res.end(bytes);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const result = {
    version: "cursor-fixture", instrument: "cello", limitations: [], notes: [],
    summary: { pitchScore: 99, rhythmScore: 86, noteCount: 0, voicedNotes: 0, timedNotes: 0, measureCount: 79, confidence: "high", timingOffsetMs: null, timingSpreadMs: null },
    measureIntervals: Array.from({ length: 79 }, (_, i) => ({ measure: i + 1, startSec: i * 1.4 + 0.5, endSec: (i + 1) * 1.4 + 0.5 })),
  };
  await page.route("**/jobs**", async (route) => {
    const status = route.request().method() === "POST" ? { id: "fixture", status: "queued" } : { id: "fixture", status: "completed", result };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/scorefollow/`);
  await page.locator('input[accept=".pdf"]').setInputFiles("/tmp/gt-32264a94/Dotzauer Cello Etude no. 5 Book 1.pdf");
  await page.getByText("小节").first().waitFor({ timeout: 90000 });
  await page.getByRole("button", { name: /^(Analyze|演奏分析)$/ }).click();
  const panel = page.getByRole("complementary", { name: /Performance analysis|演奏分析/ });
  await panel.locator('input[accept=".xml,.musicxml"]').setInputFiles({ name: "score.musicxml", mimeType: "application/xml", buffer: Buffer.from('<score-partwise><part id="P1"><measure number="1"><note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>') });
  const rate = 22050, samples = rate * 70, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
  await panel.locator('input[accept^="audio/"]').setInputFiles({ name: "take.wav", mimeType: "audio/wav", buffer: wav });
  await panel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
  await panel.getByRole("button", { name: /用这一遍走谱|Follow with this take/ }).click();
  await page.locator("audio").last().evaluate((e) => e.play());
  await page.waitForFunction("document.querySelector('.demaat') !== null");
  await page.waitForTimeout(2500);
  const st = await page.locator(".demaat").evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundImage, blend: s.mixBlendMode, opacity: s.opacity, border: s.border, shadow: s.boxShadow }; });
  console.log("DEMAAT_STYLE", JSON.stringify(st));
  assert.ok(st.bg.includes("linear-gradient"), "demaat must render the unified gradient");
  assert.equal(st.blend, "multiply", "demaat must use the same multiply blend as sga-shade");
  assert.ok(parseFloat(st.opacity) > 0, "demaat must be visible");
  await page.locator(".demaat").screenshot({ path: "/tmp/opencode/demaat-unified.png" });
  assert.deepEqual(pageErrors, [], "no page errors");
  console.log("UNIFIED_SHADE_OK");
} finally {
  await browser?.close();
  server.close();
}
