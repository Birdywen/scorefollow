// node scripts/transpile-one.mjs <in.ts> <out.mjs>: syntax-only TS -> ESM for small regression scripts
// (no type check, no @types loading; tsc --noEmit covers types).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import ts from "typescript";
const [src, out] = process.argv.slice(2);
const r = ts.transpileModule(readFileSync(src, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 }, fileName: src,
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, r.outputText);
console.log("TRANSPILED", out, r.outputText.length);
