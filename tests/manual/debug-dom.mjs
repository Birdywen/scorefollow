import { chromium } from "playwright-core";
const browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://localhost:3000/scorefollow", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
const selectors = await page.evaluate(() => {
  return {
    svg: document.querySelector("svg") ? "svg exists" : "no svg",
    svgClasses: document.querySelector("svg")?.className.baseVal || "N/A",
    barZones: document.querySelectorAll(".bar-click-zone").length,
    allClasses: Array.from(document.querySelectorAll("[class]")).slice(0, 10).map(el => el.className).join(", ")
  };
});
console.log(JSON.stringify(selectors, null, 2));
await page.screenshot({ path: "/tmp/dom-debug.png" });
await browser.close();
