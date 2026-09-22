/** 行宽剖面: 某系统某列逐行暗宽 ASCII 图, 看符干 vs 真线形状.
 * 用法: node scripts/stem-profile.mjs <score> <page> <sysIdx0> <x> (SF_BENCH_ROOT)
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = process.env.SF_BENCH_ROOT ?? join(root, "benchmarks", "homr");
const tmp = mkdtempSync(join(tmpdir(), "sf-stemprof-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "inherit" },
);
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);

const [name, pageStr, sysStr, xStr] = process.argv.slice(2);
const page = Number(pageStr), si = Number(sysStr), X = Number(xStr);
const dir = join(benchRoot, name);
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const pm = meta.pages[page - 1];
const raw = readFileSync(join(dir, `page_${page}.raw`));
const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
  rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
}
const r = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
const f = legacy.barStemFeatures(si, X);
console.log("features:", JSON.stringify(f));
// 直接读像素逐行剖面(形状参考, 阈值从宽; 判决仍用 legacy 内 darkSum)
const stride = pm.w * 4; // legacy stride 为字节步长
const dark = (row, col) => {
  const g = row * stride + col * 4;
  return rgba[g] + rgba[g + 1] + rgba[g + 2] < 700;
};
const s = r.cxs[si];
const w0 = s.cs[0], t0 = s.cs[s.cs.length - 1];
for (let row = w0; row <= t0; row++) {
  if (!dark(row, X)) continue;
  let lo = X, hi = X;
  while (lo - 1 >= X - 40 && dark(row, lo - 1)) lo--;
  while (hi + 1 <= X + 40 && dark(row, hi + 1)) hi++;
  const wdt = hi - lo + 1;
  console.log(`${row}: ${"#".repeat(Math.min(60, wdt))} (${wdt})`);
}
