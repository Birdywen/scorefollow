/** 原版三阈值扫参: zwgrens x voorna x mtdrmpl, 9首GT全量评分找最优.
 * 用法: node scripts/param-sweep.mjs [zw..] [vo..] [mt..]  (逗号列表, 缺省用内置网格)
 * 单进程: 编译一次 + 页面缓冲只载一次, 逐组合重跑全管线(含系统检测)。
 * 评分口径与 scripts/gt-eval.py 一致(系统overlap>0.5配对, TOL=4, 去首尾边线)。
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-sweep-"));
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
for (const f of readdirSync(join(root, "benchmarks", "gt"))) {
  if (!f.endsWith(".json")) continue;
  const stem = f.slice(0, -5);
  if (stem.startsWith("Tschaikowsky")) MAP[stem] = "tschaikowsky_rococo_gru_mmer_cello";
}
const TOL = 4;
const parseList = (s, dflt) => (s ? s.split(",").map(Number) : dflt);
const ZWS = parseList(process.argv[2], [0.6, 0.65, 0.7, 0.75, 0.8]);
const VOS = parseList(process.argv[3], [0.85, 0.88, 0.9, 0.93]);
const MTS = parseList(process.argv[4], [0.75, 0.8, 0.85, 0.9]);

// 页面缓冲预载(全部分数页)
const pages = [];
for (const [stem, score] of Object.entries(MAP)) {
  const meta = JSON.parse(readFileSync(join(root, "benchmarks", "gpu", score, "meta.json"), "utf8"));
  const gt = JSON.parse(readFileSync(join(root, "benchmarks", "gt", stem + ".json"), "utf8"));
  for (const pm of meta.pages) {
    const raw = readFileSync(join(root, "benchmarks", "gpu", score, `page_${pm.page}.raw`));
    const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
    for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
      rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
    }
    const gpi = gt.pages.find((p) => p.page === pm.page);
    pages.push({ score, gt: gpi, w: pm.w, h: pm.h, rgba });
  }
}
console.error(`loaded ${pages.length} pages`);

function matchSystems(gSys, oSys) {
  const pairs = [];
  const usedO = new Set();
  gSys.forEach((g, gi) => {
    if (!g.cs || !g.cs.length) { pairs.push([gi, -1]); return; }
    let best = -1, bestOv = 0;
    oSys.forEach((o, oi) => {
      if (usedO.has(oi)) return;
      const ov = Math.max(0, Math.min(g.cs[g.cs.length - 1], o.cs[o.cs.length - 1]) - Math.max(g.cs[0], o.cs[0])) / Math.max(1, g.cs[g.cs.length - 1] - g.cs[0]);
      if (ov > bestOv) { bestOv = ov; best = oi; }
    });
    if (best >= 0 && bestOv > 0.5) { pairs.push([gi, best]); usedO.add(best); }
    else pairs.push([gi, -1]);
  });
  return { pairs, usedO };
}

function evalAll() {
  let tp = 0, fp = 0, fn = 0;
  for (const pg of pages) {
    const r = legacy.countPixFromBuffer(pg.w, pg.h, pg.rgba, 0);
    const oSys = r.cxs.map((s) => ({ cs: s.cs }));
    const oBars = r.bxs;
    const { pairs, usedO } = matchSystems(pg.gt.systems, oSys);
    for (const [gi, oi] of pairs) {
      if (oi < 0) { fn += Math.max(0, pg.gt.bars[gi].length - 2); continue; }
      const want = pg.gt.bars[gi].slice(1, -1);
      const internal = (oBars[oi] ?? []).slice(1, -1);
      const used = new Array(internal.length).fill(false);
      for (const w of want) {
        let found = -1;
        internal.forEach((d, ii) => {
          if (!used[ii] && found < 0 && Math.abs(d - w) <= TOL) found = ii;
        });
        if (found >= 0) { used[found] = true; tp++; }
        else fn++;
      }
      fp += used.filter((u) => !u).length;
    }
    oSys.forEach((_, oi) => {
      if (!usedO.has(oi)) fp += Math.max(0, (oBars[oi] ?? []).length - 2);
    });
  }
  return { tp, fp, fn };
}

console.log("zwgrens,voorna,mtdrmpl,tp,fp,fn,prec,rec");
const base = { ...legacy.legacyOpt };
for (const zw of ZWS) for (const vo of VOS) for (const mt of MTS) {
  Object.assign(legacy.legacyOpt, base, { zwgrens: zw, voorna: vo, mtdrmpl: mt });
  const { tp, fp, fn } = evalAll();
  const prec = (tp / Math.max(1, tp + fp)).toFixed(3);
  const rec = (tp / Math.max(1, tp + fn)).toFixed(3);
  console.log(`${zw},${vo},${mt},${tp},${fp},${fn},${prec},${rec}`);
}
console.log("SWEEP_DONE");
