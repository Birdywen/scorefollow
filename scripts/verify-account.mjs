// Sign-in UI check: static out/ + real account server (file mail). Env: SF_SHOTS (dir for a screenshot).
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
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${accPort}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome", headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:18999/scorefollow/");
  await page.getByRole("button", { name: /^(登录|Sign in)$/ }).click();
  const dlg = page.getByRole("dialog", { name: /账户|Account/ });
  await dlg.getByText(/每天可分析 3 次|3 analyses a day/).waitFor({ timeout: 10000 });   // guest budget shown
  await dlg.getByRole("textbox", { name: /邮箱|Email/ }).fill("ui@example.com");
  await dlg.getByRole("button", { name: /发送验证码|Send code/ }).click();
  const codeBox = dlg.getByRole("textbox", { name: /验证码|Code/ });
  await codeBox.waitFor();
  let mail = "";
  for (let i = 0; i < 50 && !mail; i++) { try { mail = await readFile(join(work, "mail", "ui@example.com.txt"), "utf8"); } catch { await page.waitForTimeout(100); } }
  const code = mail.match(/(\d{6})/)?.[1];
  assert.ok(code, "mail has a code");
  await codeBox.fill("000000" === code ? "111111" : "000000");
  await dlg.getByRole("button", { name: /^(登录|Sign in)$/ }).click();
  await dlg.getByRole("alert").waitFor();                       // wrong code is refused
  await codeBox.fill(code);
  await dlg.getByRole("button", { name: /^(登录|Sign in)$/ }).click();
  await dlg.getByText("ui@example.com").waitFor({ timeout: 10000 });
  await dlg.getByText(/今日已用：分析 0\/30|Used today: analysis 0\/30/).waitFor();
  if (process.env.SF_SHOTS) await page.screenshot({ path: join(process.env.SF_SHOTS, "account.png") });
  await dlg.getByRole("button", { name: "×" }).click().catch(() => dlg.getByRole("button", { name: /关闭|Close/ }).click());
  await page.getByRole("button", { name: /👤 ui/ }).waitFor();  // header shows the user
  await page.reload();                                           // cookie session survives a reload
  await page.getByRole("button", { name: /👤 ui/ }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /👤 ui/ }).click();
  await page.getByRole("button", { name: /退出登录|Sign out/ }).click();
  await page.getByRole("button", { name: /^(登录|Sign in)$/ }).waitFor();
  assert.deepEqual(errors, [], "no page errors");
  console.log("ACCOUNT_UI_OK");
} finally {
  await browser?.close();
  server.close();
  acc.kill();
}
