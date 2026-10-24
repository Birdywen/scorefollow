// Pure parts of the cloud sync: score keys, local-first merge plan, history series.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "sf-cloudsync-"));
let src = readFileSync(new URL("../lib/cloud-sync.ts", import.meta.url), "utf8")
  .replace('import { accountBase } from "./account";', 'const accountBase = (b) => b + "/api/account";');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
writeFileSync(join(dir, "cloud-sync.mjs"), out);
const { scoreKeyOf, planMerge, historySeries, sha256Hex } = await import(pathToFileURL(join(dir, "cloud-sync.mjs")));

assert.equal(scoreKeyOf("  Dotzauer  Cello Etude no. 5 Book 1.PDF "), "dotzauer cello etude no. 5 book 1");
assert.equal(scoreKeyOf("a.musicxml"), "a");
assert.equal(scoreKeyOf("x".repeat(500)).length, 200);

const ct = (id, created, hasResult = false) => ({ id, scoreKey: "k", audioSha: "a".repeat(64), created, updated: created, meta: {}, hasResult });
let plan = planMerge(["a", "b"], [ct("a", 1), ct("c", 5), ct("d", 9)], 10);
assert.deepEqual(plan.pull.map((t) => t.id), ["d", "c"], "pull only what is missing, newest first");
assert.equal(plan.known.get("a"), false);
plan = planMerge(["a", "b", "c"], [ct("x", 1), ct("y", 2), ct("z", 3)], 4);
assert.deepEqual(plan.pull.map((t) => t.id), ["z"], "never exceed the local cap");
assert.deepEqual(planMerge(Array.from({ length: 10 }, (_, i) => String(i)), [ct("n", 1)], 10).pull, [], "full list pulls nothing");

const rows = [
  { id: "3", created: 30, summary: { pitchScore: 90, rhythmScore: null } },
  { id: "1", created: 10, summary: { pitchScore: 70, rhythmScore: 60 } },
  { id: "2", created: 20, summary: { pitchScore: "bad", rhythmScore: 150 } },
  { id: "4", created: 40, summary: null },
];
const series = historySeries(rows);
assert.deepEqual(series.map((p) => p.id), ["1", "3"], "sorted, junk dropped");
assert.deepEqual(series[1], { id: "3", t: 30, pitch: 90, rhythm: null });

if (globalThis.crypto?.subtle) assert.equal(await sha256Hex(new TextEncoder().encode("abc").buffer),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
console.log("CLOUD_SYNC_REGRESSION_OK");
