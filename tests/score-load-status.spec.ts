import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PDF_PATH = "/home/user/scorefollow/public/chopin.pdf";
const SHOT_DIR = "/home/user/scorefollow/test-screenshots";
const STATUS = '[data-testid="score-load-status"]';

test.beforeAll(() => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  expect(fs.existsSync(PDF_PATH), `测试用谱不存在: ${PDF_PATH}`).toBe(true);
});

async function statusAttrs(page: Page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      phase: el?.getAttribute("data-phase") ?? null,
      hasScore: el?.getAttribute("data-has-score") ?? null,
      text: (el?.textContent ?? "").trim().slice(0, 300),
    };
  }, STATUS);
}

test.describe.serial("ScoreFollow 谱面载入状态 (score-load-status)", () => {
  test("1. 初始空态为 ready 且不声称已载入", async ({ page }) => {
    await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
    const st = page.locator(STATUS);
    await expect(st).toBeVisible({ timeout: 15_000 });
    const attrs = await statusAttrs(page);
    // eslint-disable-next-line no-console
    console.log(`INIT phase=${attrs.phase} hasScore=${attrs.hasScore} text=${attrs.text}`);
    expect(attrs.phase, "初始阶段应为 ready").toBe("ready");
    expect(attrs.hasScore, "初始无谱面").toBe("false");
    expect(attrs.text, "初始文案不得声称已载入多页谱面").not.toMatch(/score:\s*\d+\s*pages/i);
    expect(await page.locator("#notation canvas").count(), "初始不应有谱面 canvas").toBe(0);
    await page.screenshot({ path: path.join(SHOT_DIR, "20-status-initial.png") });
  });

  test("2. chopin.pdf 真实载入终态为 ready-score", async ({ page }) => {
    await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
    const seen: string[] = [];
    // 轮询记录阶段变化(加载快时可能只抓到首尾, 至少终态必须为 ready-score)
    const poll = page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("data-phase") === "ready-score",
      STATUS,
      { timeout: 60_000 },
    ).catch(() => null);
    await page.setInputFiles('input[accept=".pdf"]', PDF_PATH);
    // 采样中间态(尽力而为, 不强求)
    for (let i = 0; i < 20; i++) {
      const a = await statusAttrs(page).catch(() => null);
      if (a && a.phase && !seen.includes(a.phase)) seen.push(a.phase);
      if (a?.phase === "ready-score") break;
      await page.waitForTimeout(300);
    }
    await poll;
    const attrs = await statusAttrs(page);
    const canvasCount = await page.locator("#notation canvas").count();
    // eslint-disable-next-line no-console
    console.log(`LOADED seen=${seen.join(",")} phase=${attrs.phase} hasScore=${attrs.hasScore} canvas=${canvasCount} text=${attrs.text}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "21-status-loaded.png") });
    expect(attrs.phase, "PDF 识别完成后阶段应为 ready-score").toBe("ready-score");
    expect(attrs.hasScore, "载入后应标记有谱").toBe("true");
    expect(canvasCount, "应渲染出谱面 canvas").toBeGreaterThan(0);
    expect(attrs.text, "成功文案应含页/系统统计").toMatch(/pages|小节|systems/i);
  });

  test("3. 非法 preload 进入 error 阶段", async ({ page }) => {
    await page.goto("/scorefollow/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
    const bad = path.join(os.tmpdir(), "scorefollow-bad-preload.js");
    fs.writeFileSync(bad, "// not a real preload file\nvar x = 1;\n");
    await page.setInputFiles('input[accept=".js"]', bad);
    await page
      .waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute("data-phase") === "error",
        STATUS,
        { timeout: 15_000 },
      )
      .catch(() => null);
    const attrs = await statusAttrs(page);
    // eslint-disable-next-line no-console
    console.log(`BAD-PRELOAD phase=${attrs.phase} hasScore=${attrs.hasScore} text=${attrs.text}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "22-status-error.png") });
    expect(attrs.phase, "非法 preload 应进入 error 阶段").toBe("error");
    expect(attrs.hasScore, "非法 preload 不应标记有谱").toBe("false");
  });
});
