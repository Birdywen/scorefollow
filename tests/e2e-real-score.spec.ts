import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const PDF_PATH = "/home/user/scorefollow/public/chopin.pdf";
const SHOT_DIR = "/home/user/scorefollow/test-screenshots";

test.beforeAll(() => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  expect(fs.existsSync(PDF_PATH), `测试用谱不存在: ${PDF_PATH}`).toBe(true);
});

async function shot(page: Page, name: string) {
  const p = path.join(SHOT_DIR, name);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

/** 打开页面 → 经“打开 ▾ → 载入 PDF 谱”上传 chopin.pdf → 等待小节识别完成。返回各阶段耗时。 */
async function loadChopin(page: Page) {
  const t0 = Date.now();
  await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
  const loadMs = Date.now() - t0;

  // 经由菜单点击“载入 PDF 谱”（任务要求的交互路径），实际文件注入走隐藏 input
  const openBtn = page.locator('button[title="打开"], button:has-text("打开")').first();
  await expect(openBtn).toBeVisible({ timeout: 15_000 });
  await openBtn.click();
  const loadItem = page.locator('#sf-open button:has-text("载入 PDF")');
  await expect(loadItem).toBeVisible({ timeout: 10_000 });

  const t1 = Date.now();
  // 直接对隐藏的 pdf input 注入真实文件（等价于用户选文件），随后关闭菜单以免遮挡 practicebar
  await page.setInputFiles('input[accept=".pdf"]', PDF_PATH);
  await page.keyboard.press("Escape").catch(() => {});
  if (await page.locator("#sf-open").isVisible().catch(() => false)) {
    await openBtn.click().catch(() => {});
  }
  // 等待识别完成：notation 内出现 canvas 且底部 hint 不再是“等待谱面”
  await page.waitForSelector("#notation canvas", { timeout: 30_000 });
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector("nav");
        const txt = el?.textContent ?? "";
        return /小节|measures|systems|行/.test(txt) && !/等待谱面/.test(txt);
      },
      { timeout: 30_000 },
    )
    .catch(() => {});
  const analyzeMs = Date.now() - t1;

  const hint = (await page.locator("nav").first().textContent().catch(() => "")) ?? "";
  const status = (await page.locator('footer [role="status"]').first().textContent().catch(() => "")) ?? "";
  const canvasCount = await page.locator("#notation canvas").count();
  return { loadMs, analyzeMs, hint: hint.trim().slice(0, 200), status: status.trim().slice(0, 300), canvasCount };
}

test.describe.serial("ScoreFollow 真实乐谱 (chopin.pdf)", () => {
  test("1. 文件加载流程", async ({ page }) => {
    const r = await loadChopin(page);
    await shot(page, "01-pdf-loaded.png");
    // eslint-disable-next-line no-console
    console.log(`LOAD loadMs=${r.loadMs} analyzeMs=${r.analyzeMs} canvas=${r.canvasCount} hint=${r.hint} status=${r.status}`);
    expect(r.canvasCount, "notation 内应渲染出谱面 canvas").toBeGreaterThan(0);
    expect(r.hint, "底部应显示小节/系统统计而非等待谱面").toMatch(/小节|measures|systems|行/);
    expect(r.hint).not.toContain("等待谱面");
  });

  test("2. 节拍器功能", async ({ page }) => {
    await loadChopin(page);
    const playBtn = page.locator("nav button").first();
    await expect(playBtn).toBeVisible({ timeout: 15_000 });
    const before = ((await playBtn.textContent()) ?? "").trim();
    await shot(page, "02-metro-before.png");
    const t0 = Date.now();
    await playBtn.click();
    await page.waitForTimeout(1500);
    const during = ((await playBtn.textContent()) ?? "").trim();
    await shot(page, "03-metro-running.png");
    const toggleMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`METRO before=${before} during=${during} toggleMs=${toggleMs}`);
    // 启动后按钮文本应变化（节拍器: ▶ 节拍器⇄■ 停止；回退模式: ▶ 播放⇄❚❚ 暂停）
    expect(during, `点击后按钮状态应变化 before=${before}`).not.toBe(before);
    await playBtn.click();
    await page.waitForTimeout(800);
    const after = ((await playBtn.textContent()) ?? "").trim();
    await shot(page, "04-metro-stopped.png");
    // eslint-disable-next-line no-console
    console.log(`METRO after=${after}`);
    expect(after, "再次点击应恢复初始状态").toBe(before);
  });

  test("3. 翻页控制", async ({ page }) => {
    await loadChopin(page);
    const prev = page.locator('button[aria-label="上一页"]');
    const next = page.locator('button[aria-label="下一页"]');
    const indicator = page.locator("nav").locator("text=/第 \\d+ \\/ \\d+ 页|Page \\d+ \\/ \\d+/").first();
    await expect(prev).toBeVisible({ timeout: 15_000 });
    await expect(next).toBeVisible({ timeout: 15_000 });
    const prevDisabledBefore = await prev.isDisabled();
    const nextDisabledBefore = await next.isDisabled();
    const indBefore = ((await indicator.textContent().catch(() => "")) ?? "").trim();
    // eslint-disable-next-line no-console
    console.log(`PAGE before ind=${indBefore} prevDis=${prevDisabledBefore} nextDis=${nextDisabledBefore}`);
    expect(prevDisabledBefore, "第1页时上一页应禁用").toBe(true);
    // chopin.pdf 共 2 页：下一页应可用
    expect(nextDisabledBefore, "多页谱下一页应可用").toBe(false);
    const t0 = Date.now();
    await next.click();
    await page.waitForTimeout(800);
    const indAfter = ((await indicator.textContent().catch(() => "")) ?? "").trim();
    await shot(page, "05-page-next.png");
    const switchMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`PAGE afterNext ind=${indAfter} switchMs=${switchMs}`);
    expect(indAfter, "点击下一页后页码指示应变化").not.toBe(indBefore);
    expect(indAfter).toMatch(/2/);
    await prev.click();
    await page.waitForTimeout(800);
    const indBack = ((await indicator.textContent().catch(() => "")) ?? "").trim();
    await shot(page, "06-page-prev.png");
    // eslint-disable-next-line no-console
    console.log(`PAGE back ind=${indBack}`);
    expect(indBack, "点击上一页应切回第1页").toBe(indBefore);
  });

  test("4. 调音器功能", async ({ page }) => {
    await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
    const tunerBtn = page.locator('button[aria-label="调音器"]');
    await expect(tunerBtn).toBeVisible({ timeout: 15_000 });
    await tunerBtn.click();
    const dialog = page.locator('section[role="dialog"][aria-label="调音器"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator("text=/A4 = 440|调音器/").first()).toBeVisible();
    // 开始调音按钮存在（麦克风权限在 headless 下点后应有错误提示或状态变化，但面板不应崩）
    const startBtn = dialog.locator("button:has-text('开始调音'), button:has-text('Start')").first();
    await expect(startBtn).toBeVisible();
    await shot(page, "07-tuner-open.png");
    // 尝试点击开始（预期因无麦克风而显示错误，但面板保持打开）
    await startBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
    await shot(page, "08-tuner-after-start.png");
    expect(dialog, "点击开始后调音器面板不应崩溃关闭").toBeVisible();
    const closeBtn = dialog.locator('button[aria-label="关闭"], button[aria-label="Close"]').first();
    await closeBtn.click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await shot(page, "09-tuner-closed.png");
  });

  test("5. 设置面板", async ({ page }) => {
    await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
    const settingsBtn = page.locator('button[title="设置"]');
    await expect(settingsBtn).toBeVisible({ timeout: 15_000 });
    await settingsBtn.click();
    const panel = page.locator("#sf-settings");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    // 设置项完整性：loop / count-in / panel / correct / full screen 等
    for (const label of ["loop", "count-in", "panel", "correct", "full screen"]) {
      await expect(panel.locator(`text=${label}`).first(), `设置面板应包含 ${label}`).toBeVisible();
    }
    await shot(page, "10-settings-open.png");
    await settingsBtn.click();
    await expect(panel).toBeHidden({ timeout: 10_000 });
    await shot(page, "11-settings-closed.png");
  });

  test("6. 状态一致性（快速连续操作）", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
    await loadChopin(page);
    // 快速连续：下一页→上一页→节拍器开→节拍器关→调音器开→关→设置开→关
    const next = page.locator('button[aria-label="下一页"]');
    const prev = page.locator('button[aria-label="上一页"]');
    const playBtn = page.locator("nav button").first();
    const tunerBtn = page.locator('button[aria-label="调音器"]');
    const settingsBtn = page.locator('button[title="设置"]');
    if (!(await next.isDisabled())) await next.click().catch(() => {});
    if (!(await prev.isDisabled())) await prev.click().catch(() => {});
    await playBtn.click().catch(() => {});
    await page.waitForTimeout(400);
    await playBtn.click().catch(() => {});
    await tunerBtn.click().catch(() => {});
    await page.waitForTimeout(300);
    const tunerDialog = page.locator('section[role="dialog"][aria-label="调音器"]');
    if (await tunerDialog.isVisible().catch(() => false)) {
      await tunerDialog.locator('button[aria-label="关闭"], button[aria-label="Close"]').first().click().catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await settingsBtn.click().catch(() => {});
    await page.waitForTimeout(300);
    await settingsBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, "12-state-after-rapid.png");
    const hint = (await page.locator("nav").first().textContent().catch(() => "")) ?? "";
    const canvasCount = await page.locator("#notation canvas").count();
    // eslint-disable-next-line no-console
    console.log(`STATE errors=${errors.length} canvas=${canvasCount} hint=${hint.trim().slice(0, 120)}`);
    expect(canvasCount, "快速操作后谱面 canvas 不应丢失").toBeGreaterThan(0);
    expect(hint).toMatch(/小节|measures|systems|行|等待谱面/);
    expect(errors.filter((e) => !/AudioContext|microphone|mic/i.test(e)), `不应有未捕获异常: ${errors.join("; ")}`).toHaveLength(0);
  });
});
