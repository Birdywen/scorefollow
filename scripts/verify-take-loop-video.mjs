// Bar loop + MP4 export UI check: serve local out/, follow a take, loop two bars (playback must stay
// inside them), then export the looped bars as an MP4 and save it for ffprobe.
// Env: SF_VIDEO_OUT (mp4 path, default /tmp/sf-take-video.mp4), SF_SHOTS (dir for the dialog preview).
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = resolve("out");
const outMp4 = process.env.SF_VIDEO_OUT ?? "/tmp/sf-take-video.mp4";
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
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 300)); });
  page.on("requestfailed", (r) => console.log("REQFAIL", r.url().slice(-80), r.failure()?.errorText));
  const result = {
    version: "loop-fixture", instrument: "cello", limitations: [], notes: [],
    summary: { pitchScore: 93, rhythmScore: 88, noteCount: 0, voicedNotes: 0, timedNotes: 0, measureCount: 20, confidence: "high", timingOffsetMs: null, timingSpreadMs: null },
    measureIntervals: Array.from({ length: 20 }, (_, i) => ({ measure: i + 1, startSec: i * 1.4 + 0.5, endSec: (i + 1) * 1.4 + 0.5 })),
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
  const rate = 22050, samples = rate * 30, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
  await panel.locator('input[accept^="audio/"]').setInputFiles({ name: "take.wav", mimeType: "audio/wav", buffer: wav });
  await panel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
  await page.getByRole("dialog", { name: /演奏报告|Performance report/ }).getByRole("button", { name: /用这一遍走谱|Follow with this take/ }).click();
  await page.waitForFunction("document.querySelector('.demaat') !== null");
  // Close the analysis panel so it cannot cover the score while picking bars.
  if (await panel.isVisible()) await panel.getByRole("button", { name: /^(关闭|Close|×)$/ }).first().click({ timeout: 2000 }).catch(() => {});

  // Clean view (V) hides the analysis outlines but keeps the follow cursor.
  await page.locator("body").press("v");
  await page.waitForTimeout(400);
  assert.ok(await page.locator(".demaat").isVisible(), "cursor stays visible in clean view");
  assert.ok(await page.getByText(/干净视图：已隐藏分析框线|Clean view: analysis outlines hidden/).first().isVisible(), "clean view is on");

  // Pick bars: the shade sits on bar 1; tap it, then the bar right of it.
  const box = await page.locator(".demaat").boundingBox();
  assert.ok(box && box.width > 10, "cursor box");
  await page.getByRole("button", { name: /循环小节|Loop bars/ }).click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: /点终点小节|Tap end bar/ }).waitFor({ timeout: 5000 });
  await page.mouse.click(box.x + box.width * 1.5, box.y + box.height / 2);
  const loopBtn = page.getByRole("button", { name: /^🔁 \d+–\d+$/ });
  await loopBtn.waitFor({ timeout: 5000 });
  const [from, to] = (await loopBtn.innerText()).match(/(\d+)–(\d+)/).slice(1).map(Number);
  assert.ok(to === from + 1, `two bars looped, got ${from}-${to}`);
  const status = await page.getByText(/循环第 \d+–\d+ 小节|Looping bars/).first().innerText();
  const [a, b] = status.match(/([\d.]+)–([\d.]+) 秒|take ([\d.]+)–([\d.]+) s/).slice(1).filter(Boolean).map(Number);
  console.log("LOOP", JSON.stringify({ from, to, a, b }));
  assert.ok(Math.abs(b - a - 2 * 1.4 - 0.15) < 0.25, `window is two bars long: ${a}-${b}`);
  assert.equal(await page.locator('div[aria-hidden="true"][style*="dashed"]').count(), 2, "two bars outlined");

  // Play: the take must wrap back inside the window.
  const audio = page.locator("audio").last();
  await audio.evaluate((e) => e.play());
  const seen = [];
  for (let i = 0; i < 16; i++) { await page.waitForTimeout(400); seen.push(await audio.evaluate((e) => e.currentTime)); }
  await audio.evaluate((e) => e.pause());
  console.log("PLAYHEAD", seen.map((t) => t.toFixed(2)).join(" "));
  assert.ok(seen.every((t) => t >= a - 0.05 && t <= b + 0.35), "playhead stays in the loop");
  assert.ok(seen.some((t, i) => i > 0 && t < seen[i - 1]), "playhead wrapped at least once");

  // Export the looped bars.
  await page.getByRole("button", { name: /导出视频|Export video/ }).click();
  const dlg = page.getByRole("dialog", { name: /导出演奏视频|Export performance video/ });
  assert.equal(await dlg.getByRole("textbox", { name: /演奏者|Performer/ }).inputValue(), "大提琴", "performer = the report's instrument");
  await dlg.getByRole("checkbox", { name: /只导出循环|Only the looped/ }).check();
  await dlg.getByRole("checkbox", { name: /片尾显示分数|Show scores/ }).waitFor();
  const img = dlg.locator("img");
  await img.waitFor({ timeout: 15000 });
  if (process.env.SF_SHOTS) {
    const src = await img.getAttribute("src");
    await writeFile(join(process.env.SF_SHOTS, "video-preview.jpg"), Buffer.from(src.split(",")[1], "base64"));
  }
  const t0 = Date.now();
  await dlg.getByRole("button", { name: /生成视频|Render video/ }).click();
  const link = dlg.getByRole("link", { name: /下载 MP4|Download MP4/ });
  for (let i = 0; !(await link.isVisible()); i++) {
    const txt = (await dlg.innerText()).split("\n").filter((l) => /%|失败|failed|取消|cannot|不能/.test(l)).join(" | ");
    if (i % 5 === 0) console.log("EXPORT", Math.round((Date.now() - t0) / 1000) + "s", txt);
    if (/失败|failed|不能编码|cannot encode/.test(txt) || Date.now() - t0 > 400000) throw new Error("export did not finish: " + txt);
    await page.waitForTimeout(2000);
  }
  const bytes = await link.evaluate(async (el) => Array.from(new Uint8Array(await (await fetch(el.href)).arrayBuffer())));
  await writeFile(outMp4, Buffer.from(bytes));
  console.log("VIDEO", JSON.stringify({ bytes: bytes.length, renderSec: Math.round((Date.now() - t0) / 1000), name: await link.getAttribute("download"), codecNote: await dlg.locator("p").last().innerText() }));
  assert.ok(bytes.length > 20000, "mp4 has content");
  assert.deepEqual(pageErrors, [], "no page errors");
  console.log("TAKE_LOOP_VIDEO_OK");
} finally {
  await browser?.close();
  server.close();
}
