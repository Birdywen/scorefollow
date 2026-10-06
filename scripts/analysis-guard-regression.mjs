import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const source = readFileSync(new URL("../lib/analysis-guard.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "sf-analysis-guard-"));
const modulePath = join(dir, "analysis-guard.mjs");
writeFileSync(modulePath, output);
const guard = await import(pathToFileURL(modulePath));

const summary = {
  pitchScore: 90, rhythmScore: 80, timingOffsetMs: 0, timingSpreadMs: 12,
  noteCount: 1, voicedNotes: 1, timedNotes: 1, confidence: "high",
};
const note = {
  id: "n1", measure: 1, expectedSec: 0, performedSec: 0,
  pitchErrorCents: 0, timingErrorMs: 0, confidence: 1, status: "correct",
};
const valid = { version: "1", notes: [note], limitations: [], summary };

assert.equal(guard.isValidJobEnvelope({ id: "j1", status: "completed" }), true);
assert.equal(guard.isValidJobEnvelope({ id: "", status: "completed" }), false);
assert.equal(guard.isValidAnalysisResult(valid), true);
const interval = { measure: 1, startSec: 0, endSec: 1 };
assert.equal(guard.isValidAnalysisResult({ ...valid, measureIntervals: [interval] }), true);
for (const measureIntervals of [{}, null, [null], [{ ...interval, startSec: -1 }], [{ ...interval, endSec: 0 }], [{ ...interval, endSec: Infinity }], [{ ...interval, measure: 1.5 }]]) {
  assert.equal(guard.isValidAnalysisResult({ ...valid, measureIntervals }), false);
}
assert.equal(guard.isValidAnalysisResult({ ...valid, notes: [{ ...note, measure: "1" }] }), false);
assert.equal(guard.isValidAnalysisResult({ ...valid, summary: { ...summary, noteCount: "1" } }), false);
assert.equal(guard.isValidAnalysisResult({ ...valid, limitations: [null] }), false);
console.log("ANALYSIS_GUARD_REGRESSION_PASS");
