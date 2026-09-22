/** 单列诊断: 打印 FN/FP 列的强度/对比/直度证据. 用法: node scripts/homr-debug.mjs toccatta 1 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-hdbg-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "inherit" },
);
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);

const [name, pageStr] = process.argv.slice(2);
const dir = join(root, "benchmarks", "homr", name);
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const pm = meta.pages[Number(pageStr) - 1];
const raw = readFileSync(join(dir, `page_${pm.page}.raw`));
const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
  rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
}
const r = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
console.log("bars:", JSON.stringify(r.bxs));

const targets = process.argv.slice(4).map((s) => s.split(":").map(Number));
for (const [si, x] of targets) {
  for (let dx = -2; dx <= 2; dx++) {
    const d = legacy.barColumnDebug(si, x + dx);
    console.log(`sys${si} x=${x + dx} y=${d.y} rel=${d.rel} m=${d.m} S=${d.passStrength ? 1 : 0} ` +
      `rL=${Math.round(d.rLeft)} rR=${Math.round(d.rRight)} wT=${d.wThr} tT=${d.tThr} C=${d.passContrast ? 1 : 0} ` +
      `run=${d.longestRun}/${d.sysH}=${d.runRatio}`);
  }
}
