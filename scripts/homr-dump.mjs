/** 跑 detector 存 ours.json, 供 overlay 可视化与人工仲裁. */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sf-homrdump-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "inherit" },
);
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);
// A/B: SF_FLAGS='{"notemask":1,"widrescue":1}' 测逆向路线开关组合
if (process.env.SF_FLAGS) {
  Object.assign(legacy.legacyOpt, JSON.parse(process.env.SF_FLAGS));
  console.log("SF_FLAGS", process.env.SF_FLAGS);
}

const benchRoot = process.env.SF_BENCH_ROOT ?? join(root, "benchmarks", "homr");
const names = process.argv[2] ? [process.argv[2]]
  : (process.env.SF_BENCH_ROOT
      ? readdirSync(benchRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(benchRoot, e.name, "meta.json"))).map((e) => e.name)
      : ["secret_garden", "toccatta"]);
for (const name of names) {
  const dir = join(benchRoot, name);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const out = { algoVersion: legacy.ALGO_VERSION, pages: [] };
  for (const pm of meta.pages) {
    const raw = readFileSync(join(dir, `page_${pm.page}.raw`));
    const rgba = new Uint8ClampedArray(pm.w * pm.h * 4);
    for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
      rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
    }
    const r = legacy.countPixFromBuffer(pm.w, pm.h, rgba, 0);
    out.pages.push({
      page: pm.page, spatium: legacy.getSpatium(),
      systems: r.cxs.map((s) => ({ y1: s.cs[0], y2: s.cs[s.cs.length - 1], x1: s.xs.x1, x2: s.xs.x2 })),
      bars: r.bxs,
    });
  }
  writeFileSync(join(dir, "ours.json"), JSON.stringify(out));
  console.log(`wrote ${name}/ours.json`);
}
