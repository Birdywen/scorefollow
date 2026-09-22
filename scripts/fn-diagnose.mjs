/** FN 诊断: 对每条未命中的真线打特征, 区分 veto 误杀 vs 根本无峰.
 * 用法: node scripts/fn-diagnose.mjs [score]
 * GT 来自 benchmarks gt, 检测来自 benchmarks gpu 的 ours.json 系统帧 + 实时重跑特征.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-fndiag-"));
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
const TOL = 4;

for (const [stem, score] of Object.entries(MAP)) {
  if (only && score !== only) continue;
  const gt = JSON.parse(readFileSync(join(gtRoot, stem + ".json"), "utf8"));
  const ours = JSON.parse(readFileSync(join(root, "benchmarks", "gpu", score, "ours.json"), "utf8"));
  const meta = JSON.parse(readFileSync(join(root, "benchmarks", "gpu", score, "meta.json"), "utf8"));
  for (const gpi of gt.pages) {
    const op = ours.pages[gpi.page - 1];
    // 系统配对(同 gt-eval 逻辑)
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
        if (found >= 0) { used[found] = true; continue; }
        // FN: 在该系统帧内重跑特征
        const pm = meta.pages[gpi.page - 1];
        const raw = readFileSync(join(root, "benchmarks", "gpu", score, `page_${gpi.page}.raw`));
        const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
        for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
          rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
        }
        legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
        const f = legacy.barStemFeatures(oi, Math.round(w));
        const near = internal.filter((d) => Math.abs(d - w) <= 12);
        console.log(`${score} p${gpi.page} sys${oi + 1} FN@${Math.round(w)} run=${f?.runRatio} topB=${f?.topBlob} botB=${f?.botBlob} mid=${f?.midWidth} nb=${f?.neighbors} prox=${f?.noteheadProximity} nearDet=${JSON.stringify(near.map(Math.round))}`);
      }
    });
  }
}
