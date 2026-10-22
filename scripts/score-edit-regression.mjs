// Editing recognized MusicXML: pitches follow the analyzer's accidental rules, edits stay local.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "sf-edit-"));
writeFileSync(join(dir, "score-edit.mjs"), ts.transpileModule(readFileSync(new URL("../lib/score-edit.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText);
const E = await import(pathToFileURL(join(dir, "score-edit.mjs")));

const note = (pitch, dur, type, extra = "") => `<note>${pitch}<duration>${dur}</duration>${extra.includes("<tie") ? extra.match(/<tie[^>]*\/>/g).join("") : ""}<voice>1</voice><type>${type}</type>${extra.replace(/<tie[^>]*\/>/g, "")}<staff>1</staff></note>`;
const p = (s, o, a) => `<pitch><step>${s}</step>${a != null ? `<alter>${a}</alter>` : ""}<octave>${o}</octave></pitch>`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
${note(p("G", 4), 2, "quarter")}
<note><chord/>${p("B", 4)}<duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
${note(p("F", 4), 2, "quarter")}
${note(p("F", 4), 2, "quarter", "<accidental>natural</accidental>")}
${note(p("F", 4), 2, "quarter")}
</measure>
<measure number="2">${note("<rest/>", 2, "quarter")}${note("<rest/>", 2, "quarter")}${note(p("C", 5), 4, "half", '<tie type="start"/><notations><tied type="start"/></notations>')}</measure>
<measure number="3">${note(p("C", 5), 4, "half", '<tie type="stop"/><notations><tied type="stop"/></notations>')}${note(p("D", 5), 2, "quarter")}</measure>
<measure number="4"><note><rest measure="yes"/><duration>8</duration><voice>1</voice><staff>1</staff></note></measure>
</part></score-partwise>`;

const names = (x, mi) => E.readMeasure(x, mi).parts[0].notes.map((n) => (n.pitch ? E.pitchName(n.pitch) : "rest"));
assert.equal(E.measureCount(xml), 4);
const m1 = E.readMeasure(xml, 0);
assert.equal(m1.number, "1");
assert.deepEqual(names(xml, 0), ["G4", "B4", "F♯4", "F4", "F4"], "key signature and a natural that carries through the bar");
assert.deepEqual(m1.parts[0].notes.map((n) => n.chordSize), [2, 2, 1, 1, 1]);
assert.equal(m1.parts[0].length, 4);
assert.equal(m1.parts[0].expected, 4);
assert.deepEqual(E.lengthIssues(xml), [{ index: 2, number: "3", actual: 3, expected: 4 }], "bar 3 is a beat short; the empty last bar is fine");

// Pitch edits: only the edited note changes; the natural it drops stops carrying.
let x = E.setNotePitch(xml, 0, 0, 2, { step: "E", alter: 0, octave: 4 });
assert.deepEqual(names(x, 0), ["G4", "B4", "E4", "F4", "F4"]);
const m1Span = E.readMeasure(xml, 0).parts[0];
assert.equal(x.slice(0, m1Span.start), xml.slice(0, m1Span.start), "text before the measure untouched");
assert.equal(x.slice(x.indexOf('<measure number="2"')), xml.slice(xml.indexOf('<measure number="2"')), "text after the measure untouched");
x = E.setNotePitch(xml, 0, 0, 3, { step: "F", alter: 1, octave: 4 });
assert.deepEqual(names(x, 0), ["G4", "B4", "F♯4", "F♯4", "F♯4"], "natural removed, so the key's F♯ applies again");
assert.doesNotMatch(E.measureXml(x, 0, 0), /<accidental>/);
x = E.setNotePitch(xml, 0, 0, 0, { step: "G", alter: 1, octave: 4 });
assert.match(E.measureXml(x, 0, 0), /<step>G<\/step><alter>1<\/alter><octave>4<\/octave><\/pitch><duration>2<\/duration><voice>1<\/voice><type>quarter<\/type><accidental>sharp<\/accidental>/);
assert.deepEqual(names(x, 0), ["G♯4", "B4", "F♯4", "F4", "F4"]);
x = E.setNotePitch(xml, 0, 0, 4, { step: "F", alter: 0, octave: 4 }); // already natural via the earlier sign: no new accidental
assert.equal((E.measureXml(x, 0, 0).match(/<accidental>/g) ?? []).length, 1);
assert.throws(() => E.setNotePitch(xml, 0, 0, 2, { step: "H", alter: 0, octave: 4 }));
// Picking a new letter starts from what the key and the bar imply for it.
assert.equal(E.impliedAlter(xml, 0, 0, 2, "E", 4), 0);
assert.equal(E.impliedAlter(xml, 0, 0, 0, "F", 4), 1, "F in G major");
assert.equal(E.impliedAlter(xml, 0, 0, 4, "F", 4), 0, "after the natural earlier in the bar");
assert.equal(E.impliedAlter(xml, 0, 0, 4, "F", 5), 1, "a sign only holds for its own octave");
assert.throws(() => E.setNotePitch(xml, 1, 0, 0, { step: "C", alter: 0, octave: 4 }), /not a pitched note/);

// A tied note is one sound: both halves move, across the barline.
x = E.setNotePitch(xml, 1, 0, 2, { step: "D", alter: 0, octave: 5 });
assert.deepEqual(names(x, 1), ["rest", "rest", "D5"]);
assert.deepEqual(names(x, 2), ["D5", "D5"]);
x = E.setNotePitch(xml, 2, 0, 0, { step: "B", alter: -1, octave: 4 }); // from the tied-to half, backwards
assert.deepEqual(names(x, 1), ["rest", "rest", "B♭4"]);
assert.deepEqual(names(x, 2), ["B♭4", "D5"]);

// Note <-> rest keeps the rhythm; ties to a removed note are dropped.
x = E.noteToRest(xml, 1, 0, 2);
assert.deepEqual(names(x, 1), ["rest", "rest", "rest"]);
assert.equal(E.readMeasure(x, 2).parts[0].notes[0].tieStop, false);
assert.doesNotMatch(E.measureXml(x, 2, 0), /tied/);
assert.equal(E.readMeasure(x, 1).parts[0].length, 4);
assert.throws(() => E.noteToRest(xml, 0, 0, 0), /single note/);
x = E.restToNote(xml, 3, 0, 0, { step: "F", alter: 0, octave: 4 });
assert.deepEqual(names(x, 3), ["F4"]);
assert.match(E.measureXml(x, 3, 0), /<type>whole<\/type><accidental>natural<\/accidental>/, "whole-bar rest gets a note value; F natural in G major gets its sign");
x = E.restToNote(xml, 1, 0, 0, { step: "A", alter: 0, octave: 4 });
assert.deepEqual(names(x, 1), ["A4", "rest", "C5"]);
assert.equal(E.readMeasure(x, 1).parts[0].length, 4);

// Chord tones: add a third above the top, delete any tone (also the head).
let added = E.addChordTone(xml, 0, 0, 0);
assert.equal(added.index, 2);
assert.deepEqual(names(added.xml, 0), ["G4", "B4", "D5", "F♯4", "F4", "F4"]);
assert.deepEqual(E.readMeasure(added.xml, 0).parts[0].notes.slice(0, 3).map((n) => [n.chord, n.chordSize]), [[false, 3], [true, 3], [true, 3]]);
assert.equal(E.readMeasure(added.xml, 0).parts[0].length, 4);
added = E.addChordTone(xml, 0, 0, 2); // F♯4 -> A4 above it
assert.deepEqual(names(added.xml, 0), ["G4", "B4", "F♯4", "A4", "F4", "F4"]);
x = E.deleteChordTone(xml, 0, 0, 1);
assert.deepEqual(names(x, 0), ["G4", "F♯4", "F4", "F4"]);
x = E.deleteChordTone(xml, 0, 0, 0);
assert.deepEqual(names(x, 0), ["B4", "F♯4", "F4", "F4"]);
assert.equal(E.readMeasure(x, 0).parts[0].notes[0].chord, false);
assert.equal(E.readMeasure(x, 0).parts[0].length, 4);
assert.match(E.measureXml(x, 0, 0), /<attributes>/, "the head keeps its place after the attributes");
assert.throws(() => E.deleteChordTone(xml, 0, 0, 2), /chord tone/);

// Raw measure XML: one measure only, and the score keeps its measure count.
const fixed = E.measureXml(xml, 2, 0).replace("</measure>", `${note(p("E", 5), 2, "quarter")}</measure>`);
x = E.replaceMeasureXml(xml, 2, 0, "\n" + fixed + "\n");
assert.deepEqual(names(x, 2), ["C5", "D5", "E5"]);
assert.deepEqual(E.lengthIssues(x), []);
assert.throws(() => E.replaceMeasureXml(xml, 2, 0, "<note/>"), /exactly one/);
assert.throws(() => E.replaceMeasureXml(xml, 2, 0, fixed + fixed), /exactly one/);
assert.throws(() => E.replaceMeasureXml(xml, 2, 0, "<measure></part><part><measure></measure>"), /exactly one/);
assert.equal(E.readMeasure(xml, 9), null);

// Two staves with backup: the bar length is the longest voice, not the sum.
const piano = `<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
${note(p("E", 5), 3, "half", "<dot/>")}<backup><duration>3</duration></backup><note>${p("C", 3)}<duration>3</duration><voice>5</voice><type>half</type><dot/><staff>2</staff></note>
</measure><measure number="2">${note(p("E", 5), 3, "half", "<dot/>")}<backup><duration>3</duration></backup><note>${p("C", 3)}<duration>2</duration><voice>5</voice><type>half</type><staff>2</staff></note></measure>
<measure number="3">${note(p("E", 5), 2, "half")}</measure></part></score-partwise>`;
assert.deepEqual(E.lengthIssues(piano), [], "a short lower staff inside a full bar is not flagged");
assert.deepEqual(E.readMeasure(piano, 0).parts[0].notes.map((n) => [n.staff, n.dots]), [["1", 1], ["2", 1]]);

// What the editor shows is what the analyzer hears: compare with engine.parse_score on edited scores.
const variants = [
  xml,
  E.setNotePitch(xml, 0, 0, 3, { step: "F", alter: 1, octave: 4 }),
  E.setNotePitch(xml, 0, 0, 0, { step: "G", alter: 1, octave: 4 }),
  E.setNotePitch(xml, 2, 0, 0, { step: "B", alter: -1, octave: 4 }),
  E.noteToRest(xml, 1, 0, 2),
  E.restToNote(xml, 3, 0, 0, { step: "F", alter: 0, octave: 4 }),
  E.addChordTone(xml, 0, 0, 0).xml,
  E.deleteChordTone(xml, 0, 0, 0),
];
const shown = variants.map((v) => Array.from({ length: E.measureCount(v) }, (_, mi) => E.readMeasure(v, mi).parts[0].notes
  .filter((n) => n.midi != null && !n.grace && !n.tieStop).map((n) => n.midi).sort((a, b) => a - b)));
const py = spawnSync("python3", ["-B", "-c", `
import json, sys
from analysis_service.engine import parse_score
out = []
for xml in json.load(sys.stdin):
    per = {}
    for n in parse_score(xml):
        per.setdefault(n["measure"], []).extend(n.get("chordMidi", [n["pitchMidi"]]))
    out.append(per)
print(json.dumps(out))`], { cwd: new URL("..", import.meta.url), input: JSON.stringify(variants), encoding: "utf8" });
assert.equal(py.status, 0, py.stderr);
const heard = JSON.parse(py.stdout);
const measureKeys = Object.keys(heard[0]).map(Number).sort((a, b) => a - b);
const base = measureKeys[0]; // engine measure numbering
variants.forEach((_, vi) => shown[vi].forEach((mids, mi) => {
  assert.deepEqual((heard[vi][base + mi] ?? []).slice().sort((a, b) => a - b), mids, `variant ${vi} measure ${mi + 1}`);
}));
console.log("SCORE_EDIT_OK");
