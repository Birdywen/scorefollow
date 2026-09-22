/** 像素 ASCII 图: 打印候选点周围区域的二值化结构, 供肉眼判断.
 * 用法: node scripts/pxdump.mjs <score> <page> <sys1> <x> [halfW=18]
 * 输出: 行号 + ASCII (#=黑 .=白), 谱线行标 *.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-pxdump-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "pipe" },
);
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);
const [score, pageStr, sysStr, xStr, hwStr] = process.argv.slice(2);
const page = Number(pageStr), sys1 = Number(sysStr), X = Number(xStr), HW = Number(hwStr ?? 18);
const dir = join(root, "benchmarks", "gpu", score);
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const pm = meta.pages[page - 1];
const raw = readFileSync(join(dir, `page_${page}.raw`));
const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) { rgba[j] = raw[i]; rgba[j+1] = raw[i+1]; rgba[j+2] = raw[i+2]; rgba[j+3] = 255; }
const r = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
const sys = r.cxs[sys1 - 1];
const cs = sys.cs;
const dark = (row, col) => {
  if (row < 0 || row >= pm.h || col < 0 || col >= pm.w) return false;
  const o = (row * pm.w + col) * 4;
  return (rgba[o] + rgba[o+1] + rgba[o+2]) / 3 < 128;
};
const y0 = Math.max(0, cs[0] - 12), y1 = Math.min(pm.h - 1, cs[cs.length-1] + 12);
console.log(`sp=${legacy.getSpatium()} cs=[${cs.join(",")}] x=${X}`);
for (let row = y0; row <= y1; row++) {
  let line = "";
  for (let col = X - HW; col <= X + HW; col++) line += col === X ? (dark(row, col) ? "@" : "+") : (dark(row, col) ? "#" : ".");
  const staff = cs.some((y) => Math.abs(y - row) <= 1) ? "*" : " ";
  console.log(`${String(row).padStart(4)}${staff} ${line}`);
}
