/** 合成回归: 验证 NMS/双线保留/置信度/小节构建, 不依赖浏览器与 PDF. */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "sf-regression-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts lib/synpdf-wijzer.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: new URL(root).pathname, stdio: "inherit" },
);
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);
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

if (failures) { console.error(`${failures} regression check(s) failed`); process.exit(1); }
console.log("REGRESSION_PASS");
