// Editing one voice of a measure as ABC: rhythm fixes land in that voice only, everything else stays.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "sf-abc-"));
for (const name of ["score-edit", "score-abc"]) {
  const out = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(dir, `${name}.mjs`), out.replace(/from "\.\/score-edit"/g, 'from "./score-edit.mjs"'));
}
const E = await import(pathToFileURL(join(dir, "score-edit.mjs")));
const A = await import(pathToFileURL(join(dir, "score-abc.mjs")));

const p = (s, o, a) => `<pitch><step>${s}</step>${a != null ? `<alter>${a}</alter>` : ""}<octave>${o}</octave></pitch>`;
const n = (pitch, dur, type, voice, staff, extra = "", ties = "") =>
  `<note>${pitch}<duration>${dur}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${extra}<staff>${staff}</staff></note>`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
${n(p("E", 5), 2, "quarter", 1, 1)}
${n(p("F", 5, 1), 2, "quarter", 1, 1)}
<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><staff>1</staff></direction>
${n(p("G", 5), 4, "half", 1, 1, "<stem>down</stem><notations><fermata/></notations>")}
<backup><duration>8</duration></backup>
${n(p("C", 3), 1, "eighth", 5, 2, '<stem>up</stem><beam number="1">begin</beam>')}
${n(p("E", 3), 1, "eighth", 5, 2, '<stem>up</stem><beam number="1">end</beam>')}
</measure>
<measure number="2">
${n(p("C", 5), 2, "quarter", 1, 1)}
${n(p("D", 5), 2, "quarter", 1, 1)}
${n(p("E", 5), 2, "quarter", 1, 1)}
${n(p("F", 5, 1), 2, "quarter", 1, 1, "<notations><tied type=\"start\"/></notations>", '<tie type="start"/>')}
<backup><duration>8</duration></backup>
${n(p("G", 2), 8, "whole", 5, 2)}
</measure>
<measure number="3">
${n(p("F", 5, 1), 4, "half", 1, 1, "<notations><tied type=\"stop\"/></notations>", '<tie type="stop"/>')}
${n(p("G", 5), 4, "half", 1, 1)}
<backup><duration>8</duration></backup>
${n(p("G", 2), 8, "whole", 5, 2)}
</measure>
<measure number="4">
${n(p("B", 4), 2, "quarter", 1, 1)}
<backup><duration>2</duration></backup>
${n(p("D", 4), 4, "half", 2, 1)}
<backup><duration>2</duration></backup>
${n(p("G", 4), 6, "half", 1, 1, "<dot/>")}
<backup><duration>8</duration></backup>
<note><rest measure="yes"/><duration>8</duration><voice>5</voice><staff>2</staff></note>
</measure>
</part></score-partwise>`;

const measures = (x) => [...x.matchAll(/<measure(?=[\s>])[\s\S]*?<\/measure>/g)].map((m) => m[0]);
const text = (x, mi) => Object.fromEntries(A.measureAbc(x, mi, 0).map((v) => [v.voice, v.text]));
const onsets = (x, mi, voice) => { // quarter-note onsets of a voice's struck notes
  const part = E.readMeasure(x, mi).parts[0], b = x.slice(part.start, part.end);
  let pos = 0; const out = [];
  for (const t of b.matchAll(/<(note|backup|forward)(?=[\s>])[\s\S]*?<\/\1>/g)) {
    const d = Number(/<duration>(\d+)/.exec(t[0])?.[1] ?? 0);
    if (t[1] === "backup") pos -= d; else if (t[1] === "forward") pos += d;
    else if (!/<grace/.test(t[0]) && !/<chord\/>/.test(t[0])) {
      if ((/<voice>(\w+)/.exec(t[0])?.[1]) === voice && !/<rest/.test(t[0])) out.push(pos / part.divisions);
      pos += d;
    }
  }
  return out;
};

// Reading: L = 1/8, key signature implied, explicit signs only where needed.
assert.deepEqual(text(xml, 0), { 1: "e2 f2 g4", 5: "C, E," });
assert.deepEqual(text(xml, 1), { 1: "c2 d2 e2 f2-", 5: "G,,8" });
assert.deepEqual(text(xml, 3), { 1: "", 2: "D4", 5: "z8" });
assert.equal(A.abcLength("(3cde d2 e2 f2-"), 4);
assert.equal(A.abcLength("x2 C, x E,"), 2.5);

// Unchanged text: the very same string comes back.
assert.equal(A.applyAbc(xml, 0, 0, "5", "C, E,"), xml);

// The hidden-rest case: bass struck on beats 2 and 3 (rests not printed).
{
  const out = A.applyAbc(xml, 0, 0, "5", "x2 C, x E,");
  assert.deepEqual(onsets(out, 0, "5"), [1, 2]);
  assert.deepEqual(onsets(out, 0, "1"), [0, 1, 2]);
  assert.equal(text(out, 0)[5], "x2 C, x E,");
  const [m1] = measures(out), [o1] = measures(xml);
  assert.equal(m1.slice(0, m1.indexOf("<backup>")), o1.slice(0, o1.indexOf("<backup>")), "voice 1 is byte-identical");
  assert.equal((m1.match(/<rest/g) ?? []).length, 0, "no printed rest");
  assert.equal((m1.match(/<forward>/g) ?? []).length, 2);
  assert.match(m1, /<beam number="1">begin<\/beam>/, "notes keep their beams");
  assert.deepEqual(measures(out).slice(1), measures(xml).slice(1));
}

// Voice 1 shortened: the bass keeps its onsets (the backup absorbs the change).
{
  const out = A.applyAbc(xml, 0, 0, "1", "e2 f2 g2");
  assert.deepEqual(onsets(out, 0, "5"), [0, 0.5]);
  assert.match(measures(out)[0], /<backup><duration>6<\/duration><\/backup>/);
  assert.match(measures(out)[0], /<fermata\/>/, "the changed note keeps its marks");
  assert.match(measures(out)[0], /<type>quarter<\/type><stem>down<\/stem>/);
  assert.match(measures(out)[0], /<dynamics><p\/><\/dynamics>/, "directions stay");
}

// A lost triplet: divisions are refined for this measure only; the next measure gets the old value back.
{
  const out = A.applyAbc(xml, 1, 0, "1", "(3cde d2 e2 f2-");
  const [, m2, m3] = measures(out);
  assert.match(m2, /<divisions>6<\/divisions>/);
  assert.match(m3, /<divisions>2<\/divisions>/);
  assert.equal((m2.match(/<time-modification><actual-notes>3<\/actual-notes><normal-notes>2<\/normal-notes><\/time-modification>/g) ?? []).length, 3);
  assert.match(m2, /<tuplet type="start"\/>/);
  assert.match(m2, /<tuplet type="stop"\/>/);
  assert.deepEqual(onsets(out, 1, "1").map((t) => Math.round(t * 1000) / 1000), [0, 0.333, 0.667, 1, 2, 3]);
  assert.deepEqual(onsets(out, 1, "5"), [0]);
  assert.equal(text(out, 1)[1], "(3c d e d2 e2 f2-");
  assert.deepEqual(E.lengthIssues(out), []);
}

// Removing a tie into the next measure removes its stop there too.
{
  const out = A.applyAbc(xml, 1, 0, "1", "c2 d2 e2 f2");
  assert.doesNotMatch(measures(out)[1], /<tie/);
  assert.doesNotMatch(measures(out)[2], /<tie|<tied/);
  assert.match(measures(out)[2], /<step>F<\/step><alter>1<\/alter>/);
}

// Signs: =f is F natural in G major and carries through the line; ^ on a new note is written out.
{
  const out = A.applyAbc(xml, 0, 0, "1", "=f2 f2 ^g4");
  const notes = E.readMeasure(out, 0).parts[0].notes.filter((x) => x.voice === "1");
  assert.deepEqual(notes.map((x) => x.midi), [77, 77, 80]);
  assert.equal(notes[0].accidental, "natural");
  assert.equal(notes[1].accidental, null);
  assert.equal(notes[2].accidental, "sharp");
  assert.equal(text(out, 0)[1], "=f2 f2 ^g4");
}

// Chords and grace notes.
{
  const out = A.applyAbc(xml, 0, 0, "1", "{d}[ce]2 [df]2 g4");
  const notes = E.readMeasure(out, 0).parts[0].notes.filter((x) => x.voice === "1");
  assert.deepEqual(notes.map((x) => [x.midi, x.grace, x.chord]), [[74, true, false], [72, false, false], [76, false, true],
    [74, false, false], [78, false, true], [79, false, false]]);
  assert.equal(text(out, 0)[1], "{d} [ce]2 [df]2 g4");
}

// Mistakes come back as messages with a position, in both languages.
for (const [bad, zh] of [["c2 q", "看不懂"], ["(3cd", "连音组需要 3 个音"], ["c5/4", "不能用一个音符表示"], ["[ce2]", "] 后面"], ["c>d", "不支持"]]) {
  assert.throws(() => A.applyAbc(xml, 0, 0, "1", bad), (e) => e instanceof A.AbcError && e.zh.includes(zh) && e.en.length > 0, bad);
}

// A voice written in two pieces around another voice is left to the XML editor.
{
  const v = A.measureAbc(xml, 3, 0).find((x) => x.voice === "1");
  assert.equal(v.editable, false);
  assert.match(v.reason.zh, /交错/);
  assert.throws(() => A.applyAbc(xml, 3, 0, "1", "B2 G6"), A.AbcError);
}

// Rests: a whole-bar rest keeps measure="yes" when untouched, and z works anywhere.
{
  const out = A.applyAbc(xml, 3, 0, "5", "z4 G,,4");
  assert.deepEqual(onsets(out, 3, "5"), [2]);
  assert.deepEqual(onsets(out, 3, "2"), [0]);
  assert.match(measures(out)[3], /<rest\/>/);
}

console.log("SCORE_ABC_OK");
