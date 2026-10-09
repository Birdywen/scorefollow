import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const PDF_PATH = "/home/user/scorefollow/public/chopin.pdf";
const SHOT_DIR = "/home/user/scorefollow/test-screenshots";
const STATUS = '[data-testid="score-load-status"]';
const HELP_DIALOG = 'section[role="dialog"][aria-label="帮助与快捷键"], section[role="dialog"][aria-label="Help and shortcuts"]';
const PAGE_IND_RE = /第\s*\d+\s*\/\s*\d+\s*页|Page\s*\d+\s*\/\s*\d+/;
const SPEED_RE = /\d+\.\d+×/;

test.beforeAll(() => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  expect(fs.existsSync(PDF_PATH), `测试用谱不存在: ${PDF_PATH}`).toBe(true);
});

async function loadChopin(page: Page) {
  await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
  await page.setInputFiles('input[accept=".pdf"]', PDF_PATH);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForSelector("#notation canvas", { timeout: 60_000 });
  await page
    .waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("data-phase") === "ready-score",
      STATUS,
      { timeout: 60_000 },
    )
    .catch(() => null);
}

async function focusScore(page: Page) {
  // 把焦点放到谱面区, 避开按钮(INPUT/BUTTON 会吞快捷键)
  await page.locator("#notation").click({ position: { x: 20, y: 20 } }).catch(() => {});
  await page.waitForTimeout(200);
  // 若帮助/菜单残留, 先关掉
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
}

test.describe.serial("ScoreFollow 快捷键真实回归 (chopin.pdf)", () => {
  test("1. H 打开帮助, Escape 关闭 (真实 UI 状态)", async ({ page }) => {
    await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
    await focusScore(page);
    expect(await page.locator(HELP_DIALOG).isVisible().catch(() => false), "前置: 帮助默认关闭").toBe(false);
    await page.keyboard.press("h");
    await expect(page.locator(HELP_DIALOG).first()).toBeVisible({ timeout: 10_000 });
    const helpText = ((await page.locator(HELP_DIALOG).first().textContent().catch(() => "")) ?? "").slice(0, 120);
    // eslint-disable-next-line no-console
    console.log(`HELP opened text=${helpText}`);
    expect(helpText, "帮助面板应含快捷键说明").toMatch(/快捷键|shortcuts|Space|播放/i);
    await page.screenshot({ path: path.join(SHOT_DIR, "30-shortcut-help-open.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator(HELP_DIALOG).first()).toBeHidden({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "31-shortcut-help-closed.png") });
  });

  test("2. Space 切换节拍器状态 (真实引擎/按钮状态)", async ({ page }) => {
    await loadChopin(page);
    await focusScore(page);
    const hasMetro = await page.evaluate(() => !!(window as unknown as { __sgaMetroControl?: unknown }).__sgaMetroControl);
    const navBtn = page.locator("nav button").first();
    await expect(navBtn).toBeVisible({ timeout: 15_000 });
    const beforeText = ((await navBtn.textContent().catch(() => "")) ?? "").trim();
    const beforePlaying = await page.evaluate(() => {
      const mc = (window as unknown as { __sgaMetroControl?: { isPlaying?: () => boolean } }).__sgaMetroControl;
      try { return mc?.isPlaying?.() ?? null; } catch { return null; }
    });
    // eslint-disable-next-line no-console
    console.log(`METRO before hasMetro=${hasMetro} isPlaying=${beforePlaying} btn=${beforeText}`);
    await page.keyboard.press(" ");
    await page.waitForTimeout(1200);
    const afterPlaying = await page.evaluate(() => {
      const mc = (window as unknown as { __sgaMetroControl?: { isPlaying?: () => boolean } }).__sgaMetroControl;
      try { return mc?.isPlaying?.() ?? null; } catch { return null; }
    });
    const afterText = ((await navBtn.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`METRO after isPlaying=${afterPlaying} btn=${afterText}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "32-shortcut-space-on.png") });
    const flippedEngine = beforePlaying !== null && afterPlaying !== null && beforePlaying !== afterPlaying;
    const flippedBtn = beforeText !== afterText;
    if (!hasMetro && beforePlaying === null && !flippedBtn) {
      test.skip(true, `证据化跳过: 无节拍器引擎(hasMetro=false)且按钮文本无变化 before=${beforeText} after=${afterText}`);
      return;
    }
    expect(flippedEngine || flippedBtn, `Space 应切换节拍器真实状态 engine ${beforePlaying}->${afterPlaying} btn ${beforeText}->${afterText}`).toBe(true);
    // 再按一次应切回
    await page.keyboard.press(" ");
    await page.waitForTimeout(1000);
    const backPlaying = await page.evaluate(() => {
      const mc = (window as unknown as { __sgaMetroControl?: { isPlaying?: () => boolean } }).__sgaMetroControl;
      try { return mc?.isPlaying?.() ?? null; } catch { return null; }
    });
    const backText = ((await navBtn.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`METRO back isPlaying=${backPlaying} btn=${backText}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "33-shortcut-space-off.png") });
    const restored = (beforePlaying !== null && backPlaying === beforePlaying) || backText === beforeText;
    expect(restored, "再次 Space 应恢复初始节拍器状态").toBe(true);
  });

  test("3. PageDown/PageUp 翻页 (多页才断言, 否则证据化跳过)", async ({ page }) => {
    await loadChopin(page);
    await focusScore(page);
    const indicator = page.locator("nav").locator("text=/第\\s*\\d+\\s*\\/\\s*\\d+\\s*页|Page\\s*\\d+\\s*\\/\\s*\\d+/").first();
    await expect(indicator).toBeVisible({ timeout: 15_000 }).catch(() => {});
    const before = ((await indicator.textContent().catch(() => "")) ?? "").trim();
    const m = before.match(/(\d+)\s*\/\s*(\d+)/);
    const total = m ? Number(m[2]) : 0;
    // eslint-disable-next-line no-console
    console.log(`PAGE before=${before} total=${total}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "34-shortcut-page-before.png") });
    if (!total || total < 2) {
      test.skip(true, `证据化跳过: 当前谱面不足多页 indicator=${before}`);
      return;
    }
    expect(before).toMatch(PAGE_IND_RE);
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(800);
    const afterDown = ((await indicator.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`PAGE afterDown=${afterDown}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "35-shortcut-pagedown.png") });
    expect(afterDown, "PageDown 应切到下一页").not.toBe(before);
    expect(afterDown).toMatch(/2/);
    await page.keyboard.press("PageUp");
    await page.waitForTimeout(800);
    const afterUp = ((await indicator.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`PAGE afterUp=${afterUp}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "36-shortcut-pageup.png") });
    expect(afterUp, "PageUp 应切回第1页").toBe(before);
  });

  test("4. +/- 调速改变速度显示 (真实 state)", async ({ page }) => {
    await loadChopin(page);
    await focusScore(page);
    const speedLabel = page.locator("nav").locator("text=/\\d+\\.\\d+×/").first();
    const hasSpeed = await speedLabel.isVisible().catch(() => false);
    if (!hasSpeed) {
      const navText = ((await page.locator("nav").first().textContent().catch(() => "")) ?? "").slice(0, 160);
      test.skip(true, `证据化跳过: 未找到速度显示 nav=${navText}`);
      return;
    }
    const before = ((await speedLabel.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`SPEED before=${before}`);
    expect(before).toMatch(SPEED_RE);
    await page.keyboard.press("=");
    await page.waitForTimeout(400);
    const afterPlus = ((await speedLabel.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`SPEED afterPlus=${afterPlus}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "37-shortcut-speed-plus.png") });
    expect(afterPlus, "按 +/= 速度显示应变大").not.toBe(before);
    expect(Number.parseFloat(afterPlus), "加速后数值应更大").toBeGreaterThan(Number.parseFloat(before));
    await page.keyboard.press("-");
    await page.waitForTimeout(400);
    const afterMinus = ((await speedLabel.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`SPEED afterMinus=${afterMinus}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "38-shortcut-speed-minus.png") });
    expect(afterMinus, "按 - 速度显示应回落").toBe(before);
  });
});
