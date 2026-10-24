// Bar loop of a followed take + the video export's pure layout/timeline helpers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "sf-takeloop-"));
async function load(name) {
  const out = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(dir, `${name}.mjs`), out);
  return import(pathToFileURL(join(dir, `${name}.mjs`)));
}
const { barLoopWindow, LOOP_PRE_SEC } = await load("take-loop");
const V = await load("score-video");
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// Bars 0..3 at 2 s each, bars 1-2 repeated: 0 1 2 1 2 3.
const times = [0, 1, 2, 1, 2, 3].map((mix, i) => ({ t: 1 + 2 * i, mix }));
let w = barLoopWindow(times, 1, 2);
near(w.start, 3 - LOOP_PRE_SEC, "first pass start"); near(w.end, 7, "first pass end");
w = barLoopWindow(times, 2, 1, 8);                       // reversed range, playhead in pass 2
near(w.start, 7 - LOOP_PRE_SEC, "second pass start"); near(w.end, 11, "second pass end");
w = barLoopWindow(times, 1, 1, 6.5);                     // playhead between passes -> next pass
near(w.start, 7 - LOOP_PRE_SEC, "next pass"); near(w.end, 9, "one bar");
w = barLoopWindow(times, 3, 3, 0, 12);                   // last bar: previous gap, capped by take end
near(w.start, 11 - LOOP_PRE_SEC, "last start"); near(w.end, 12, "capped by end");
w = barLoopWindow(times, 3, 3);
near(w.end, 13, "last bar uses previous gap");
assert.equal(barLoopWindow(times, 5, 6), null, "bars not in take");
assert.equal(barLoopWindow([], 0, 1), null, "no times");
w = barLoopWindow([{ t: 0.05, mix: 0 }, { t: 2, mix: 1 }], 0, 0);
near(w.start, 0, "start clamps at 0");

// Two pages of 1000x1400 stacked; two systems on page 1, one on page 2.
const offsets = [{ page: 1, y: 0, h: 1400, w: 1000 }, { page: 2, y: 1400, h: 1400, w: 1000 }];
const m = (x, y) => ({ x, y, w: 200, h: 100 });
const measures = [m(100, 200), m(300, 200), m(100, 500), m(300, 500), m(100, 1600)];
const vs = V.videoSystems(measures, offsets);
assert.deepEqual(vs.systemOf, [0, 0, 1, 1, 2]);
assert.deepEqual(vs.systems.map((s) => s.page), [1, 1, 2]);
assert.ok(vs.systems[0].bottom <= vs.systems[1].top + 1e-9, "bands of one page do not overlap");
assert.ok(vs.systems[2].top >= 1400, "page-2 band stays on page 2");
assert.ok(vs.x1 < 100 && vs.x2 > 500 && vs.x2 <= 1000, "common crop");
for (const layout of ["landscape", "portrait"]) {
  const L = V.slotLayout(vs.systems, vs.x1, vs.x2, V.CONTENT[layout]);
  assert.ok(L.n >= 2 && L.n <= 6, `${layout} slot count ${L.n}`);
  assert.ok(L.k * (vs.x2 - vs.x1) <= V.CONTENT[layout].w + 1e-6, `${layout} fits width`);
  const maxH = Math.max(...vs.systems.map((s) => s.bottom - s.top));
  assert.ok(L.k * maxH <= L.slots[0].h + 1e-6, `${layout} fits slot height`);
}
assert.deepEqual(V.slotSystems(0, 3, 5), [0, 1, 2]);
assert.deepEqual(V.slotSystems(1, 3, 5), [3, 1, 2]);   // finished system 0's slot already shows 3
assert.deepEqual(V.slotSystems(4, 3, 5), [3, 4, 2]);   // past the end: earlier systems stay
assert.deepEqual(V.slotSystems(0, 4, 2), [0, 1, null, null]);
assert.equal(V.entryAt(times, 0), 0); assert.equal(V.entryAt(times, 5.5), 2); assert.equal(V.entryAt(times, 99), 5);
assert.deepEqual(V.systemChanges([{ t: 0, mix: 0 }, { t: 1, mix: 1 }, { t: 2, mix: 2 }, { t: 3, mix: 0 }], [0, 0, 1]),
  [{ t: 2, from: 0, to: 1 }, { t: 3, from: 1, to: 0 }]);

const tl = V.makeTimeline(10, 40);
near(tl.total, 3 + 30 + 4, "total");
let p = V.phaseAt(0, tl); near(p.intro, 1, "intro full"); near(p.t, 10, "t at a");
p = V.phaseAt(2.75, tl); near(p.intro, 0.5, "intro fading");
p = V.phaseAt(18, tl); near(p.intro, 0, "no intro"); near(p.outro, 0, "no outro"); near(p.t, 25, "t mid");
p = V.phaseAt(33.25, tl); near(p.outro, 0.5, "outro fading"); near(p.t, 40, "t at b");
near(V.audioGain(1, tl), 0, "silent intro"); near(V.audioGain(18, tl), 1, "full");
near(V.audioGain(32.6, tl), 0.5, "fading out"); near(V.audioGain(34, tl), 0, "silent outro");
console.log("TAKE_LOOP_OK");
