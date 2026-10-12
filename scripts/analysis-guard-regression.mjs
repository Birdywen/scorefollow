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
const quality = { version: "evidence-1", outcome: "complete", issues: [], pitchCoverage: 1, timingCoverage: 1, followReady: true };
const diagnostics = { analysisId: "fixture", algorithmVersion: "1", inputHash: "a".repeat(64), elapsedMs: 50 };
assert.equal(guard.isValidAnalysisResult({ ...valid, quality, diagnostics }), true);
for (const bad of [null, { ...quality, outcome: "unknown" }, { ...quality, pitchCoverage: Infinity }, { ...quality, timingCoverage: -1 }, { ...quality, issues: [null] }, { ...quality, followReady: "yes" }]) {
  assert.equal(guard.isValidAnalysisResult({ ...valid, quality: bad }), false);
}
assert.equal(guard.isValidAnalysisResult({ ...valid, diagnostics: { ...diagnostics, elapsedMs: -1 } }), false);

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
// 回归:面板按整数小节号做 Math.max/onJump,按数值计数与 0-100 分数渲染;非法值必须拒收。
assert.equal(guard.isValidAnalysisResult({
  ...valid, summary: { ...summary, measureCount: 6, startMeasure: 1, endMeasure: 6 },
}), true);
// 真实引擎输出 confidence 可略超 1(如 1.02),必须放行。
assert.equal(guard.isValidAnalysisResult({ ...valid, notes: [{ ...note, confidence: 1.02 }] }), true);
for (const badNote of [{ ...note, measure: 1.5 }, { ...note, measure: NaN },
  { ...note, measure: Infinity }, { ...note, measure: 0 }, { ...note, id: "" },
  { ...note, confidence: NaN }, { ...note, confidence: Infinity }, { ...note, confidence: -0.5 }, { ...note, status: "" }]) {
  assert.equal(guard.isValidAnalysisResult({ ...valid, notes: [badNote] }), false);
}
for (const badSummary of [{ ...summary, pitchScore: Infinity }, { ...summary, pitchScore: NaN },
  { ...summary, pitchScore: 101 }, { ...summary, pitchScore: -1 },
  { ...summary, rhythmScore: Infinity }, { ...summary, noteCount: 1.5 },
  { ...summary, noteCount: -1 }, { ...summary, voicedNotes: -1 }, { ...summary, timedNotes: 0.5 },
  { ...summary, timingOffsetMs: Infinity }, { ...summary, timingSpreadMs: NaN },
  { ...summary, confidence: "" }, { ...summary, measureCount: "6" },
  { ...summary, measureCount: 1.5 }, { ...summary, startMeasure: 1.5 }, { ...summary, endMeasure: 0 }]) {
  assert.equal(guard.isValidAnalysisResult({ ...valid, summary: badSummary }), false);
}
console.log("ANALYSIS_GUARD_REGRESSION_PASS");
