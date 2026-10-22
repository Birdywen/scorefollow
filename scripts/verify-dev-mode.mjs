// Developer tools (preload import/export, issue report, expert and recognition settings, diagnostics,
// Score publishing, service address) show only with ?dev=1. Needs a built app: SF_UI_URL.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.env.SF_UI_URL || "http://127.0.0.1:8794/scorefollow/";
const DEV = [/导入 preload\.js|Load preload\.js/, /导出 preload\.js|Save preload\.js/, /专家参数|Expert settings/, /识别模式|Recognition mode/,
  /诊断视图|Diagnostics/, /推送到 Score|Publish to Score/, /载入门数据|Load gate/];
const USER = [/谱面视图|Score display/, /文件与导出|Files & export/, /导出同步数据|Save sync|timing/i];
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) for (const dev of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url + (dev ? "?dev=1" : ""), { waitUntil: "networkidle" });
    // Open menu and control panel, then read every label on the page.
    await page.getByRole("button", { name: /^(打开|Open)/ }).first().click();
    const openMenu = await page.locator('[role="menu"]').allInnerTexts();
    await page.keyboard.press("Escape");
    await page.locator('summary[aria-label="更多"], summary[aria-label="More"]').first().click();
    const moreText = await page.locator('summary[aria-label="更多"] + div, summary[aria-label="More"] + div').first().textContent();
    assert.equal(/上报异常|Report/.test(moreText), dev, `report button shown=${!dev} at ${width}`);
    await page.getByRole("button", { name: /^(面板|Panel)$/ }).or(page.locator('[title="Panel (M)"]')).first().click();
    const panel = page.locator("#sf-control-panel");
    await panel.waitFor();
    const text = openMenu.join("\n") + "\n" + await panel.innerText() + "\n" + await panel.evaluate((el) => el.textContent);
    for (const re of USER) assert.match(text, re, `user item missing (${width}, dev=${dev}): ${re}`);
    for (const re of DEV) assert.equal(re.test(text), dev, `${re} shown=${!dev} at ${width} dev=${dev}`);
    // Analysis panel: the service address is a developer setting (the default address is filled in).
    await page.getByRole("button", { name: /^((演奏)?分析|Analyze)$/ }).click();
    const perf = page.getByRole("complementary", { name: /Performance analysis|演奏分析/ });
    await perf.waitFor();
    assert.equal(await perf.getByText(/^(服务设置|Service)$/).count(), dev ? 1 : 0, `service settings at ${width} dev=${dev}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `no horizontal page scroll (${overflow})`);
    assert.deepEqual(errors, []);
    console.log(`DEV_MODE_OK ${width} dev=${dev}`);
    await page.close();
  }
} finally { await browser.close(); }
