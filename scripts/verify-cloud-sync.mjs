// Cloud sync check: device A records+analyzes a take while signed in; device B (same session) receives it.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = resolve("out");
const work = await mkdtemp(join(tmpdir(), "sf-acct-ui-"));
const accPort = 18000 + Math.floor(Math.random() * 1000);
const acc = spawn("python3", ["-B", "-m", "account_service.server"], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env,
  ACCOUNT_SECRET: "ui-test-secret-0123456789", ACCOUNT_PORT: String(accPort), ACCOUNT_DATA_DIR: join(work, "data"),
  ACCOUNT_MAIL_MODE: "file", ACCOUNT_MAIL_DIR: join(work, "mail"), ACCOUNT_COOKIE_SECURE: "0", ACCOUNT_QUOTA_MODE: "enforce",
  ACCOUNT_ALLOWED_ORIGINS: "http://127.0.0.1:18999" } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const m = url.pathname.match(/^\/scorefollow\/api\/account(\/.*)$/);
  if (m) {   // what nginx does in production
    const chunks = []; for await (const c of req) chunks.push(c);
    const up = http.request({ host: "127.0.0.1", port: accPort, path: m[1] + url.search, method: req.method,
      headers: { ...req.headers, host: "127.0.0.1", "x-real-ip": "5.5.5.5", origin: "http://127.0.0.1:18999" } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.statusCode = 502; res.end(); });
    return up.end(Buffer.concat(chunks));
  }
  try {
    let path = resolve(root, "." + url.pathname.replace(/^\/scorefollow/, ""));
    if (!path.startsWith(root + "/") && path !== root) throw new Error("bad path");
    if (url.pathname.endsWith("/")) path += "/index.html";
    const bytes = await readFile(path);
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm" })[extname(path)] ?? "application/octet-stream");
    res.end(bytes);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise((done) => server.listen(18999, "127.0.0.1", done));
let browser;
const PDF = "/tmp/gt-32264a94/Dotzauer Cello Etude no. 5 Book 1.pdf";
const result = {
  version: "sync-fixture", instrument: "cello", limitations: [], notes: [],
  summary: { pitchScore: 93, rhythmScore: 88, noteCount: 0, voicedNotes: 0, timedNotes: 0, measureCount: 20, confidence: "high", timingOffsetMs: null, timingSpreadMs: null },
  measureIntervals: Array.from({ length: 20 }, (_, i) => ({ measure: i + 1, startSec: i * 1.4 + 0.5, endSec: (i + 1) * 1.4 + 0.5 })),
};
const rate = 22050, samples = rate * 6, wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
const xml = Buffer.from('<score-partwise><part id="P1"><measure number="1"><note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>');
async function openPanel(page) {
  await page.route("**/jobs**", async (route) => {
    const status = route.request().method() === "POST" ? { id: "fixture", status: "queued" } : { id: "fixture", status: "completed", result };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
  });
  await page.goto("http://127.0.0.1:18999/scorefollow/");
  await page.locator('input[accept=".pdf"]').setInputFiles(PDF);
  await page.getByText("\u5c0f\u8282").first().waitFor({ timeout: 90000 });
  await page.getByRole("button", { name: /^(Analyze|\u6f14\u594f\u5206\u6790)$/ }).click();
  return page.getByRole("complementary", { name: /Performance analysis|\u6f14\u594f\u5206\u6790/ });
}
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${accPort}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome", headless: true, args: ["--no-sandbox"] });
  const errors = [];
  // --- device A: sign in, record (upload) a take, analyze it ---
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const a = await ctxA.newPage();
  a.on("pageerror", (e) => errors.push("A " + e.message));
  await a.goto("http://127.0.0.1:18999/scorefollow/");
  await a.getByRole("button", { name: /^(\u767b\u5f55|Sign in)$/ }).click();
  const dlg = a.getByRole("dialog", { name: /\u8d26\u6237|Account/ });
  await dlg.getByRole("textbox", { name: /\u90ae\u7bb1|Email/ }).fill("sync@example.com");
  await dlg.getByRole("button", { name: /\u53d1\u9001\u9a8c\u8bc1\u7801|Send code/ }).click();
  const codeBox = dlg.getByRole("textbox", { name: /\u9a8c\u8bc1\u7801|Code/ });
  await codeBox.waitFor();
  let mail = "";
  for (let i = 0; i < 50 && !/\d{6}/.test(mail); i++) { try { mail = await readFile(join(work, "mail", "sync@example.com.txt"), "utf8"); } catch { await a.waitForTimeout(100); } }
  await codeBox.fill(mail.match(/(\d{6})/)[1]);
  await dlg.getByRole("button", { name: /^(\u767b\u5f55|Sign in)$/ }).click();
  await a.getByRole("button", { name: /\u{1F464} sync/u }).waitFor({ timeout: 10000 });   // the dialog closes after sign-in? keep going
  if (await dlg.isVisible().catch(() => false)) await dlg.getByRole("button", { name: /\u5173\u95ed|Close/ }).click();
  const panelA = await openPanel(a);
  await panelA.locator('input[accept=".xml,.musicxml"]').setInputFiles({ name: "score.musicxml", mimeType: "application/xml", buffer: xml });
  await panelA.locator('input[accept^="audio/"]').setInputFiles({ name: "take.wav", mimeType: "audio/wav", buffer: wav });
  await panelA.getByRole("button", { name: /^(Analyze|\u5206\u6790\u8fd9\u4e00\u904d)$/ }).click();
  await panelA.getByText(/\u97f3\u51c6 93|Pitch 93/).first().waitFor({ timeout: 30000 });
  await panelA.getByText(/\u5df2\u540c\u6b65\u5230\u4f60\u7684\u8d26\u6237|synced to your account/).waitFor({ timeout: 30000 });
  // Wait until the cloud really has take + report.
  const cookies = await ctxA.cookies();
  const snap = async () => (await fetch(`http://127.0.0.1:${accPort}/sync`, { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).json();
  let s;
  for (let i = 0; i < 50; i++) { s = await snap(); if (s.takes[0]?.hasResult) break; await a.waitForTimeout(200); }
  assert.equal(s.takes.length, 1, "one take in the cloud");
  assert.ok(s.takes[0].hasResult, "report in the cloud");
  assert.ok(s.usedBytes > 100000, "audio uploaded");
  // --- device B: fresh browser profile, same session cookie ---
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctxB.addCookies(cookies);
  const b = await ctxB.newPage();
  b.on("pageerror", (e) => errors.push("B " + e.message));
  const panelB = await openPanel(b);
  await panelB.getByText(/\u97f3\u51c6 93|Pitch 93/).first().waitFor({ timeout: 30000 });   // report arrived
  await panelB.locator("audio").first().waitFor({ state: "attached" });
  const sec = await panelB.locator("audio").first().evaluate((e) => new Promise((res) => { if (e.duration) res(e.duration); else e.onloadedmetadata = () => res(e.duration); }));
  assert.ok(Math.abs(sec - 6) < 0.5, `audio came across intact (${sec}s)`);
  // --- delete on B removes it from the cloud ---
  await panelB.getByRole("button", { name: /^(\u5220\u9664|Delete)$/ }).first().click();
  for (let i = 0; i < 50; i++) { s = await snap(); if (!s.takes.length) break; await b.waitForTimeout(200); }
  assert.equal(s.takes.length, 0, "deleted from the cloud");
  assert.equal(s.usedBytes, 0, "audio freed");
  assert.deepEqual(errors, [], "no page errors");
  console.log("CLOUD_SYNC_OK");
} finally {
  await browser?.close();
  server.close();
  acc.kill();
}
