import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const source = readFileSync(new URL("../lib/practice-sync.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "sf-practice-sync-"));
const modulePath = join(dir, "practice-sync.mjs");
writeFileSync(modulePath, output);
const sync = await import(pathToFileURL(modulePath));

const slowCountIn = sync.createSession({ startMeasure: 1, bpm: 30, beatsPerMeasure: 4, countInBeats: 8 });
const take = sync.attachRecordingStart(slowCountIn, slowCountIn.scheduledAt - 20);
assert.ok(take.firstBeatAudioSec > 16 && take.firstBeatAudioSec < 17);
assert.equal(sync.validateTakeSync(take.firstBeatAudioSec), null);
assert.equal(sync.validateTakeSync(sync.MAX_FIRST_BEAT_AUDIO_SEC), null);
assert.match(sync.validateTakeSync(sync.MAX_FIRST_BEAT_AUDIO_SEC + 0.01), /0–20/);
assert.equal(sync.measureAndBeatAt({ ...slowCountIn, firstBeatAt: 1000 }, 1000).measure, 1);
assert.deepEqual(sync.measureAndBeatAt({ ...slowCountIn, firstBeatAt: 1000 }, 1000 + 8_100), { measure: 2, beat: 1, elapsedSec: 8.1 });
console.log("PRACTICE_SYNC_REGRESSION_PASS");
