// Run against a freshly built local static site, never against an unrelated deployment.
// SF_UI_URL=http://127.0.0.1/scorefollow/ node scripts/verify-workspace-ui.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  headless: true, args: ["--no-sandbox"],
});
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: "light" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.SF_UI_URL || "http://127.0.0.1/scorefollow/", { waitUntil: "networkidle" });
    const theme = page.getByRole("button", { name: /^(夜间模式|Night mode)$/ });
    await theme.click();
    await page.waitForFunction(() => document.documentElement.dataset.sfTheme === "dark");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("main").dataset.theme === "dark");
    assert.equal(await page.evaluate(() => localStorage.getItem("sf-theme")), "dark");
    const launcher = page.getByRole("button", { name: /^(节拍器圆盘|Metronome dial)$/ });
    await launcher.click();
    const dial = page.getByRole("group", { name: /节拍器快捷圆盘|Metronome quick controls/ });
    await dial.waitFor();
    const faster = page.getByRole("button", { name: /加速 2 BPM|Faster by 2 BPM/ });
    await page.waitForFunction(() => !!window.__sgaMetroControl);
    const original = await page.evaluate(() => window.__sgaMetro.bpm);
    await faster.click();
    await page.waitForFunction((bpm) => window.__sgaMetro.bpm === bpm + 2, original);
    await page.getByRole("button", { name: /减速 2 BPM|Slower by 2 BPM/ }).click();
    assert.equal(await page.evaluate(() => window.__sgaMetro.bpm), original);
    await dial.getByRole("button", { name: /预备拍|Count-in/ }).click();
    assert.equal(await page.evaluate(() => window.__sgaMetro.countIn), 4);
    await dial.getByRole("button", { name: /木鱼|wood/ }).click();
    assert.equal(await page.evaluate(() => window.__sgaMetro.sound), "clave");
    const rect = await dial.boundingBox();
    assert(rect && rect.x >= 0 && rect.x + rect.width <= width, "dial overflows viewport");
    // No artificial timer override: wait for the real four-second idle policy.
    await dial.waitFor({ state: "hidden", timeout: 6500 });
    await launcher.click();
    await page.getByRole("button", { name: /^(完整设置|Full settings)$/ }).click();
    assert(await page.locator("#sga-panel").isVisible(), "advanced controls missing");
    await page.getByRole("button", { name: /^(收起设置|Hide settings)$/ }).click();
    assert(!(await page.locator("#sga-panel").isVisible()), "advanced panel did not close");
    await launcher.focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("h");
    const help = page.getByRole("dialog");
    await help.waitFor();
    assert(!(await launcher.isVisible()), "dock obscures Help");
    const summary = help.locator("summary").first();
    await summary.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('[role="dialog"] details').open);
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "hidden" });
    assert(await launcher.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "page overflow");
    assert.deepEqual(errors, [], "uncaught browser errors");
    console.log(`WORKSPACE_UI_OK ${width}: theme persistence, tempo, count-in, sound, auto-hide, settings, Help`);
    await page.close();
  }
} finally {
  await browser.close();
}
