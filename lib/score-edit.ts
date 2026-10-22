/** Small fixes to recognized MusicXML: note pitch, note <-> rest, chord tones, raw measure XML.
 * Edits are string splices, so everything the editor does not touch stays byte-for-byte.
 * Sounding pitch follows the analyzer's rules (analysis_service/engine.py): an explicit
 * <alter>, else the <accidental>, else an earlier accidental on the same step+octave in
 * the measure, else the key signature. */

export type Pitch = { step: string; alter: number; octave: number };
export type EditNote = {
  index: number; start: number; end: number;
  rest: boolean; chord: boolean; grace: boolean; unpitched: boolean;
  pitch: Pitch | null; midi: number | null; accidental: string | null;
  tieStart: boolean; tieStop: boolean;
  duration: number | null; type: string | null; dots: number;
  staff: string; voice: string;
  /** Notes sounding together with this one (head plus <chord/> members). */
  chordSize: number;
};
export type EditPart = {
  partIndex: number; partId: string; start: number; end: number; notes: EditNote[];
  fifths: number; divisions: number;
  /** Measure length and the time signature's length, in quarter notes (null when unknown). */
  length: number; expected: number | null;
};
export type EditMeasure = { index: number; number: string; parts: EditPart[] };
export type LengthIssue = { index: number; number: string; actual: number; expected: number };

const STEPS = "CDEFGAB";
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC_ALTER: Record<string, number> = {
  sharp: 1, natural: 0, flat: -1, "double-sharp": 2, "sharp-sharp": 2, "flat-flat": -2,
  "natural-sharp": 1, "natural-flat": -1,
};
const ACC_NAME: Record<number, string> = { [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };
const TYPES: Array<[number, string, number]> = [ // quarter notes, type, dots
  [6, "whole", 1], [4, "whole", 0], [3, "half", 1], [2, "half", 0], [1.5, "quarter", 1], [1, "quarter", 0],
  [0.75, "eighth", 1], [0.5, "eighth", 0], [0.375, "16th", 1], [0.25, "16th", 0], [0.125, "32nd", 0],
];

const tagText = (block: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(block);
  return m ? m[1].trim() : null;
};
const tagNum = (block: string, tag: string): number | null => {
  const t = tagText(block, tag);
  const n = t == null || t === "" ? NaN : Number(t);
  return Number.isFinite(n) ? n : null;
};
const attr = (open: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1] ?? null;
const keyAlter = (fifths: number, step: string) =>
  fifths > 0 && "FCGDAEB".slice(0, fifths).includes(step) ? 1 : fifths < 0 && "BEADGCF".slice(0, -fifths).includes(step) ? -1 : 0;
export const pitchMidi = (p: Pitch) => 12 * (p.octave + 1) + SEMI[p.step] + p.alter;
export function pitchName(p: Pitch): string {
  return p.step + ({ [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" } as Record<number, string>)[p.alter] + p.octave;
}

type RawMeasure = { start: number; end: number; number: string; implicit: boolean;
  fifths: number; divisions: number; beats: number | null; beatType: number | null };
type RawPart = { id: string; measures: RawMeasure[] };

function scan(xml: string): RawPart[] {
  const parts: RawPart[] = [];
  for (const pm of xml.matchAll(/<part(?=[\s>])[^>]*>[\s\S]*?<\/part>/g)) {
    const base = pm.index ?? 0, body = pm[0];
    let fifths = 0, divisions = 1, beats: number | null = null, beatType: number | null = null;
    const measures: RawMeasure[] = [];
    for (const mm of body.matchAll(/<measure(?=[\s>])[^>]*>[\s\S]*?<\/measure>/g)) {
      const block = mm[0], open = block.slice(0, block.indexOf(">") + 1);
      for (const am of block.matchAll(/<attributes(?=[\s>])[\s\S]*?<\/attributes>/g)) {
        const a = am[0];
        const f = tagNum(a, "fifths"); if (f != null) fifths = f;
        const d = tagNum(a, "divisions"); if (d != null && d > 0) divisions = d;
        if (/<senza-misura/.test(a)) { beats = null; beatType = null; }
        const b = tagNum(a, "beats"), bt = tagNum(a, "beat-type");
        if (/<time(?=[\s>])/.test(a)) { beats = b; beatType = bt; }
      }
      const start = base + (mm.index ?? 0);
      measures.push({ start, end: start + block.length, number: attr(open, "number") ?? String(measures.length + 1),
        implicit: attr(open, "implicit") === "yes", fifths, divisions, beats, beatType });
    }
    parts.push({ id: attr(body.slice(0, body.indexOf(">") + 1), "id") ?? "", measures });
  }
  return parts;
}

export function measureCount(xml: string): number {
  return scan(xml)[0]?.measures.length ?? 0;
}

function measureLength(block: string, divisions: number): number {
  let pos = 0, max = 0;
  for (const t of block.matchAll(/<(note|backup|forward)(?=[\s>])[\s\S]*?<\/\1>/g)) {
    const b = t[0], d = tagNum(b, "duration") ?? 0;
    if (t[1] === "backup") pos -= d;
    else if (t[1] === "forward") pos += d;
    else if (!/<grace(?=[\s/>])/.test(b) && !/<chord\s*\/>/.test(b)) pos += d;
    max = Math.max(max, pos);
  }
  return max / divisions;
}

function readPart(xml: string, raw: RawMeasure, partIndex: number, partId: string): EditPart {
  const block = xml.slice(raw.start, raw.end);
  const memory = new Map<string, number>();
  const notes: EditNote[] = [];
  for (const nm of block.matchAll(/<note(?=[\s>])[\s\S]*?<\/note>/g)) {
    const b = nm[0], start = raw.start + (nm.index ?? 0);
    const pb = /<pitch>([\s\S]*?)<\/pitch>/.exec(b)?.[1];
    const accidental = tagText(b, "accidental");
    let pitch: Pitch | null = null;
    if (pb) {
      const step = tagText(pb, "step") ?? "", octave = tagNum(pb, "octave"), explicit = tagNum(pb, "alter");
      if (step in SEMI && octave != null) {
        const key = step + octave;
        let alter: number;
        if (explicit != null) { alter = Math.round(explicit); memory.set(key, alter); }
        else if (accidental != null && accidental in ACC_ALTER) { alter = ACC_ALTER[accidental]; memory.set(key, alter); }
        else alter = memory.get(key) ?? keyAlter(raw.fifths, step);
        pitch = { step, alter, octave };
      }
    }
    const chord = /<chord\s*\/>/.test(b);
    notes.push({
      index: notes.length, start, end: start + b.length,
      rest: /<rest(?=[\s/>])/.test(b), chord, grace: /<grace(?=[\s/>])/.test(b), unpitched: /<unpitched(?=[\s/>])/.test(b),
      pitch, midi: pitch ? pitchMidi(pitch) : null, accidental,
      tieStart: /<tie\s+type="start"/.test(b), tieStop: /<tie\s+type="stop"/.test(b),
      duration: tagNum(b, "duration"), type: tagText(b, "type"), dots: (b.match(/<dot(?:\s[^>]*)?\/>/g) ?? []).length,
      staff: tagText(b, "staff") ?? "1", voice: tagText(b, "voice") ?? "1", chordSize: 1,
    });
  }
  for (let i = 0; i < notes.length;) {
    let j = i + 1;
    while (j < notes.length && notes[j].chord) j++;
    for (let k = i; k < j; k++) notes[k].chordSize = j - i;
    i = j;
  }
  const expected = raw.beats && raw.beatType ? raw.beats * 4 / raw.beatType : null;
  return { partIndex, partId, start: raw.start, end: raw.end, notes, fifths: raw.fifths, divisions: raw.divisions,
    length: measureLength(block, raw.divisions), expected };
}

export function readMeasure(xml: string, index: number): EditMeasure | null {
  const parts = scan(xml);
  const first = parts[0]?.measures[index];
  if (!first) return null;
  return { index, number: first.number, parts: parts.flatMap((p, pi) => p.measures[index] ? [readPart(xml, p.measures[index], pi, p.id)] : []) };
}

/** Measures whose notes do not add up to the time signature (a pickup or short last bar is fine). */
export function lengthIssues(xml: string): LengthIssue[] {
  const out = new Map<number, LengthIssue>();
  scan(xml).forEach((p, pi) => p.measures.forEach((m, i) => {
    if (out.has(i) || m.implicit || !m.beats || !m.beatType) return;
    const expected = m.beats * 4 / m.beatType, actual = readPart(xml, m, pi, p.id).length;
    if (Math.abs(actual - expected) < 1e-6) return;
    if (actual < expected && (i === 0 || i === p.measures.length - 1)) return;
    out.set(i, { index: i, number: m.number, actual, expected });
  }));
  return [...out.values()].sort((a, b) => a.index - b.index);
}

function partOf(xml: string, mi: number, pi: number): EditPart {
  const part = readMeasure(xml, mi)?.parts.find((p) => p.partIndex === pi);
  if (!part) throw new Error(`no measure ${mi + 1} in part ${pi + 1}`);
  return part;
}
function noteOf(xml: string, mi: number, pi: number, ni: number): { part: EditPart; note: EditNote } {
  const part = partOf(xml, mi, pi), note = part.notes[ni];
  if (!note) throw new Error(`no note ${ni + 1} in measure ${mi + 1}`);
  return { part, note };
}
const splice = (xml: string, start: number, end: number, text: string) => xml.slice(0, start) + text + xml.slice(end);

/** Alter a pitch on this step+octave would get from the key and earlier accidentals in the measure. */
function contextAlter(xml: string, part: EditPart, ni: number, step: string, octave: number): number {
  let alter = keyAlter(part.fifths, step);
  for (const n of part.notes.slice(0, ni)) {
    if (!n.pitch || n.pitch.step !== step || n.pitch.octave !== octave) continue;
    const b = xml.slice(n.start, n.end);
    if (/<alter>/.test(b) || (n.accidental != null && n.accidental in ACC_ALTER)) alter = n.pitch.alter;
  }
  return alter;
}

/** The alter a note would take on this step+octave with no accidental of its own (key + earlier signs). */
export function impliedAlter(xml: string, mi: number, pi: number, ni: number, step: string, octave: number): number {
  return contextAlter(xml, partOf(xml, mi, pi), ni, step, octave);
}

function setAccidental(block: string, name: string | null): string {
  block = block.replace(/\s*<accidental(?:\s[^>]*)?>[^<]*<\/accidental>/, "");
  if (!name) return block;
  const anchors = [/<\/type>|<dot(?:\s[^>]*)?\/>/g, /<\/voice>/g, /<\/duration>/g, /<\/pitch>/g];
  for (const re of anchors) {
    const hits = [...block.matchAll(re)];
    const last = hits.at(-1);
    if (last) { const at = (last.index ?? 0) + last[0].length; return block.slice(0, at) + `<accidental>${name}</accidental>` + block.slice(at); }
  }
  return block;
}
const pitchXml = (p: Pitch) => `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch>`;

function checkPitch(p: Pitch) {
  if (!(p.step in SEMI) || ![-2, -1, 0, 1, 2].includes(p.alter) || !Number.isInteger(p.octave) || p.octave < 0 || p.octave > 9)
    throw new Error("invalid pitch");
}

function writePitch(xml: string, mi: number, pi: number, ni: number, p: Pitch): string {
  const { part, note } = noteOf(xml, mi, pi, ni);
  const ctx = contextAlter(xml, part, ni, p.step, p.octave);
  let block = xml.slice(note.start, note.end).replace(/<pitch>[\s\S]*?<\/pitch>/, pitchXml(p));
  block = setAccidental(block, p.alter !== ctx ? ACC_NAME[p.alter] : null);
  return splice(xml, note.start, note.end, block);
}

type Loc = { mi: number; ni: number };
/** The tied partner before (-1) or after (+1): same part, staff and voice, same sounding pitch. */
function tiePartner(xml: string, mi: number, pi: number, ni: number, dir: 1 | -1): Loc | null {
  const { note } = noteOf(xml, mi, pi, ni);
  if (note.midi == null || (dir === 1 ? !note.tieStart : !note.tieStop)) return null;
  for (let m = mi; m >= 0 && Math.abs(m - mi) <= 1; m += dir) {
    let notes: EditNote[];
    try { notes = partOf(xml, m, pi).notes; } catch { return null; }
    const order = dir === 1 ? notes.filter((n) => m !== mi || n.index > ni) : notes.filter((n) => m !== mi || n.index < ni).reverse();
    const hit = order.find((n) => n.midi === note.midi && n.staff === note.staff && n.voice === note.voice && (dir === 1 ? n.tieStop : n.tieStart));
    if (hit) return { mi: m, ni: hit.index };
  }
  return null;
}
function tieChain(xml: string, mi: number, pi: number, ni: number): Loc[] {
  const chain: Loc[] = [{ mi, ni }];
  for (const dir of [1, -1] as const) {
    let at: Loc | null = { mi, ni };
    while ((at = tiePartner(xml, at.mi, pi, at.ni, dir)) && chain.length < 64) chain.push(at);
  }
  return chain;
}

/** New sounding pitch for a note (and for the notes tied to it). */
export function setNotePitch(xml: string, mi: number, pi: number, ni: number, p: Pitch): string {
  checkPitch(p);
  const { note } = noteOf(xml, mi, pi, ni);
  if (!note.pitch) throw new Error("not a pitched note");
  for (const at of tieChain(xml, mi, pi, ni)) xml = writePitch(xml, at.mi, pi, at.ni, p);
  return xml;
}

const stripTies = (block: string, which: "start" | "stop" | "any") => {
  const t = which === "any" ? '[^"]*' : which;
  return block.replace(new RegExp(`\\s*<tie\\s+type="${t}"\\s*/>`, "g"), "")
    .replace(new RegExp(`\\s*<tied\\s+type="${t}"[^>]*/>`, "g"), "")
    .replace(/\s*<notations>\s*<\/notations>/g, "");
};

/** Turn a single note (not a chord tone or grace note) into a rest of the same length. */
export function noteToRest(xml: string, mi: number, pi: number, ni: number): string {
  const { note } = noteOf(xml, mi, pi, ni);
  if (!note.pitch || note.chordSize > 1 || note.grace) throw new Error("only a single note can become a rest");
  const next = tiePartner(xml, mi, pi, ni, 1), prev = tiePartner(xml, mi, pi, ni, -1);
  let block = xml.slice(note.start, note.end).replace(/<pitch>[\s\S]*?<\/pitch>/, "<rest/>");
  block = stripTies(setAccidental(block, null), "any").replace(/\s*<stem(?:\s[^>]*)?>[^<]*<\/stem>/, "");
  xml = splice(xml, note.start, note.end, block);
  for (const [loc, side] of [[next, "stop"], [prev, "start"]] as const) {
    if (!loc) continue;
    const n = noteOf(xml, loc.mi, pi, loc.ni).note;
    xml = splice(xml, n.start, n.end, stripTies(xml.slice(n.start, n.end), side));
  }
  return xml;
}

/** Turn a rest into a note of the same length. */
export function restToNote(xml: string, mi: number, pi: number, ni: number, p: Pitch): string {
  checkPitch(p);
  const { part, note } = noteOf(xml, mi, pi, ni);
  if (!note.rest) throw new Error("not a rest");
  let block = xml.slice(note.start, note.end).replace(/<rest(?:\s[^>]*)?\/>|<rest(?:\s[^>]*)?>[\s\S]*?<\/rest>/, pitchXml({ ...p, alter: 0 }));
  if (!note.type) {
    const q = (note.duration ?? 0) / part.divisions;
    const hit = TYPES.find(([len]) => Math.abs(len - q) < 1e-6);
    if (!hit) throw new Error("this rest has no simple note value");
    const type = `<type>${hit[1]}</type>${"<dot/>".repeat(hit[2])}`;
    const anchor = [...block.matchAll(/<\/voice>|<\/duration>/g)].at(-1);
    const at = anchor ? (anchor.index ?? 0) + anchor[0].length : block.indexOf(">") + 1;
    block = block.slice(0, at) + type + block.slice(at);
  }
  return writePitch(splice(xml, note.start, note.end, block), mi, pi, ni, p);
}

/** Add a note sounding with this one (a third above the chord's top note). Returns the new note's index too. */
export function addChordTone(xml: string, mi: number, pi: number, ni: number): { xml: string; index: number } {
  const { part, note } = noteOf(xml, mi, pi, ni);
  if (!note.pitch) throw new Error("not a pitched note");
  let head = ni;
  while (head > 0 && part.notes[head].chord) head--;
  const group = part.notes.slice(head, head + note.chordSize);
  const top = group.reduce((a, b) => ((b.midi ?? -1) > (a.midi ?? -1) ? b : a));
  const si = STEPS.indexOf(top.pitch!.step) + 2;
  const step = STEPS[si % 7], octave = top.pitch!.octave + (si >= 7 ? 1 : 0);
  let block = xml.slice(group[0].start, group[0].end).replace(/<chord\s*\/>/, "");
  block = stripTies(setAccidental(block, null), "any")
    .replace(/\s*<notations>[\s\S]*?<\/notations>/g, "").replace(/\s*<lyric(?:\s[^>]*)?>[\s\S]*?<\/lyric>/g, "")
    .replace(/<pitch>[\s\S]*?<\/pitch>/, `<chord/>${pitchXml({ step, alter: 0, octave })}`);
  const last = group.at(-1)!, index = last.index + 1;
  xml = splice(xml, last.end, last.end, block);
  const fresh = partOf(xml, mi, pi);
  return { xml: writePitch(xml, mi, pi, index, { step, octave, alter: contextAlter(xml, fresh, index, step, octave) }), index };
}

/** Remove one tone of a chord; the chord keeps its rhythm and the remaining tones. */
export function deleteChordTone(xml: string, mi: number, pi: number, ni: number): string {
  const { part, note } = noteOf(xml, mi, pi, ni);
  if (note.chordSize < 2) throw new Error("only a chord tone can be deleted");
  let target = note;
  if (!note.chord) {
    // The head carries the chord's timing, beams and marks: move the next tone's pitch into it.
    const member = part.notes[ni + 1], mb = xml.slice(member.start, member.end);
    const pitch = /<pitch>[\s\S]*?<\/pitch>/.exec(mb)![0];
    let block = stripTies(xml.slice(note.start, note.end), "any").replace(/<pitch>[\s\S]*?<\/pitch>/, pitch);
    block = setAccidental(block, member.accidental);
    xml = splice(xml, note.start, note.end, block);
    target = noteOf(xml, mi, pi, ni + 1).note;
  }
  const lead = /\s*$/.exec(xml.slice(0, target.start))![0].length;
  return splice(xml, target.start - lead, target.end, "");
}

export function measureXml(xml: string, mi: number, pi: number): string {
  const part = partOf(xml, mi, pi);
  return xml.slice(part.start, part.end);
}

/** Replace one measure's XML; the caller checks the whole document still parses. */
export function replaceMeasureXml(xml: string, mi: number, pi: number, block: string): string {
  const text = block.trim();
  if (!/^<measure(?=[\s>])[\s\S]*<\/measure>$/.test(text) || (text.match(/<measure(?=[\s>])/g) ?? []).length !== 1
    || (text.match(/<\/measure>/g) ?? []).length !== 1 || /<\/?part(?=[\s>])/.test(text))
    throw new Error("must be exactly one <measure>…</measure>");
  const part = partOf(xml, mi, pi);
  const out = splice(xml, part.start, part.end, text);
  if (measureCount(out) !== measureCount(xml)) throw new Error("measure count changed");
  return out;
}
