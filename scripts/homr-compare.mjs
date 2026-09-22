/**
 * HOMR 交叉验证 (plan 阶段 1, 第 2 层: 独立引擎互验)。
 *
 * 用 benchmarks/homr/ 下的渲染缓冲跑 countPixFromBuffer, 与同页 HOMR
 * (segnet OMR 独立引擎) 的小节线按系统配对对比, 分歧输出供人工仲裁。
 * 报告性质, 不设硬门槛: `node scripts/homr-compare.mjs [score]`
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-homrcmp-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "inherit" },
);
const { default: path } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);

const benchRoot = process.env.SF_BENCH_ROOT ?? join(root, "benchmarks", "homr");
const inScope = (c) => (process.env.SF_BENCH_ROOT ? true : SCORES.includes(c.score));
const SCORES = process.argv[2] ? [process.argv[2]] : ["secret_garden", "toccatta"];
const HOMR_W = 1653; // A4 @200dpi: round(595*200/72)
const HOMR_H = 2339; // round(842*200/72)
const DEDUP_PX = 8; // HOMR 坐标下去重半径(同一小节线被两谱表各检一次)
const TOL = 4; // 我方宽1000坐标下容差(px): 跨引擎+跨dpi, 保守取大, 人工复核分歧

function dedupe(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const out = [];
  for (const x of s) {
    if (out.length && x - out[out.length - 1].acc / out[out.length - 1].n < DEDUP_PX) {
      const g = out[out.length - 1];
      g.acc += x; g.n++;
    } else out.push({ acc: x, n: 1 });
  }
  return out.map((g) => g.acc / g.n);
}

let totTp = 0, totFp = 0, totFn = 0, totDev = 0, sysMatch = 0, sysTotal = 0;
const records = [];

const scoreList = process.argv[2] ? [process.argv[2]]
  : (process.env.SF_BENCH_ROOT
      ? (existsSync(benchRoot) ? readdirSync(benchRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [])
      : SCORES);
for (const name of scoreList) {
  const dir = join(benchRoot, name);
  if (!existsSync(join(dir, "meta.json"))) { console.log(`skip ${name}: no data`); continue; }
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const homr = JSON.parse(readFileSync(join(dir, "homr.json"), "utf8"));
  console.log(`== ${name}`);
  for (const pm of meta.pages) {
    const page = homr[pm.page - 1];
    // HOMR 坐标系: 本地版=1653x2339(200dpi); GPU 版返回原始渲染像素(未除 scale)
    let hspaceW = HOMR_W, hspaceH = HOMR_H;
    if (page.image_size) {
      hspaceW = page.image_size.w;
      hspaceH = page.image_size.h;
    }
    const sx = pm.w / hspaceW;
    const sy = pm.h / hspaceH;
    const raw = readFileSync(join(dir, `page_${pm.page}.raw`));
    const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
    for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
      rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
    }
    const r = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
    console.log(`-- p${pm.page}: ours systems=${r.cxs.length} spatium=${legacy.getSpatium()} | homr groups=${page.bbox.staffs.length} (hspace=${Math.round(hspaceW)}x${Math.round(hspaceH)})`);
    const groups = page.bbox.staffs.map((ms) => {
      const subs = ms.sub;
      const y1 = Math.min(...subs.map((s) => s.min_y)) * sy;
      const y2 = Math.max(...subs.map((s) => s.max_y)) * sy;
      const bars = dedupe(subs.flatMap((s) => s.bar_lines.map((b) => b.cx * sx)));
      const x2 = Math.max(...subs.map((s) => s.max_x)) * sx;
      return { y1, y2, x2, bars };
    });
    sysTotal += Math.max(r.cxs.length, groups.length);
    const usedGroups = new Set();
    r.cxs.forEach((s, si) => {
      const det = r.bxs[si] ?? [];
      const y1 = s.cs[0], y2 = s.cs[s.cs.length - 1];
      let best = -1, bestOv = 0;
      groups.forEach((g, gi) => {
        const ov = Math.max(0, Math.min(y2, g.y2) - Math.max(y1, g.y1)) / Math.max(1, y2 - y1);
        if (!usedGroups.has(gi) && ov > bestOv) { bestOv = ov; best = gi; }
      });
      if (best < 0 || bestOv < 0.5) {
        console.log(`   sys${si + 1} y[${y1},${y2}] UNMATCHED (ov=${bestOv.toFixed(2)}) bars=${det.length - 2}`);
        totFp += Math.max(0, det.length - 2);
        records.push({ score: name, page: pm.page, sys: si + 1, internal: det.slice(1, -1), want: [], unmatched: true });
        return;
      }
      usedGroups.add(best);
      sysMatch++;
      const g = groups[best];
      // HOMR 右缘(谱面右端)对齐我方 x2 则视为端点, 不计入内部对比
      // 参考端点必须由参考系统自己的 x2 定义，不能随我方算法变化。
      const want = g.bars.filter((x) => Math.abs(x - g.x2) > TOL).sort((a, b) => a - b);
      const internal = det.slice(1, -1).sort((a, b) => a - b);
      const used = new Array(internal.length).fill(false);
      let tp = 0, dev = 0;
      const miss = [];
      for (const w of want) {
        let bi = -1, bd = Infinity;
        internal.forEach((d, i) => {
          if (used[i]) return;
          const dd = Math.abs(d - w);
          if (dd <= TOL && dd < bd) { bd = dd; bi = i; }
        });
        if (bi >= 0) { used[bi] = true; tp++; dev += bd; }
        else miss.push(Math.round(w));
      }
      const extra = internal.filter((_, i) => !used[i]).map(Math.round);
      totTp += tp; totFn += miss.length; totFp += extra.length; totDev += dev;
      const flag = (miss.length || extra.length) ? "MISMATCH" : "ok";
      console.log(`   sys${si + 1}~homrG${best + 1} ov=${bestOv.toFixed(2)} tp=${tp}/${want.length} miss=[${miss}] extra=[${extra}] meanDev=${tp ? (dev / tp).toFixed(1) : "-"} ${flag}`);
      records.push({ score: name, page: pm.page, sys: si + 1, internal, want, miss, extra, unmatched: false });
    });
    groups.forEach((g, gi) => {
      if (usedGroups.has(gi)) return;
      const want = g.bars.filter((x) => Math.abs(x - g.x2) > TOL);
      totFn += want.length;
      records.push({ score: name, page: pm.page, sys: gi + 1, internal: [], want,
        miss: want, extra: [], unmatched: true });
      console.log(`   homrG${gi + 1} UNMATCHED_REFERENCE fn=${want.length}`);
    });
  }
}
console.log(`== TOTAL sysMatch=${sysMatch}/${sysTotal} tp=${totTp} fp=${totFp} fn=${totFn} meanDev=${totTp ? (totDev / totTp).toFixed(2) : "-"}`);
if (process.env.SF_REPORT) writeFileSync(process.env.SF_REPORT, JSON.stringify({
  evaluator: 2, algoVersion: legacy.ALGO_VERSION,
  totals: { tp: totTp, fp: totFp, fn: totFn, referenceCount: totTp + totFn, sysMatch, sysTotal }, records,
}, null, 2));

// 仲裁门禁: 未被 adjudicated.json 覆盖的分歧直接失败；已覆盖的断言我方行为保持
let adjFailures = 0;
const adjPath = join(benchRoot, "adjudicated.json");
if (existsSync(adjPath)) {
  const adj = JSON.parse(readFileSync(adjPath, "utf8")).cases;
  for (const r of records) {
    const divs = [];
    if (r.unmatched) divs.push({ kind: "unmatched-system", x: -1 });
    else {
      for (const x of r.miss ?? []) divs.push({ kind: "miss", x });
      for (const x of r.extra ?? []) divs.push({ kind: "extra", x });
    }
    for (const d of divs) {
      const hit = adj.find((c) => inScope(c) && c.score === r.score && c.page === r.page && c.sys === r.sys &&
        (d.x < 0 || Math.abs(c.x - d.x) <= 8));
      if (!hit || hit.verdict === "pending") {
        adjFailures++;
        console.error(`UNADJUDICATED ${r.score} p${r.page} sys${r.sys} ${d.kind} x=${d.x}`);
        continue;
      }
      if (hit.verdict === "homr-fp") {
        const bad = r.internal.some((v) => Math.abs(v - hit.x) <= 10);
        console.log(`KNOWN ${r.score} p${r.page} sys${r.sys} x=${hit.x}: homr-fp, ours ${bad ? "REGRESSED" : "clean"}`);
        if (bad) adjFailures++;
      } else if (hit.verdict === "homr-miss") {
        const kept = r.internal.some((v) => Math.abs(v - hit.x) <= TOL);
        console.log(`KNOWN ${r.score} p${r.page} sys${r.sys} x=${hit.x}: homr-miss, ours ${kept ? "kept" : "REGRESSED"}`);
        if (!kept) adjFailures++;
      }
    }
  }
  console.log(adjFailures ? `ADJUDICATION_FAIL(${adjFailures})` : "ADJUDICATION_PASS");
} else {
  console.log("ADJUDICATION_SKIP(no file)");
}
console.log("HOMR_COMPARE_DONE");
if (adjFailures) process.exit(1);
