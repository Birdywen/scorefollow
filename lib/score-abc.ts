/** Edit one voice of one measure as a line of ABC notation (L:1/8), then write it back into the MusicXML.
 *
 * Rhythm is what OMR gets wrong most (an omitted rest in a second voice, a lost triplet mark), and it
 * is easy to fix as text: `x C,2 z [CEG]2 (3cde`. Only that voice's run of notes is rebuilt. Notes that
 * come back unchanged keep their XML byte for byte (beams, slurs, marks); a changed note keeps
 * everything the line does not describe. The other voices keep their onsets: the <backup>/<forward>
 * around the run absorb any change in length.
 *
 * Pitches follow ABC: C = middle C, c = an octave up, C, = an octave down; ^ sharp, _ flat, = natural.
 * A note without a sign takes the key signature or an earlier sign on the same note in this line. */
import { readMeasure, type EditNote } from "./score-edit";

export class AbcError extends Error {
  constructor(public zh: string, public en: string, public at = -1) { super(en); }
}
export type AbcVoice = {
  voice: string; staff: string; text: string; editable: boolean;
  reason: { zh: string; en: string } | null;
  /** Quarter notes the time signature asks for (null when unknown). */
  expected: number | null;
};

/* ---- fractions ---- */
type Q = [number, number];
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
const q = (n: number, d = 1): Q => {
  if (d < 0) { n = -n; d = -d; }
  const k = gcd(n, d) || 1;
  return [n / k, d / k];
};
const qadd = (a: Q, b: Q) => q(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const qmul = (a: Q, b: Q) => q(a[0] * b[0], a[1] * b[1]);
const qeq = (a: Q, b: Q) => a[0] === b[0] && a[1] === b[1];
const qsum = (xs: Q[]) => xs.reduce(qadd, q(0));

/* ---- note values ---- */
const BASES: Array<[string, Q]> = [["breve", q(8)], ["whole", q(4)], ["half", q(2)], ["quarter", q(1)], ["eighth", q(1, 2)],
  ["16th", q(1, 4)], ["32nd", q(1, 8)], ["64th", q(1, 16)], ["128th", q(1, 32)]];
const dotted = (base: Q, dots: number) => qmul(base, q(2 ** (dots + 1) - 1, 2 ** dots));
function typeOf(w: Q): [string, number] | null {
  for (const [name, base] of BASES) for (let d = 0; d <= 3; d++) if (qeq(dotted(base, d), w)) return [name, d];
  return null;
}
function writtenOf(type: string | null, dots: number): Q | null {
  const base = BASES.find(([n]) => n === type)?.[1];
  return base ? dotted(base, dots) : null;
}
const LONG = new Set(["breve", "whole", "half", "quarter"]);
const defaultQ = (p: number) => (p === 2 || p === 4 ? 3 : 2);

/* ---- items: one line of ABC ---- */
type Head = { step: string; octave: number; alter: number; mark: number | null; tie: boolean };
type Sub = { heads: Head[]; len: Q };
type Tup = { p: number; q: number; r: number; pos: number };
type Item =
  | { kind: "x"; len: Q } // sounding quarters
  | { kind: "g"; subs: Sub[] } // grace notes; len written
  | { kind: "n" | "z"; heads: Head[]; len: Q; tup: Tup | null }; // len written

const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midiOf = (h: { step: string; octave: number; alter: number }) => 12 * (h.octave + 1) + SEMI[h.step] + h.alter;
const keyAlter = (fifths: number, step: string) =>
  fifths > 0 && "FCGDAEB".slice(0, fifths).includes(step) ? 1 : fifths < 0 && "BEADGCF".slice(0, -fifths).includes(step) ? -1 : 0;
const sounding = (it: Item): Q => it.kind === "x" ? it.len : it.kind === "g" ? q(0) : it.tup ? qmul(it.len, q(it.tup.q, it.tup.p)) : it.len;
const MARK: Record<number, string> = { 2: "^^", 1: "^", 0: "=", [-1]: "_", [-2]: "__" };
const ACC_NAME: Record<number, string> = { [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };

function fmtLen(w: Q): string { // w in quarters; L = 1/8
  const [n, d] = qmul(w, q(2));
  if (n === 1 && d === 1) return "";
  if (d === 1) return String(n);
  if (n === 1) return d === 2 ? "/" : `/${d}`;
  return `${n}/${d}`;
}
function fmtPitch(h: Head): string {
  const letter = h.octave >= 5 ? h.step.toLowerCase() : h.step;
  const marks = h.octave >= 5 ? "'".repeat(h.octave - 5) : ",".repeat(4 - h.octave);
  return (h.mark != null ? MARK[h.mark] : "") + letter + marks;
}
function fmtHeads(heads: Head[], len: Q, tieAfter: boolean): string {
  if (heads.length === 1) return fmtPitch(heads[0]) + fmtLen(len) + (tieAfter && heads[0].tie ? "-" : "");
  const all = heads.every((h) => h.tie);
  return "[" + heads.map((h) => fmtPitch(h) + (h.tie && !all ? "-" : "")).join("") + "]" + fmtLen(len) + (all && tieAfter ? "-" : "");
}
function fmtItems(items: Item[]): string {
  return items.map((it) => {
    if (it.kind === "x") return "x" + fmtLen(it.len);
    if (it.kind === "g") return "{" + it.subs.map((s) => fmtHeads(s.heads, s.len, false)).join("") + "}";
    let pre = "";
    if (it.tup && it.tup.pos === 0) {
      const { p, q: qq, r } = it.tup;
      pre = qq === defaultQ(p) && r === p ? `(${p}` : r === p ? `(${p}:${qq}` : `(${p}:${qq}:${r}`;
    }
    return pre + (it.kind === "z" ? "z" + fmtLen(it.len) : fmtHeads(it.heads, it.len, true));
  }).join(" ");
}

/* ---- parsing a line ---- */
function parseLine(text: string, fifths: number): Item[] {
  const items: Item[] = [];
  const mem = new Map<string, number>();
  let i = 0, tup: { p: number; q: number; r: number; n: number; at: number } | null = null;
  const err = (zh: string, en: string, at = i): never => { throw new AbcError(`第 ${at + 1} 个字符：${zh}`, `At character ${at + 1}: ${en}`, at); };
  const len = (): Q => {
    const m = /^(\d*)(\/*)(\d*)/.exec(text.slice(i))!;
    i += m[0].length;
    if (!m[0]) return q(1, 2);
    const num = m[1] ? Number(m[1]) : 1;
    let den = 1;
    if (m[2].length) den = m[3] ? (m[2].length === 1 ? Number(m[3]) : NaN) : 2 ** m[2].length;
    else if (m[3]) den = NaN;
    if (!(num > 0) || !(den > 0) || !Number.isInteger(num) || !Number.isInteger(den)) err("时值写法不对", "bad note length", i - m[0].length);
    return qmul(q(num, den), q(1, 2));
  };
  const head = (): Head => {
    const at = i;
    const m = /^(\^\^|\^|__|_|=)?([A-Ga-g])([',]*)/.exec(text.slice(i));
    if (!m) return err("这里应该是音符", "expected a note");
    i += m[0].length;
    const mark = m[1] ? { "^^": 2, "^": 1, "=": 0, _: -1, __: -2 }[m[1]]! : null;
    const step = m[2].toUpperCase();
    let octave = m[2] === step ? 4 : 5;
    for (const c of m[3]) octave += c === "'" ? 1 : -1;
    if (octave < 0 || octave > 9) err("八度超出范围", "octave out of range", at);
    const key = step + octave;
    let alter: number;
    if (mark != null) { alter = mark; mem.set(key, mark); } else alter = mem.get(key) ?? keyAlter(fifths, step);
    const tie = text[i] === "-" ? (i++, true) : false;
    return { step, octave, alter, mark, tie };
  };
  const chord = (): Head[] => {
    const heads: Head[] = [];
    i++; // [
    for (;;) {
      while (text[i] === " ") i++;
      if (text[i] === "]") { i++; break; }
      if (i >= text.length) err("和弦缺少 ]", "chord is missing ]");
      heads.push(head());
      if (/^[\d/]/.test(text.slice(i))) err("和弦里的时值要写在 ] 后面", "write the chord's length after ]");
    }
    if (!heads.length) err("空和弦", "empty chord");
    return heads;
  };
  const one = (): { heads: Head[]; len: Q } => {
    if (text[i] === "[") {
      const heads = chord(), l = len();
      if (text[i] === "-") { i++; heads.forEach((h) => (h.tie = true)); }
      return { heads, len: l };
    }
    const at = i;
    const m = /^(\^\^|\^|__|_|=)?([A-Ga-g])([',]*)/.exec(text.slice(i));
    if (!m) return err("这里应该是音符", "expected a note");
    i += m[0].length;
    const l = len();
    const tie = text[i] === "-" ? (i++, true) : false;
    const saved = i;
    i = at; // re-read the pitch through head() so accidentals carry
    const h = head();
    i = saved;
    h.tie = tie;
    return { heads: [h], len: l };
  };
  const counted = () => {
    if (!tup) return null;
    const t: Tup = { p: tup.p, q: tup.q, r: tup.r, pos: tup.n++ };
    if (tup.n === tup.r) tup = null;
    return t;
  };
  while (i < text.length) {
    const c = text[i];
    if (/[\s|`]/.test(c)) { i++; continue; }
    if (c === "(") {
      if (tup) err("连音组还没结束", "the previous tuplet is not finished");
      const m = /^\((\d+)(?::(\d*))?(?::(\d*))?/.exec(text.slice(i));
      if (!m) err("连音写法不对，如 (3abc", "bad tuplet, e.g. (3abc");
      const p = Number(m![1]), qq = m![2] ? Number(m![2]) : defaultQ(p), r = m![3] ? Number(m![3]) : p;
      if (!(p >= 2 && p <= 16 && qq >= 1 && qq <= 16 && r >= 1 && r <= 32)) err("连音数字超出范围", "tuplet numbers out of range");
      tup = { p, q: qq, r, n: 0, at: i };
      i += m![0].length;
      continue;
    }
    if (c === "{") {
      const at = i;
      i++;
      const subs: Sub[] = [];
      for (;;) {
        while (text[i] === " ") i++;
        if (text[i] === "}") { i++; break; }
        if (i >= text.length) err("倚音缺少 }", "grace notes are missing }", at);
        subs.push(one());
      }
      if (!subs.length) err("空的倚音 {}", "empty grace group", at);
      items.push({ kind: "g", subs });
      continue;
    }
    if (c === "z" || c === "x") {
      i++;
      const l = len();
      if (c === "x") {
        if (tup) err("连音组里不能用 x", "x cannot be inside a tuplet", i - 1);
        items.push({ kind: "x", len: l });
      } else items.push({ kind: "z", heads: [], len: l, tup: counted() });
      continue;
    }
    if (c === "[" || /[\^_=A-Ga-g]/.test(c)) {
      const { heads, len: l } = one();
      items.push({ kind: "n", heads, len: l, tup: counted() });
      continue;
    }
    if (c === "Z") err("请用 z 加时值写整小节休止，如 z8", "write a whole-bar rest as z plus its length, e.g. z8");
    if (c === ">" || c === "<") err("不支持 > <，请直接写附点时值，如 c3/2 d/", "> and < are not supported; write dotted lengths, e.g. c3/2 d/");
    err(`看不懂 "${c}"`, `unexpected "${c}"`);
  }
  if (tup) err(`连音组需要 ${tup.r} 个音`, `the tuplet needs ${tup.r} notes`, tup.at);
  return items;
}

/** Quarter notes a line lasts (throws AbcError on a syntax error). */
export function abcLength(text: string): number {
  const [n, d] = qsum(parseLine(text, 0).map(sounding));
  return n / d;
}

/* ---- XML children ---- */
type Kid = { tag: string; start: number; end: number; text: string };
function children(block: string): { open: string; kids: Kid[]; closeAt: number } {
  const openEnd = block.indexOf(">") + 1, closeAt = block.lastIndexOf("</");
  const kids: Kid[] = [];
  let i = openEnd;
  while (i < closeAt) {
    const lt = block.indexOf("<", i);
    if (lt < 0 || lt >= closeAt) break;
    if (block.startsWith("<!--", lt)) { const e = block.indexOf("-->", lt) + 3; kids.push({ tag: "#comment", start: lt, end: e, text: block.slice(lt, e) }); i = e; continue; }
    if (block.startsWith("<?", lt)) { const e = block.indexOf("?>", lt) + 2; kids.push({ tag: "#pi", start: lt, end: e, text: block.slice(lt, e) }); i = e; continue; }
    const tag = /^<([\w.:-]+)/.exec(block.slice(lt))![1];
    const gt = block.indexOf(">", lt);
    let end: number;
    if (block[gt - 1] === "/") end = gt + 1;
    else {
      const re = new RegExp(`<(/?)${tag.replace(/[.]/g, "\\.")}(?=[\\s/>])[^>]*?(/?)>`, "g");
      re.lastIndex = gt + 1;
      let depth = 1, m: RegExpExecArray | null;
      end = closeAt;
      while ((m = re.exec(block))) {
        if (m[1]) depth--; else if (!m[2]) depth++;
        if (!depth) { end = m.index + m[0].length; break; }
      }
    }
    kids.push({ tag, start: lt, end, text: block.slice(lt, end) });
    i = end;
  }
  return { open: block.slice(0, openEnd), kids, closeAt };
}
const tagText = (block: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(block);
  return m ? m[1].trim() : null;
};
const tagNum = (block: string, tag: string) => { const t = tagText(block, tag); const n = t ? Number(t) : NaN; return Number.isFinite(n) ? n : null; };
const isGrace = (b: string) => /<grace(?=[\s/>])/.test(b);
const isChord = (b: string) => /<chord\s*\/>/.test(b);
const isRest = (b: string) => /<rest(?=[\s/>])/.test(b);
const tiesOf = (b: string) => ({ start: /<tie\s+type="start"/.test(b), stop: /<tie\s+type="stop"/.test(b) });
const tmOf = (b: string): [number, number] | null => {
  const a = tagNum(b, "actual-notes"), n = tagNum(b, "normal-notes");
  return a && n ? [a, n] : null;
};

/* ---- one voice's run in a measure ---- */
type OldItem = { item: Item; blocks: string[][]; staffs: string[]; tieStops: boolean[]; hasAcc: boolean[] };
type Run = {
  mStart: number; voice: string; staff: string; fifths: number; divisions: number; expected: number | null;
  kids: Kid[]; timing: number[]; first: number; last: number; lead: Q; leadAbsorbs: boolean;
  preBackup: number | null; next: number | null; startPos: number; endPos: number;
  items: OldItem[]; anchors: Array<{ before: number; text: string }>; notes: EditNote[];
};

const ORDER = ["grace", "cue", "chord", "pitch", "rest", "unpitched", "duration", "tie", "instrument", "footnote", "level", "voice",
  "type", "dot", "accidental", "time-modification", "stem", "notehead", "notehead-text", "staff", "beam", "notations", "lyric", "play", "listen"];

function locate(xml: string, mi: number, pi: number, voice: string): Run | { reason: { zh: string; en: string } } {
  const part = readMeasure(xml, mi)?.parts.find((p) => p.partIndex === pi);
  if (!part) throw new Error(`no measure ${mi + 1} in part ${pi + 1}`);
  const block = xml.slice(part.start, part.end);
  const { kids } = children(block);
  const byStart = new Map(part.notes.map((n) => [n.start - part.start, n]));
  const timing = kids.flatMap((k, ki) => (k.tag === "note" || k.tag === "backup" || k.tag === "forward" ? [ki] : []));
  const vOf = (k: Kid) => k.tag === "note" ? (tagText(k.text, "voice") ?? "1") : k.tag === "forward" ? tagText(k.text, "voice") : null;
  const mine = timing.map((ki) => vOf(kids[ki]) === voice && (kids[ki].tag === "note" || kids[ki].tag === "forward"));
  timing.forEach((ki, t) => { // a forward with no voice goes with the notes next to it
    const k = kids[ki];
    if (k.tag === "forward" && vOf(k) == null) {
      const nb = [timing[t - 1], timing[t + 1]].filter((x) => x != null).map((x) => kids[x]);
      if (nb.some((n) => n.tag === "note" && vOf(n) === voice)) mine[t] = true;
    }
  });
  const ts = mine.flatMap((m, t) => (m ? [t] : []));
  const no = (zh: string, en: string) => ({ reason: { zh, en } });
  if (!ts.some((t) => kids[timing[t]].tag === "note")) return no("本小节没有这个声部", "this voice has no notes in this measure");
  if (ts.at(-1)! - ts[0] + 1 !== ts.length) return no("这个声部和其他声部交错书写，请用下方 XML 修改", "this voice is interleaved with other voices; use the XML below");
  let pos = 0;
  const posBefore: number[] = [];
  for (const ki of timing) {
    posBefore.push(pos);
    const k = kids[ki], d = tagNum(k.text, "duration") ?? 0;
    if (k.tag === "backup") pos -= d;
    else if (k.tag === "forward") pos += d;
    else if (!isGrace(k.text) && !isChord(k.text)) pos += d;
  }
  const t0 = ts[0], t1 = ts.at(-1)!;
  if (posBefore[t0] < 0) return no("这个声部从小节开始之前起（<backup> 有误），请用 XML 修改", "this voice starts before the bar (a bad <backup>); use the XML");
  const div = part.divisions;
  const preBackup = t0 > 0 && kids[timing[t0 - 1]].tag === "backup" ? timing[t0 - 1] : null;
  const run: Run = {
    mStart: part.start, voice, staff: "1", fifths: part.fifths, divisions: div, expected: part.expected, kids, timing,
    first: timing[t0], last: timing[t1], lead: q(0), leadAbsorbs: preBackup != null || posBefore[t0] === 0, preBackup,
    next: t1 + 1 < timing.length ? timing[t1 + 1] : null, startPos: posBefore[t0],
    endPos: t1 + 1 < timing.length ? posBefore[t1 + 1] : pos, items: [], anchors: [], notes: part.notes,
  };
  if (run.leadAbsorbs) run.lead = q(posBefore[t0], div);
  const staffs = new Map<string, number>();
  const mem = new Map<string, number>();
  const markOf = (n: EditNote, hasAcc: boolean): Head => {
    const p = n.pitch!, key = p.step + p.octave, implied = mem.get(key) ?? keyAlter(part.fifths, p.step);
    const show = hasAcc || p.alter !== implied;
    if (show) mem.set(key, p.alter);
    return { step: p.step, octave: p.octave, alter: p.alter, mark: show ? p.alter : null, tie: n.tieStart };
  };
  let leading = run.leadAbsorbs;
  let open: OldItem | null = null; // the item chord tones / grace notes join
  for (let ki = run.first; ki <= run.last; ki++) {
    const k = kids[ki];
    if (k.tag !== "note" && k.tag !== "forward") {
      if (k.tag === "#comment" || k.tag === "#pi" || k.tag === "backup") continue;
      run.anchors.push({ before: run.items.length, text: k.text });
      continue;
    }
    if (k.tag === "forward") {
      const d = q(tagNum(k.text, "duration") ?? 0, div);
      open = null;
      if (leading) { run.lead = qadd(run.lead, d); continue; }
      run.items.push({ item: { kind: "x", len: d }, blocks: [[k.text]], staffs: [], tieStops: [], hasAcc: [] });
      continue;
    }
    leading = false;
    const n = byStart.get(k.start)!;
    if (/<cue\s*\/>|<cue>/.test(k.text)) return no("含提示音（cue），请用 XML 修改", "has cue notes; use the XML");
    if (n.unpitched) return no("含无音高音符，请用 XML 修改", "has unpitched notes; use the XML");
    staffs.set(n.staff, (staffs.get(n.staff) ?? 0) + 1);
    const hasAcc = n.accidental != null;
    if (n.grace) {
      const len = writtenOf(n.type, n.dots) ?? q(1, 2);
      if (!n.pitch) return no("倚音是休止符，请用 XML 修改", "a grace rest; use the XML");
      if (open?.item.kind === "g" && n.chord) {
        const sub = (open.item as { subs: Sub[] }).subs.at(-1)!;
        sub.heads.push(markOf(n, hasAcc));
        open.blocks.at(-1)!.push(k.text);
      } else if (open?.item.kind === "g") {
        (open.item as { subs: Sub[] }).subs.push({ heads: [markOf(n, hasAcc)], len });
        open.blocks.push([k.text]);
      } else {
        open = { item: { kind: "g", subs: [{ heads: [markOf(n, hasAcc)], len }] }, blocks: [[k.text]], staffs: [], tieStops: [], hasAcc: [] };
        run.items.push(open);
      }
      open.staffs.push(n.staff);
      open.hasAcc.push(hasAcc);
      continue;
    }
    if (n.chord) {
      if (!open || open.item.kind !== "n" || !n.pitch) return no("和弦写法异常，请用 XML 修改", "unusual chord; use the XML");
      open.item.heads.push(markOf(n, hasAcc));
      open.blocks[0].push(k.text);
      open.staffs.push(n.staff); open.tieStops.push(n.tieStop); open.hasAcc.push(hasAcc);
      continue;
    }
    const tm = tmOf(k.text), snd = q(n.duration ?? 0, div);
    const len = tm ? qmul(snd, q(tm[0], tm[1])) : snd;
    const tup: Tup | null = tm ? { p: tm[0], q: tm[1], r: 1, pos: 0 } : null;
    open = {
      item: n.rest ? { kind: "z", heads: [], len, tup } : { kind: "n", heads: [markOf(n, hasAcc)], len, tup },
      blocks: [[k.text]], staffs: [n.staff], tieStops: [n.tieStop], hasAcc: [hasAcc],
    };
    run.items.push(open);
  }
  groupTuplets(run.items.map((o) => o.item), run.items.map((o) => o.blocks[0]?.[0] ?? ""));
  run.staff = [...staffs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1";
  return run;
}

/** Number tuplet groups: explicit <tuplet type="start"> marks win, else groups of p notes. */
function groupTuplets(items: Item[], heads: string[]) {
  let group: Array<{ tup: Tup }> = [];
  const close = () => { group.forEach((it, k) => { it.tup.r = group.length; it.tup.pos = k; }); group = []; };
  items.forEach((it, k) => {
    if (it.kind === "g") return;
    if (it.kind === "x" || !it.tup) { close(); return; }
    const g0 = group[0]?.tup;
    const marked = /<tuplet(?=[\s>])[^>]*type="start"/.test(heads[k]);
    if (!g0 || g0.p !== it.tup.p || g0.q !== it.tup.q || marked || (!heads.some((h) => /<tuplet(?=[\s>])/.test(h)) && group.length >= g0.p)) close();
    group.push(it as { tup: Tup });
    if (/<tuplet(?=[\s>])[^>]*type="stop"/.test(heads[k])) close();
  });
  close();
}

function voicesIn(xml: string, mi: number, pi: number): string[] {
  const part = readMeasure(xml, mi)?.parts.find((p) => p.partIndex === pi);
  if (!part) return [];
  return [...new Set(part.notes.map((n) => n.voice))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/** Every voice of one measure (one part) as a line of ABC. */
export function measureAbc(xml: string, mi: number, pi: number): AbcVoice[] {
  return voicesIn(xml, mi, pi).map((voice) => {
    const run = locate(xml, mi, pi, voice);
    if ("reason" in run) {
      const part = readMeasure(xml, mi)!.parts.find((p) => p.partIndex === pi)!;
      return { voice, staff: part.notes.find((n) => n.voice === voice)?.staff ?? "1", text: "", editable: false, reason: run.reason, expected: part.expected };
    }
    return { voice, staff: run.staff, text: textOf(run), editable: true, reason: null, expected: run.expected };
  });
}
function textOf(run: Run): string {
  const items = run.items.map((o) => o.item);
  const lead: Item[] = run.lead[0] ? [{ kind: "x", len: run.lead }] : [];
  return fmtItems([...lead, ...items]);
}

/* ---- writing back ---- */
type NoteSpec = {
  grace: boolean; chord: boolean; head: Head | null; dur: number | null; voice: string; staff: string;
  type: [string, number] | null; tm: [number, number] | null; tieStart: boolean; tieStop: boolean;
  tuplet: "start" | "stop" | "both" | null; accidental: string | null | "keep"; alter0: boolean;
};
type Style = { ws: string; closeWs: string; stem: string | null };

function noteKids(block: string) {
  const { open, kids, closeAt } = children(block);
  const ws = kids.length ? block.slice(open.length, kids[0].start) : "";
  const closeWs = kids.length ? block.slice(kids.at(-1)!.end, closeAt) : "";
  return { open, kids: kids.map((k) => ({ tag: k.tag, text: k.text })), ws, closeWs };
}
function buildNote(tpl: string | null, own: boolean, s: NoteSpec, style: Style): string {
  const n = tpl ? noteKids(tpl) : { open: "<note>", kids: [] as Array<{ tag: string; text: string }>, ws: style.ws, closeWs: style.closeWs };
  if (!own) {
    n.open = "<note>";
    n.kids = n.kids.filter((k) => !["beam", "notations", "lyric", "accidental", "tie", "time-modification", "#comment"].includes(k.tag));
  }
  if (!n.ws && !n.kids.length) { n.ws = style.ws; n.closeWs = style.closeWs; }
  const rank = (tag: string) => { const r = ORDER.indexOf(tag); return r < 0 ? 999 : r; };
  const remove = (...tags: string[]) => { n.kids = n.kids.filter((k) => !tags.includes(k.tag)); };
  const put = (tag: string, text: string) => {
    const at = n.kids.findIndex((k) => k.tag === tag);
    if (at >= 0) { n.kids[at] = { tag, text }; return; }
    let idx = 0;
    n.kids.forEach((k, j) => { if (rank(k.tag) <= rank(tag)) idx = j + 1; });
    n.kids.splice(idx, 0, { tag, text });
  };
  const get = (tag: string) => n.kids.find((k) => k.tag === tag)?.text ?? null;
  if (s.grace) { if (!get("grace")) put("grace", "<grace/>"); } else remove("grace");
  if (s.chord) { if (!get("chord")) put("chord", "<chord/>"); } else remove("chord");
  if (s.head) {
    const h = s.head, old = get("pitch");
    const same = old && tagText(old, "step") === h.step && tagNum(old, "octave") === h.octave && (tagNum(old, "alter") ?? 0) === h.alter
      && (h.alter !== 0 || !s.alter0 || /<alter>/.test(old));
    remove("rest", "unpitched");
    if (!same) put("pitch", `<pitch><step>${h.step}</step>${h.alter || s.alter0 ? `<alter>${h.alter}</alter>` : ""}<octave>${h.octave}</octave></pitch>`);
    if (!get("stem") && style.stem && !s.grace) put("stem", style.stem);
  } else {
    remove("pitch", "unpitched", "stem", "accidental");
    const r = get("rest"), was = tagNum(get("duration") ?? "", "duration");
    if (!r || (/measure="yes"/.test(r) && was !== s.dur)) put("rest", "<rest/>"); // a whole-bar rest that no longer fills the bar
  }
  if (s.dur == null) remove("duration");
  else if (tagNum(get("duration") ?? "", "duration") !== s.dur) put("duration", `<duration>${s.dur}</duration>`);
  const ties = tiesOf(n.kids.filter((k) => k.tag === "tie").map((k) => k.text).join(""));
  const wantTies = s.head != null;
  if (ties.start !== (wantTies && s.tieStart) || ties.stop !== (wantTies && s.tieStop)) {
    remove("tie");
    if (wantTies && s.tieStop) put("tie", '<tie type="stop"/>');
    if (wantTies && s.tieStart) { const at = n.kids.findIndex((k) => k.tag === "tie"); const t = { tag: "tie", text: '<tie type="start"/>' }; if (at >= 0) n.kids.splice(at + 1, 0, t); else put("tie", t.text); }
    editNotations(n, (body) => {
      body = body.replace(/\s*<tied\s[^>]*\/>/g, "");
      return (wantTies && s.tieStop ? '<tied type="stop"/>' : "") + (wantTies && s.tieStart ? '<tied type="start"/>' : "") + body;
    }, put);
  }
  if (get("voice") == null || tagText(get("voice")!, "voice") !== s.voice) put("voice", `<voice>${s.voice}</voice>`);
  const curType = tagText(get("type") ?? "", "type"), curDots = n.kids.filter((k) => k.tag === "dot").length;
  if (s.type && (curType !== s.type[0] || curDots !== s.type[1])) {
    remove("type", "dot");
    put("type", `<type>${s.type[0]}</type>`);
    const at = n.kids.findIndex((k) => k.tag === "type");
    n.kids.splice(at + 1, 0, ...Array.from({ length: s.type[1] }, () => ({ tag: "dot", text: "<dot/>" })));
  } else if (!s.type) remove("type", "dot");
  if (s.head && s.accidental !== "keep") {
    if (s.accidental) put("accidental", `<accidental>${s.accidental}</accidental>`); else remove("accidental");
  }
  const tm = tmOf(get("time-modification") ?? "");
  if (!s.tm) remove("time-modification");
  else if (!tm || tm[0] !== s.tm[0] || tm[1] !== s.tm[1])
    put("time-modification", `<time-modification><actual-notes>${s.tm[0]}</actual-notes><normal-notes>${s.tm[1]}</normal-notes></time-modification>`);
  if (get("staff") == null || tagText(get("staff")!, "staff") !== s.staff) put("staff", `<staff>${s.staff}</staff>`);
  if (s.type && LONG.has(s.type[0])) remove("beam");
  if (!s.chord && !s.grace) {
    const cur = get("notations") ?? "";
    const has = { start: /<tuplet\s[^>]*type="start"/.test(cur), stop: /<tuplet\s[^>]*type="stop"/.test(cur) };
    const want = { start: s.tuplet === "start" || s.tuplet === "both", stop: s.tuplet === "stop" || s.tuplet === "both" };
    if (has.start !== want.start || has.stop !== want.stop) editNotations(n, (body) => {
      body = body.replace(/\s*<tuplet\s[^>]*\/>/g, "").replace(/\s*<tuplet(?=[\s>])[^>]*>[\s\S]*?<\/tuplet>/g, "");
      return body + (want.start ? '<tuplet type="start"/>' : "") + (want.stop ? '<tuplet type="stop"/>' : "");
    }, put);
  }
  return n.open + n.kids.map((k) => n.ws + k.text).join("") + n.closeWs + "</note>";
}
function editNotations(n: { kids: Array<{ tag: string; text: string }> }, f: (body: string) => string, put: (tag: string, text: string) => void) {
  const at = n.kids.findIndex((k) => k.tag === "notations");
  const cur = at >= 0 ? n.kids[at].text : "<notations></notations>";
  const m = /^(<notations(?:\s[^>]*)?>)([\s\S]*)<\/notations>$/.exec(cur);
  const openTag = m?.[1] ?? "<notations>", body = f(m?.[2] ?? "");
  if (!body.trim()) { if (at >= 0) n.kids.splice(at, 1); return; }
  put("notations", openTag + body + "</notations>");
}

function sig(it: Item): string {
  if (it.kind === "x") return "x";
  const heads = it.kind === "g" ? it.subs.flatMap((s) => s.heads) : it.heads;
  return it.kind + ":" + heads.map(midiOf).sort((a, b) => a - b).join(",");
}
const compatible = (a: Item, b: Item) => a.kind === b.kind || (a.kind !== "x" && a.kind !== "g" && b.kind !== "x" && b.kind !== "g");
/** Pair each new item with the old item it most likely is: an LCS on kind + pitches, then leftovers in order. */
function pairItems(olds: Item[], news: Item[]): Array<number | null> {
  const a = olds.map(sig), b = news.map(sig), L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pair: Array<number | null> = new Array(b.length).fill(null);
  const anchors: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { anchors.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  anchors.forEach(([i, j]) => (pair[j] = i));
  const bounds: Array<[number, number]> = [[-1, -1], ...anchors, [a.length, b.length]];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const oi = [], nj = [];
    for (let i = bounds[k][0] + 1; i < bounds[k + 1][0]; i++) oi.push(i);
    for (let j = bounds[k][1] + 1; j < bounds[k + 1][1]; j++) nj.push(j);
    for (const j of nj) {
      const at = oi.findIndex((i) => compatible(olds[i], news[j]));
      if (at >= 0) { pair[j] = oi[at]; oi.splice(0, at + 1); }
    }
  }
  return pair;
}

const headEq = (x: Head, y: Head) => x.step === y.step && x.octave === y.octave && x.alter === y.alter && x.mark === y.mark && x.tie === y.tie;
function sameItem(o: OldItem, it: Item, stops: boolean[]): boolean {
  const a = o.item;
  if (a.kind !== it.kind) return false;
  if (a.kind === "x") return qeq(a.len, (it as typeof a).len);
  if (a.kind === "g") {
    const b = it as typeof a;
    return a.subs.length === b.subs.length && a.subs.every((s, k) => qeq(s.len, b.subs[k].len) && s.heads.length === b.subs[k].heads.length
      && s.heads.every((h, j) => headEq({ ...h, tie: false }, { ...b.subs[k].heads[j], tie: false })));
  }
  const b = it as typeof a;
  const tupEq = (!a.tup && !b.tup) || (!!a.tup && !!b.tup && a.tup.p === b.tup.p && a.tup.q === b.tup.q && a.tup.r === b.tup.r && a.tup.pos === b.tup.pos);
  return qeq(a.len, b.len) && tupEq && a.heads.length === b.heads.length && a.heads.every((h, j) => headEq(h, b.heads[j]))
    && o.tieStops.every((t, j) => j >= stops.length || t === stops[j]) && (a.kind === "z" || o.tieStops.length === stops.length);
}

const lcm = (a: number, b: number) => a / gcd(a, b) * b;
const splice = (s: string, start: number, end: number, text: string) => s.slice(0, start) + text + s.slice(end);

/** Scale the divisions of one measure (one part) by k so finer values fit; the next measure keeps the old divisions. */
function rescale(xml: string, mi: number, pi: number, k: number): string {
  const part = readMeasure(xml, mi)!.parts.find((p) => p.partIndex === pi)!;
  const D = part.divisions;
  let block = xml.slice(part.start, part.end)
    .replace(/(<duration>\s*)(\d+)(\s*<\/duration>)/g, (_, a, n, b) => a + Number(n) * k + b)
    .replace(/(<offset(?:\s[^>]*)?>\s*)(-?\d+)(\s*<\/offset>)/g, (_, a, n, b) => a + Number(n) * k + b);
  block = /<divisions>/.test(block) ? block.replace(/<divisions>\s*\d+\s*<\/divisions>/, `<divisions>${D * k}</divisions>`) : withDivisions(block, D * k);
  const next = readMeasure(xml, mi + 1)?.parts.find((p) => p.partIndex === pi);
  if (next) {
    const nb = xml.slice(next.start, next.end);
    if (!/<divisions>/.test(nb)) xml = splice(xml, next.start, next.end, withDivisions(nb, D));
  }
  return splice(xml, part.start, part.end, block);
}
function withDivisions(block: string, d: number): string {
  const { kids } = children(block);
  const firstNote = kids.findIndex((k) => k.tag === "note" || k.tag === "backup" || k.tag === "forward");
  const attrs = kids.findIndex((k, j) => k.tag === "attributes" && (firstNote < 0 || j < firstNote));
  if (attrs >= 0) {
    const a = kids[attrs], at = a.start + a.text.indexOf(">") + 1;
    if (a.text.endsWith("/>")) return splice(block, a.start, a.end, `<attributes><divisions>${d}</divisions></attributes>`);
    return splice(block, at, at, `<divisions>${d}</divisions>`);
  }
  const after = kids[0]?.tag === "print" ? kids[0].end : block.indexOf(">") + 1;
  const ws = kids.length ? block.slice(block.indexOf(">") + 1, kids[0].start) : "";
  return splice(block, after, after, (kids[0]?.tag === "print" ? ws : "") + `<attributes><divisions>${d}</divisions></attributes>` + (kids[0]?.tag === "print" ? "" : ws));
}

/** Replace one voice of one measure with a line of ABC. opts.force skips the "nothing changed" shortcut;
 * opts.rebuild also rebuilds notes that did not change (for tests). */
export function applyAbc(xml: string, mi: number, pi: number, voice: string, text: string, opts: { force?: boolean; rebuild?: boolean } = {}): string {
  const run = locate(xml, mi, pi, voice);
  if ("reason" in run) throw new AbcError(run.reason.zh, run.reason.en);
  if (!opts.force && !opts.rebuild && text.trim() === textOf(run).trim()) return xml;
  let news = parseLine(text, run.fifths);
  // Durations must be whole divisions; refine the measure's divisions when they are not.
  let k = 1;
  for (const it of news) { const [n, d] = qmul(sounding(it), q(run.divisions)); if (n) k = lcm(k, d); }
  if (k > 1) {
    if (run.divisions * k > 100000) throw new AbcError("时值太细，无法表示", "note values too fine to represent");
    return applyAbc(rescale(xml, mi, pi, k), mi, pi, voice, text, { ...opts, force: true });
  }
  const div = run.divisions, kids = run.kids, base = run.mStart;
  // Leading hidden rests move the start of the voice when a <backup> sets it.
  let lead = q(0);
  if (run.leadAbsorbs) {
    while (news[0]?.kind === "x") { lead = qadd(lead, news[0].len); news = news.slice(1); }
  }
  const leadDiv = lead[0] * div / lead[1];
  const startPos = run.leadAbsorbs ? leadDiv : run.startPos;
  const olds = run.items;
  const pair = pairItems(olds.map((o) => o.item), news);
  // Tie stops: a note continues a tie from the note before it; the first note keeps an incoming tie.
  const firstNote = news.findIndex((it) => it.kind === "n" || it.kind === "z");
  const firstOld = olds.find((o) => o.item.kind === "n" || o.item.kind === "z");
  const incoming = new Set(firstOld && firstOld.item.kind === "n" ? firstOld.item.heads.filter((_, j) => firstOld.tieStops[j]).map(midiOf) : []);
  const stopsFor = (items: Item[], first: number) => {
    const out: boolean[][] = [];
    let prevTied = new Set<number>();
    items.forEach((it, j) => {
      if (it.kind === "g") { out.push([]); return; }
      if (it.kind === "x") { prevTied = new Set(); out.push([]); return; }
      const from = j === first ? incoming : prevTied;
      out.push(it.heads.map((h) => from.has(midiOf(h))));
      prevTied = new Set(it.heads.filter((h) => h.tie).map(midiOf));
    });
    return out;
  };
  const stops = stopsFor(news, firstNote);
  // Where the tie into a note is as before, keep the stops the score had (OMR's odd ties included):
  // the line cannot show them, so it must not change them.
  const oldStops = stopsFor(olds.map((o) => o.item), olds.findIndex((o) => o.item.kind === "n" || o.item.kind === "z"));
  news.forEach((it, j) => {
    const oi = pair[j], o = oi != null ? olds[oi] : null;
    if (!o || it.kind !== "n" || o.item.kind !== "n") return;
    const same = o.item.heads.length === it.heads.length && o.item.heads.every((h, k) => midiOf(h) === midiOf(it.heads[k]));
    if (same && oldStops[oi!].every((t, k) => t === stops[j][k])) stops[j] = o.tieStops.slice();
  });
  const anyOld = olds.flatMap((o) => o.blocks.flat()).find((b) => b.startsWith("<note")) ?? null;
  const someNote = anyOld ?? (run.notes[0] ? xml.slice(run.notes[0].start, run.notes[0].end) : null);
  const nk = someNote ? noteKids(someNote) : null;
  const stemSrc = olds.flatMap((o) => o.blocks.flat()).find((b) => b.startsWith("<note") && !isRest(b) && !isGrace(b) && /<stem/.test(b));
  const style: Style = { ws: nk?.ws ?? "", closeWs: nk?.closeWs ?? "", stem: stemSrc ? /<stem(?:\s[^>]*)?>[^<]*<\/stem>/.exec(stemSrc)![0] : null };
  // Accidentals in other voices of the measure: a natural here must say so explicitly.
  const altered = new Set(run.notes.filter((n) => n.pitch && n.pitch.alter !== 0).map((n) => n.staff + n.pitch!.step + n.pitch!.octave));
  const alter0 = (h: Head, staff: string) => h.alter === 0 && (keyAlter(run.fifths, h.step) !== 0 || altered.has(staff + h.step + h.octave));
  const accOf = (h: Head, tpl: string | null, own: boolean): string | null | "keep" => {
    if (own && tpl) {
      const p = /<pitch>[\s\S]*?<\/pitch>/.exec(tpl)?.[0];
      const samePitch = p && tagText(p, "step") === h.step && tagNum(p, "octave") === h.octave;
      if (samePitch && /<accidental/.test(tpl) === (h.mark != null) && (h.mark == null || tagText(tpl, "accidental") === ACC_NAME[h.mark])) return "keep";
    }
    return h.mark != null ? ACC_NAME[h.mark] : null;
  };
  const typeFor = (w: Q, tpl: string | null, rest: boolean): [string, number] | null => {
    const t = typeOf(w);
    if (t) return t;
    if (tpl) { const tt = tagText(tpl, "type"); const dots = (tpl.match(/<dot(?:\s[^>]*)?\/>/g) ?? []).length; const ww = writtenOf(tt, dots); if (ww && qeq(ww, w)) return [tt!, dots]; }
    if (rest) return null;
    const [n, d] = qmul(w, q(2));
    throw new AbcError(`时值 ${n}/${d} 不能用一个音符表示，请用连音线 - 拆开`, `length ${n}/${d} is not a single note value; split it with a tie -`);
  };
  const out: string[][] = news.map((it, j) => {
    const oi = pair[j], o = oi != null ? olds[oi] : null;
    if (o && !opts.rebuild && sameItem(o, it, stops[j])) return o.blocks.flat();
    if (it.kind === "x") {
      const d = it.len[0] * div / it.len[1];
      return [`<forward><duration>${d}</duration><voice>${voice}</voice><staff>${run.staff}</staff></forward>`];
    }
    if (it.kind === "g") {
      return it.subs.flatMap((s, si) => s.heads.map((h, hi) => {
        const own = o?.item.kind === "g" ? o.blocks[si]?.[hi] ?? null : null;
        const tpl = own ?? (o?.item.kind === "g" ? o.blocks[0][0] : null);
        const staff = (own && tagText(own, "staff")) || run.staff;
        return buildNote(tpl, own != null, {
          grace: true, chord: hi > 0, head: h, dur: null, voice, staff,
          type: typeFor(s.len, tpl, false), tm: null, tieStart: false, tieStop: false, tuplet: null,
          accidental: accOf(h, tpl, own != null), alter0: alter0(h, staff),
        }, style);
      }));
    }
    const snd = sounding(it), dur = snd[0] * div / snd[1];
    const tm: [number, number] | null = it.tup ? [it.tup.p, it.tup.q] : null;
    const tuplet = it.tup && it.tup.r > 1 ? (it.tup.pos === 0 ? "start" : it.tup.pos === it.tup.r - 1 ? "stop" : null) : null;
    const oldBlocks = o && (o.item.kind === "n" || o.item.kind === "z") ? o.blocks[0] : [];
    const oldHeads = o && o.item.kind === "n" ? o.item.heads : [];
    if (it.kind === "z") {
      const tpl = oldBlocks[0] ?? null;
      return [buildNote(tpl, tpl != null, {
        grace: false, chord: false, head: null, dur, voice, staff: (tpl && tagText(tpl, "staff")) || run.staff,
        type: typeFor(it.len, tpl, true), tm, tieStart: false, tieStop: false, tuplet, accidental: null, alter0: false,
      }, style)];
    }
    const used = new Set<number>();
    return it.heads.map((h, hi) => {
      let at = oldHeads.findIndex((oh, k) => !used.has(k) && midiOf(oh) === midiOf(h));
      if (at < 0) at = hi < oldBlocks.length && !used.has(hi) ? hi : -1;
      if (at >= 0) used.add(at);
      // Keep a block as the head (it carries beams and marks) only for the head; chord tones stay chord tones.
      const own = at >= 0 && (at === 0) === (hi === 0) ? oldBlocks[at] : null;
      const tpl = own ?? oldBlocks[at >= 0 ? at : 0] ?? null;
      const staff = (tpl && tagText(tpl, "staff")) || run.staff;
      return buildNote(tpl, own != null, {
        grace: false, chord: hi > 0, head: h, dur, voice, staff,
        type: typeFor(it.len, tpl, false), tm, tieStart: h.tie, tieStop: stops[j][hi], tuplet: hi === 0 ? tuplet : null,
        accidental: accOf(h, tpl, own != null), alter0: alter0(h, staff),
      }, style);
    });
  });
  // Directions etc. inside the run stay before the note they were before.
  const anchorAt = (before: number) => {
    for (let i = before; i < olds.length; i++) { const j = pair.indexOf(i); if (j >= 0) return j; }
    return news.length;
  };
  const slots: string[][] = Array.from({ length: news.length + 1 }, () => []);
  for (const a of run.anchors) slots[anchorAt(a.before)].push(a.text);
  const elems: string[] = [];
  news.forEach((_, j) => { elems.push(...slots[j], ...out[j]); });
  elems.push(...slots[news.length]);
  if (run.leadAbsorbs && startPos > run.startPos)
    elems.unshift(`<forward><duration>${startPos - run.startPos}</duration><voice>${voice}</voice><staff>${run.staff}</staff></forward>`);
  const endPos = startPos + news.reduce((s, it) => { const v = sounding(it); return s + v[0] * div / v[1]; }, 0);
  const firstKid = kids[run.first], lastKid = kids[run.last];
  const prevEnd = kids[run.first - 1]?.end ?? children(xml.slice(base, base + kids[run.first].start)).open.length;
  const sep = xml.slice(base + prevEnd, base + firstKid.start) || "";
  const edits: Array<[number, number, string]> = [];
  // After the run: the next voice starts where it did.
  const delta = endPos - run.endPos;
  if (run.next != null && delta !== 0) {
    const t = kids[run.next], d = tagNum(t.text, "duration") ?? 0;
    const tws = xml.slice(base + kids[run.next - 1].end, base + t.start);
    if (t.tag === "backup") {
      const nd = d + delta;
      if (nd > 0) edits.push([base + t.start, base + t.end, t.text.replace(/<duration>\s*\d+\s*<\/duration>/, `<duration>${nd}</duration>`)]);
      else if (nd === 0) edits.push([base + kids[run.next - 1].end, base + t.end, ""]);
      else edits.push([base + t.start, base + t.end, `<forward><duration>${-nd}</duration></forward>`]);
    } else edits.push([base + t.start, base + t.start, (delta > 0 ? `<backup><duration>${delta}</duration></backup>` : `<forward><duration>${-delta}</duration></forward>`) + tws]);
  }
  edits.push(elems.length ? [base + firstKid.start, base + lastKid.end, elems.join(sep)] : [base + prevEnd, base + lastKid.end, ""]);
  // Before the run: the <backup> that sets where this voice starts. Moving later adds a <forward>
  // (as the score had it); moving earlier backs up further.
  if (run.leadAbsorbs && run.preBackup != null && startPos < run.startPos) {
    const b = kids[run.preBackup], bd = tagNum(b.text, "duration") ?? 0;
    edits.push([base + b.start, base + b.end, b.text.replace(/<duration>\s*\d+\s*<\/duration>/, `<duration>${bd + run.startPos - startPos}</duration>`)]);
  }
  edits.sort((x, y) => y[0] - x[0]);
  for (const [s, e, t] of edits) xml = splice(xml, s, e, t);
  return dropLostTies(xml, mi, pi, voice, olds, news);
}

/** A tie into the next measure that the line removed: drop the matching stop there too. */
function dropLostTies(xml: string, mi: number, pi: number, voice: string, olds: OldItem[], news: Item[]): string {
  const lastOld = [...olds].reverse().find((o) => o.item.kind === "n" || o.item.kind === "z")?.item;
  const lastNew = [...news].reverse().find((it) => it.kind === "n" || it.kind === "z");
  const before = new Set(lastOld?.kind === "n" ? lastOld.heads.filter((h) => h.tie).map(midiOf) : []);
  const after = new Set(lastNew?.kind === "n" ? lastNew.heads.filter((h) => h.tie).map(midiOf) : []);
  const lost = [...before].filter((m) => !after.has(m));
  if (!lost.length) return xml;
  const next = readMeasure(xml, mi + 1)?.parts.find((p) => p.partIndex === pi);
  if (!next) return xml;
  const first = next.notes.find((n) => n.voice === voice && !n.grace);
  if (!first) return xml;
  const group = next.notes.filter((n) => n.voice === voice && (n === first || (n.chord && n.index > first.index && n.index < first.index + first.chordSize)));
  for (const n of [...group].reverse()) {
    if (n.midi == null || !lost.includes(n.midi) || !n.tieStop) continue;
    const b = xml.slice(n.start, n.end).replace(/\s*<tie\s+type="stop"\s*\/>/g, "").replace(/\s*<tied\s+type="stop"[^>]*\/>/g, "").replace(/\s*<notations>\s*<\/notations>/g, "");
    xml = splice(xml, n.start, n.end, b);
  }
  return xml;
}
