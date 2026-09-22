/** 茎干特征 dump: 候选列逐个打特征, 用 HOMR 真值标 TP/FP, 找阈值.
 * 用法: node scripts/stem-feat.mjs <benchScore> <page>
 * 例: SF_BENCH_ROOT=benchmarks/gpu node scripts/stem-feat.mjs tschaikowsky_rococo_gru_mmer_cello 2
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = process.env.SF_BENCH_ROOT ?? join(root, "benchmarks", "homr");
const tmp = mkdtempSync(join(tmpdir(), "sf-stemfeat-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "inherit" },
);
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);

const [name, pageStr] = process.argv.slice(2);
const page = Number(pageStr);
const dir = join(benchRoot, name);
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const homr = JSON.parse(readFileSync(join(dir, "homr.json"), "utf8"));
const pm = meta.pages[page - 1];
const raw = readFileSync(join(dir, `page_${page}.raw`));
const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
  rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
}
const r = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
const pg = homr[page - 1];
const hspaceW = pg.image_size ? pg.image_size.w : 1653;
const sx = pm.w / hspaceW;
const TOL = 4;

console.log("id,x,runRatio,topBlob,botBlob,midWidth,neighbors,strength,prox,segs,label");
r.cxs.forEach((s, si) => {
  const det = r.bxs[si] ?? [];
  const y1 = s.cs[0], y2 = s.cs[s.cs.length - 1];
  // 配对 HOMR 组(同 compare 逻辑简化: 取交叠最大)
  let best = null, bestOv = 0;
  for (const ms of pg.bbox.staffs) {
    const subs = ms.sub;
    const g1 = Math.min(...subs.map((q) => q.min_y)) * (pm.h / (pg.image_size ? pg.image_size.h : 2339));
    const g2 = Math.max(...subs.map((q) => q.max_y)) * (pm.h / (pg.image_size ? pg.image_size.h : 2339));
    const ov = Math.max(0, Math.min(y2, g2) - Math.max(y1, g1)) / Math.max(1, y2 - y1);
    if (ov > bestOv) { bestOv = ov; best = ms; }
  }
  const want = best && bestOv > 0.5
    ? [...new Set(best.sub.flatMap((q) => q.bar_lines.map((b) => b.cx * sx)))].sort((a, b) => a - b)
    : [];
  for (const x of det.slice(1, -1)) {
    const f = legacy.barStemFeatures(si, Math.round(x));
    if (!f) continue;
    const hit = want.some((w) => Math.abs(w - x) <= TOL);
    const segs = (f.headSegs ?? []).map((s) => `${s.y}:${s.h}x${s.w}`).join(";");
    console.log(`${name} p${page} sys${si + 1},${Math.round(x)},${f.runRatio},${f.topBlob},${f.botBlob},${f.midWidth},${f.neighbors},${f.strength},${f.noteheadProximity},${segs},${hit ? "TP" : "FP"}`);
  }
});
