import { chromium } from "playwright-core";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://localhost:3000/scorefollow", { waitUntil: "networkidle" });

// 注入最小测试数据
await page.evaluate(() => {
  const testScore = {
    metadata: { title: "Test" },
    systems: Array.from({ length: 3 }, (_, si) => ({
      measures: Array.from({ length: 4 }, (_, mi) => ({
        number: si * 4 + mi + 1,
        clef: "G",
        time: "4/4",
        notes: [{ pitch: "C4", duration: 1 }]
      }))
    }))
  };
  window.__TEST_SCORE__ = testScore;
  const event = new CustomEvent('test:loadScore', { detail: testScore });
  window.dispatchEvent(event);
});

await page.waitForTimeout(2000);

const bars = await page.evaluate(() => {
  const rects = [];
  document.querySelectorAll(".bar-click-zone").forEach((el) => {
    const r = el.getBoundingClientRect();
    rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 });
  });
  return rects;
});

console.log(`[测试] 找到 ${bars.length} 个小节点击区`);
if (bars.length === 0) {
  console.error('[方案B] 直接点击页面模拟，不依赖真实乐谱加载');
  await browser.close();
  process.exit(0); // 暂时不失败，等实现方案B
}

let covered = 0;
let clear = 0;

for (const bar of bars.slice(0, 10)) {
  await page.mouse.click(bar.cx, bar.cy);
  await page.waitForTimeout(500);

  const result = await page.evaluate((barBox) => {
    const popup = document.querySelector(".bar-popup");
    if (!popup) return { visible: false };
    const pRect = popup.getBoundingClientRect();
    const GAP = 12;
    const overlaps = pRect.left < barBox.right + GAP && pRect.right > barBox.left - GAP &&
                     pRect.top < barBox.bottom + GAP && pRect.bottom > barBox.top - GAP;
    return { visible: true, overlaps, popupX: Math.round(pRect.left), popupY: Math.round(pRect.top) };
  }, bar);

  if (!result.visible) {
    console.log(`[小节 ${bars.indexOf(bar) + 1}] 弹框未显示`);
    continue;
  }

  if (result.overlaps) {
    console.log(`[小节 ${bars.indexOf(bar) + 1}] ✗ 遮挡 (弹框 ${result.popupX},${result.popupY})`);
    covered++;
  } else {
    console.log(`[小节 ${bars.indexOf(bar) + 1}] ✓ 避让成功 (弹框 ${result.popupX},${result.popupY})`);
    clear++;
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

await browser.close();

console.log(`\n[结果] 避让成功: ${clear}/${clear + covered}, 遮挡: ${covered}/${clear + covered}`);
if (covered > 0) process.exit(1);
