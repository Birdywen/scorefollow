import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-system-debug-"));
execSync(`npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`, { cwd: root, stdio: "pipe" });
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);
const [score, pageStr] = process.argv.slice(2);
const page = Number(pageStr);
const dir = join(root, "benchmarks", "gpu", score);
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const pm = meta.pages[page - 1];
const raw = readFileSync(join(dir, `page_${page}.raw`));
const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
  rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
}
const result = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
console.log(JSON.stringify({
  score, page, spatium: legacy.getSpatium(),
  rowGroups: legacy.getLastRowGroups(),
  join: legacy.getLastJoinDebug(),
  systems: result.cxs.map((s) => ({ cs: s.cs, x: s.xs })),
}, null, 2));
