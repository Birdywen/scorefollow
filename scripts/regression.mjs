/** 合成回归: 验证 NMS/双线保留/置信度/小节构建, 不依赖浏览器与 PDF. */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "sf-regression-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts lib/synpdf-core.ts lib/synpdf-wijzer.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: new URL(root).pathname, stdio: "inherit" },
);
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);
const core = await import(pathToFileURL(join(tmp, "synpdf-core.js")).href);
const wijzer = await import(pathToFileURL(join(tmp, "synpdf-wijzer.js")).href);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name} ${detail}`); }
}

// NMS: 近距离弱峰被抑制
{
  const kept = legacy.nmsBarPeaks(
    [{ x: 100, rel: 1 }, { x: 102, rel: 0.5 }, { x: 200, rel: 0.9 }],
    10,
  ).map((p) => p.x);
  check("nms-suppresses-weak-neighbour", JSON.stringify(kept) === JSON.stringify([100, 200]), JSON.stringify(kept));
}
// NMS: plateau 取中位数 (消除左缘偏好, 锁定线中心)
{
  const kept = legacy.nmsBarPeaks(
    [{ x: 199, rel: 1 }, { x: 200, rel: 1 }, { x: 201, rel: 1 }, { x: 300, rel: 0.9 }],
    10,
  ).map((p) => p.x);
  check("nms-plateau-median", JSON.stringify(kept) === JSON.stringify([200, 300]), JSON.stringify(kept));
}
// NMS: 强双线对保留 (间距 >= 0.7 spatium)
{
  const kept = legacy.nmsBarPeaks(
    [{ x: 100, rel: 0.95 }, { x: 108, rel: 0.92 }],
    10,
  ).map((p) => p.x);
  check("nms-keeps-strong-double-bar", kept.length === 2, JSON.stringify(kept));
}
// 置信度: 空系统低分, 正常系统高分, 越界可解释
{
  const empty = legacy.scoreSystemConfidence([], 10);
  const good = legacy.scoreSystemConfidence(
    [{ x: 0, rel: 0.95 }, { x: 120, rel: 0.9 }, { x: 240, rel: 0.92 }],
    10,
  );
  check("confidence-empty-low", empty < 0.5, String(empty));
  check("confidence-good-high", good > 0.6, String(good));
}
// buildMeasures: 过滤零宽/反向小节, 使用系统索引
{
  const measures = wijzer.buildMeasures({
    systems: [{ cs: [10, 50], xs: { x1: 0, x2: 300 } }],
    bars: [[0, 0, 100, 90, 300]],
    spatium: 10, annotFontPx: 32, pageW: 300, pageH: 200,
    pageNumber: 1, algoVersion: 2, confidence: [0.9], diagnostics: [], elapsedMs: 1,
  });
  const xs = measures.map((m) => [m.x, m.w]);
  check("buildMeasures-filters-degenerate", JSON.stringify(xs) === JSON.stringify([[0, 100], [90, 210]]), JSON.stringify(xs));
}

// HD/cursor/annotation are display-only and must not split analysis cache entries.
{
  const before = { hd: core.opt.hd, lncsr: core.opt.lncsr, annot: core.opt.annot, cropx: core.opt.cropx, fixwd: core.opt.fixwd, zwgrens: core.opt.zwgrens };
  const key = () => core.pageAnalysisCacheKey("doc", 1, 1000, 1400, 0, false);
  const base = key();
  core.opt.hd = before.hd ? 0 : 1;
  core.opt.lncsr = before.lncsr ? 0 : 1;
  core.opt.annot = before.annot ? 0 : 1;
  core.opt.cropx = before.cropx + 7;
  core.opt.fixwd = before.fixwd + 100;
  check("analysis-cache-ignores-display-options", key() === base);
  core.opt.zwgrens = before.zwgrens + 0.05;
  check("analysis-cache-tracks-detector-options", key() !== base);
  Object.assign(core.opt, before);
}

// v29 排除法符头否决: opening 符头核心 + 端部锚定 + 杆头归属。合成单谱表:
// 真线 x=500 保留, 连头符干 x=300 否决。
{
  const W = 1000, H = 300;
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const px = (x, y) => {
    const j = (y * W + x) * 4;
    rgba[j] = rgba[j + 1] = rgba[j + 2] = 0;
  };
  for (const y of [100, 108, 116, 124, 132])
    for (let x = 48; x <= 949; x++) { px(x, y); px(x, y + 1); }
  for (let y = 98; y <= 134; y++) { px(500, y); px(501, y); }
  for (let y = 116; y <= 156; y++) { px(300, y); px(301, y); }
  for (let y = 152; y <= 160; y++) for (let x = 301; x <= 311; x++) {
    const dx = (x - 306) / 5, dy = (y - 156) / 4;
    if (dx * dx + dy * dy <= 1) px(x, y);
  }
  const r = legacy.countPixFromBuffer(W, H, rgba, 0);
  const near = (arr, v, t) => (arr || []).some((b) => Math.abs(b - v) <= t);
  check("headveto-system", r.cxs.length >= 1, String(r.cxs.length));
  check("headveto-core", near(legacy.headCoreXs(0), 306, 7), JSON.stringify(legacy.headCoreXs(0)));
  check("headveto-bar-kept", near(r.bxs[0], 500, 3), JSON.stringify(r.bxs[0]));
  check("headveto-stem-dropped", !near(r.bxs[0], 300, 4), JSON.stringify(r.bxs[0]));
}

if (failures) { console.error(`${failures} regression check(s) failed`); process.exit(1); }
console.log("REGRESSION_PASS");
