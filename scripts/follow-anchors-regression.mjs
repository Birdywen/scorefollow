// Follow-with-take click accuracy: clicks land on measured onsets, inside the clicked measure.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "sf-follow-"));
async function load(name) {
  const out = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(dir, `${name}.mjs`), out);
  return import(pathToFileURL(join(dir, `${name}.mjs`)));
}
const { followAnchors } = await load("follow-anchors");
const { Wijzer } = await load("synpdf-wijzer");

// Two 4-beat measures from a real take (no26 m1-m2): fitted starts vs played downbeats.
const intervals = [{ measure: 1, startSec: 2.519, endSec: 4.528 }, { measure: 2, startSec: 4.528, endSec: 6.769 }];
const notes = [
  { measure: 1, expectedSec: 2.519, performedSec: 2.657 },
  { measure: 1, expectedSec: 3.523, performedSec: 3.315 },
  { measure: 2, expectedSec: 4.528, performedSec: 4.476 },
  { measure: 2, expectedSec: 5.649, performedSec: 5.973 },
  { measure: 2, expectedSec: 6.2, performedSec: 6.3, matchStatus: "uncertain" },
];
const { starts, onsets } = followAnchors(intervals, notes);
assert.deepEqual(starts, [{ measure: 1, startSec: 2.657 }, { measure: 2, startSec: 4.476 }]);
assert.equal(onsets.length, 4, "uncertain match is not a click target");

// Same wiring as page.tsx: shade table leads by 35 ms, clicks use exact onsets.
const w = new Wijzer();
w.measures = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 100, y: 0, w: 100, h: 50 }];
const map = new Map();
for (const o of onsets) map.set(o.measure - 1, [...(map.get(o.measure - 1) ?? []), { frac: o.frac, t: o.sec }].sort((a, b) => a.frac - b.frac));
w.loadTimes(starts.map((s) => ({ t: s.startSec - 0.035, mix: s.measure - 1 })), map);
assert.deepEqual(w.x2time(102, 10), { t: 4.476, measure: 1 }, "click at bar start = played downbeat");
assert.deepEqual(w.x2time(148, 10), { t: 5.973, measure: 1 }, "click mid-bar = nearest played note");
for (const o of onsets) assert.equal(w.time2x(o.sec).measure, o.measure - 1, `shade stays in m${o.measure}`);
assert.equal(w.goMsre(1, 3.0), 4.476, "next-measure key lands on the downbeat");
// A downbeat played before the previous start can't break ordering: fitted start is kept.
const odd = followAnchors(intervals, [{ measure: 1, expectedSec: 2.519, performedSec: 2.657 }, { measure: 2, expectedSec: 4.528, performedSec: 2.6 }]);
assert.deepEqual(odd.starts.map((s) => s.startSec), [2.657, 4.528]);
// Other timelines (tap/preload) clear the onsets: old interpolation behaviour.
w.loadTimes([{ t: 0, mix: 0 }, { t: 2, mix: 1 }]);
assert.equal(w.x2time(150, 10).t, 3.01);
// Repeats unfolded (m1 m2 | m1 m2): every pass is its own start, in time order, with its own onsets.
const rep = [{ measure: 1, startSec: 1, endSec: 2 }, { measure: 2, startSec: 2, endSec: 3 },
  { measure: 1, startSec: 3, endSec: 4 }, { measure: 2, startSec: 4, endSec: 5 }];
const repNotes = [
  { measure: 1, expectedSec: 1, performedSec: 1.02 }, { measure: 1, expectedSec: 1.5, performedSec: 1.51 },
  { measure: 2, expectedSec: 2, performedSec: 2.03 }, { measure: 1, expectedSec: 3, performedSec: 3.04 },
  { measure: 1, expectedSec: 3.5, performedSec: 3.52 }, { measure: 2, expectedSec: 4, performedSec: 4.01 },
];
const r = followAnchors(rep, repNotes);
assert.deepEqual(r.starts, [{ measure: 1, startSec: 1.02 }, { measure: 2, startSec: 2.03 }, { measure: 1, startSec: 3.04 }, { measure: 2, startSec: 4.01 }]);
assert.equal(r.onsets.length, 6, "each pass keeps its own notes");
const rw = new Wijzer();
rw.measures = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 100, y: 0, w: 100, h: 50 }];
const rmap = new Map();
for (const o of r.onsets) rmap.set(o.measure - 1, [...(rmap.get(o.measure - 1) ?? []), { frac: o.frac, t: o.sec }].sort((a, b) => a.frac - b.frac));
rw.loadTimes(r.starts.map((s) => ({ t: s.startSec - 0.035, mix: s.measure - 1 })), rmap);
assert.equal(rw.time2x(3.3).measure, 0, "second pass shows m1 again");
assert.equal(rw.time2x(4.5).measure, 1);
assert.equal(rw.x2time(50, 10, 3.6).t, 3.52, "click in m1 during pass 2 seeks within pass 2");
assert.equal(rw.x2time(50, 10, 1.2).t, 1.51, "click in m1 during pass 1 seeks within pass 1");
assert.equal(rw.x2time(50, 10).t, 1.51, "no playhead: first pass");
console.log("FOLLOW_ANCHORS_REGRESSION_PASS");
