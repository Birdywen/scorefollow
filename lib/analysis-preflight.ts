/** Lightweight browser preflight; the server remains the authoritative parser. */
export type ScorePreflight = {
  measures: number; notes: number; minMidi: number | null; maxMidi: number | null;
  meter: string | null; warnings: string[]; errors: string[];
};

export function inspectScoreXml(xml: string, instrument?: string): ScorePreflight {
  // Piano has its own polyphonic parser: chords, grand staff, voices and repeats are fine.
  const piano = instrument === "piano";
  const report: ScorePreflight = { measures: 0, notes: 0, minMidi: null, maxMidi: null, meter: null, warnings: [], errors: [] };
  if (new TextEncoder().encode(xml).byteLength > 1_000_000) {
    report.errors.push("too_large"); return report;
  }
  if (/<!ENTITY\b/i.test(xml)) { report.errors.push("entities"); return report; }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "score-partwise") {
    report.errors.push("invalid_xml"); return report;
  }
  const elements = (tag: string) => Array.from(doc.getElementsByTagNameNS("*", tag));
  const text = (el: Element, tag: string) => el.getElementsByTagNameNS("*", tag)[0]?.textContent?.trim() ?? "";
  const parts = elements("part");
  if (parts.length !== 1 && !piano) report.errors.push("multiple_parts");
  report.measures = parts[0]?.getElementsByTagNameNS("*", "measure").length ?? 0;
  if (!report.measures) report.errors.push("no_measures");
  if (piano) { /* polyphony and repeats handled by the piano parser */ }
  else if (elements("backup").length || elements("forward").length || new Set(elements("voice").map((el) => el.textContent?.trim())).size > 1) report.errors.push("polyphonic");
  else if (elements("chord").length) report.warnings.push("chords");
  if (!piano && (elements("repeat").length || elements("ending").length)) report.errors.push("repeats");
  if (elements("transpose").length) report.errors.push("transposing");
  const meters = elements("time").map((el) => `${text(el, "beats")}/${text(el, "beat-type")}`);
  report.meter = meters[0] ?? null;
  if (new Set(meters).size > 1) report.errors.push("meter_changes");
  if (/^(6|9|12)\/8$/.test(report.meter ?? "")) report.warnings.push("compound_meter");
  const steps: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const context = new Map<Element, number>();
  let fifths = 0;
  for (const measure of Array.from(parts[0]?.getElementsByTagNameNS("*", "measure") ?? [])) {
    const key = measure.getElementsByTagNameNS("*", "fifths")[0]?.textContent?.trim();
    if (key != null && Number.isInteger(Number(key))) fifths = Number(key);
    const accidentals = new Map<string, number>();
    for (const note of Array.from(measure.getElementsByTagNameNS("*", "note"))) {
      const pitch = note.getElementsByTagNameNS("*", "pitch")[0];
      if (!pitch) continue;
      const step = text(pitch, "step"), octave = text(pitch, "octave");
      const pitchKey = `${step}:${octave}`;
      const explicit = text(pitch, "alter");
      const symbol = text(note, "accidental");
      const symbols: Record<string, number> = { sharp: 1, flat: -1, natural: 0, "double-sharp": 2, "sharp-sharp": 2, "flat-flat": -2 };
      let alter = explicit ? Number(explicit) : symbol in symbols ? symbols[symbol] : accidentals.get(pitchKey);
      if (alter == null) alter = (fifths > 0 ? "FCGDAEB" : "BEADGCF").slice(0, Math.abs(fifths)).includes(step) ? Math.sign(fifths) : 0;
      if (explicit || symbol) accidentals.set(pitchKey, alter);
      context.set(pitch, alter);
    }
  }
  for (const pitch of elements("pitch")) {
    report.notes++;
    const octave = text(pitch, "octave"), step = text(pitch, "step");
    const alter = context.get(pitch) ?? Number(text(pitch, "alter") || "0");
    const midi = (Number(octave) + 1) * 12 + steps[step] + Number(alter);
    if (!octave || !Number.isInteger(Number(octave)) || !Number.isInteger(Number(alter)) || !Number.isFinite(midi)) {
      if (!report.errors.includes("invalid_pitch")) report.errors.push("invalid_pitch");
      continue;
    }
    report.minMidi = Math.min(report.minMidi ?? midi, midi);
    report.maxMidi = Math.max(report.maxMidi ?? midi, midi);
  }
  if (!report.notes) report.errors.push("no_notes");
  const [lowest, highest] = piano ? [21, 108] : [36, 96];
  if (report.minMidi != null && (report.minMidi < lowest || (report.maxMidi ?? 0) > highest)) report.warnings.push("pitch_range");
  return report;
}

export function preflightMessage(code: string, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    too_large: ["MusicXML 超过 1 MB。", "MusicXML exceeds 1 MB."],
    entities: ["MusicXML 含不支持的实体声明。", "MusicXML contains unsupported entity declarations."],
    invalid_xml: ["文件不是有效的 score-partwise MusicXML。", "The file is not valid score-partwise MusicXML."],
    multiple_parts: ["当前分析要求单个乐器声部。", "Analysis currently requires a single instrument part."],
    no_measures: ["谱面没有小节。", "The score has no measures."],
    no_notes: ["谱面没有可分析音符。", "The score has no pitched notes to analyze."],
    polyphonic: ["当前谱面解析器不支持多声部（同一声部内的双音/和弦可以）。", "The score parser does not support multiple voices (double stops/chords within one voice are fine)."],
    chords: ["含双音/和弦：按和弦对齐并计节奏，谱面每个和弦音单独检查音准；没拉到的音单独标出，与低音成八度的上方音无法单独测。", "Contains double stops/chords: aligned and timed as chords, and every written chord tone is checked for intonation; unplayed tones are flagged, and a tone an octave above a lower chord tone cannot be measured separately."],
    repeats: ["请先展开反复与跳房子，再上传线性谱面。", "Expand repeats and endings before uploading a linear score."],
    transposing: ["请上传实音记谱，当前不支持移调记谱。", "Upload a concert-pitch score; transposing notation is unsupported."],
    meter_changes: ["当前分析不支持拍号变化。", "Meter changes are not supported yet."],
    invalid_pitch: ["发现缺失或无效的音高、八度或升降号。", "A pitch, octave or accidental is missing or invalid."],
    compound_meter: ["复合拍号：BPM 通常按附点四分音符填写。", "Compound meter: BPM normally uses dotted-quarter beats."],
    pitch_range: ["音域超出内置弦乐检测范围；请核对乐器与谱面八度。", "Pitch range exceeds the builtin string detector; check instrument and score octaves."],
  };
  return messages[code]?.[zh ? 0 : 1] ?? code;
}

export function midiName(midi: number | null): string {
  if (midi == null) return "—";
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
