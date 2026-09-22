/** 逐行扫描: 打印候选列窗内符头级宽行明细, 定位符头漏检.
 * 用法: node scripts/rowscan.mjs <score> <page> <sys1> <x>
 * 输出: feat + "宽行表 row:width(*=谱线行跳过)".
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-rowscan-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "pipe" },
);
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);
const [score, pageStr, sysStr, xStr] = process.argv.slice(2);
const page = Number(pageStr), sys1 = Number(sysStr), X = Number(xStr);
const dir = join(root, "benchmarks", "gpu", score);
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const pm = meta.pages[page - 1];
const raw = readFileSync(join(dir, `page_${page}.raw`));
const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) { rgba[j] = raw[i]; rgba[j+1] = raw[i+1]; rgba[j+2] = raw[i+2]; rgba[j+3] = 255; }
const r = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
console.log("spatium:", legacy.getSpatium(), "cs:", JSON.stringify(r.cxs[sys1 - 1].cs));
console.log("feat:", JSON.stringify(legacy.barStemFeatures(sys1 - 1, X)));
console.log("wide:", legacy.debugBarColumn(sys1 - 1, X).rows);
