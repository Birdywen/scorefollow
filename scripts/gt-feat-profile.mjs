/** GT 口径特征画像: 对每条检测列按 GT 标 TP/FP, 对每条真线标命中/FN, 输出特征.
 * 用法: node scripts/gt-feat-profile.mjs [score] [TP|FP|FN|ALL]
 * GT 来自 benchmarks gt, 系统帧与检测来自 benchmarks gpu 的 ours.json, 特征实时重跑.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-gtfeat-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "pipe" },
);
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);

const MAP = {
  Arpeggione_Sonata: "arpeggione_sonata",
  "Saint-Preux_-_Le_Reve": "saint-preux_-_le_reve",
  Serenade_vl_pf: "serenade_vl_pf",
  "Suzuki-Book3-3-4": "suzuki-book3-3-4",
  "kupdf.net_suzuki-cello-school-vol-3-piano-accompanimentpdf_4": "kupdf_net_suzuki-cello-school-vol-3-piano-accomp",
  swan_cello_melody: "swan_cello_melody",
  "vivaldi-bajazet-sposa-son-disprezzata-aria-irenepdf": "vivaldi-bajazet-sposa-son-disprezzata-aria-irene",
  yradier_c_la_paloma_piano_beg: "yradier_c_la_paloma_piano_beg",
};
const gtRoot = join(root, "benchmarks", "gt");
for (const f of readdirSync(gtRoot)) {
  if (!f.endsWith(".json")) continue;
  const stem = f.slice(0, -5);
  if (stem.startsWith("Tschaikowsky")) MAP[stem] = "tschaikowsky_rococo_gru_mmer_cello";
}
const only = process.argv[2];
const wantLabel = (process.argv[3] ?? "ALL").toUpperCase();
const TOL = 4;

const fmt = (f) => {
  if (!f) return "null";
  const segs = (f.headSegs ?? []).map((s) => `${s.y}:${s.h}x${s.w}`).join(";");
  return `run=${f.runRatio} topB=${f.topBlob} botB=${f.botBlob} mid=${f.midWidth} nb=${f.neighbors} prox=${f.noteheadProximity} twin=${f.twinDist}/${f.twinRel} dip=${f.headDip ? 1 : 0} beam=${f.beamAbove}/${f.beamBelow} ext=${f.extAbove} sext=${f.stemExtAbove}/${f.stemExtBelow} segs=[${segs}]`;
};

// 每页检测只跑一次, 系统索引与 ours.json 对齐(同 meta 同 raw, 确定性重跑)
const pageCache = new Map();
function ensurePage(score, page) {
  const key = `${score}/p${page}`;
  if (pageCache.has(key)) return;
  const meta = JSON.parse(readFileSync(join(root, "benchmarks", "gpu", score, "meta.json"), "utf8"));
  const pm = meta.pages[page - 1];
  const raw = readFileSync(join(root, "benchmarks", "gpu", score, `page_${page}.raw`));
  const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
  for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
    rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
  }
  legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
  pageCache.set(key, true);
}

console.log("id,x,run,topB,botB,mid,nb,prox,segs,label");
for (const [stem, score] of Object.entries(MAP)) {
  if (only && score !== only) continue;
  const gt = JSON.parse(readFileSync(join(gtRoot, stem + ".json"), "utf8"));
  const ours = JSON.parse(readFileSync(join(root, "benchmarks", "gpu", score, "ours.json"), "utf8"));
  for (const gpi of gt.pages) {
    const op = ours.pages[gpi.page - 1];
    const pairs = [];
    const usedO = new Set();
    for (const g of gpi.systems) {
      if (!g.cs || !g.cs.length) { pairs.push(-1); continue; }
      let best = -1, bestOv = 0;
      op.systems.forEach((o, oi) => {
        if (usedO.has(oi)) return;
        const ov = Math.max(0, Math.min(g.cs[g.cs.length - 1], o.y2) - Math.max(g.cs[0], o.y1)) / Math.max(1, g.cs[g.cs.length - 1] - g.cs[0]);
        if (ov > bestOv) { bestOv = ov; best = oi; }
      });
      if (best >= 0 && bestOv > 0.5) { pairs.push(best); usedO.add(best); }
      else pairs.push(-1);
    }
    ensurePage(score, gpi.page);
    pairs.forEach((oi, gi) => {
      if (oi < 0) return;
      const want = gpi.bars[gi].slice(1, -1);
      const internal = op.bars[oi].slice(1, -1);
      const used = new Array(internal.length).fill(false);
      for (const w of want) {
        let found = -1;
        internal.forEach((d, ii) => {
          if (!used[ii] && found < 0 && Math.abs(d - w) <= TOL) found = ii;
        });
        if (found >= 0) {
          used[found] = true;
          if (wantLabel === "ALL" || wantLabel === "TP") {
            const f = legacy.barStemFeatures(oi, Math.round(internal[found]));
            console.log(`${score} p${gpi.page} sys${oi + 1},${Math.round(internal[found])},${fmt(f)},TP`);
          }
        } else if (wantLabel === "ALL" || wantLabel === "FN") {
          const f = legacy.barStemFeatures(oi, Math.round(w));
          console.log(`${score} p${gpi.page} sys${oi + 1},${Math.round(w)},${fmt(f)},FN`);
        }
      }
      if (wantLabel === "ALL" || wantLabel === "FP") {
        internal.forEach((d, ii) => {
          if (used[ii]) return;
          const f = legacy.barStemFeatures(oi, Math.round(d));
          console.log(`${score} p${gpi.page} sys${oi + 1},${Math.round(d)},${fmt(f)},FP`);
        });
      }
    });
    if (wantLabel === "ALL" || wantLabel === "FP") {
      const matchedO = new Set(pairs.filter((v) => v >= 0));
      op.systems.forEach((o, oi) => {
        if (matchedO.has(oi)) return;
        (op.bars[oi] ?? []).slice(1, -1).forEach((d) => {
          const f = legacy.barStemFeatures(oi, Math.round(d));
          console.log(`${score} p${gpi.page} sys${oi + 1},${Math.round(d)},${fmt(f)},FP-unmatched-sys`);
        });
      });
    }
  }
}
