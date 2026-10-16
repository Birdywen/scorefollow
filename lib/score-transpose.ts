/** Chromatic MusicXML transposition (notes only, key signature unchanged).
 * Used by the OMR preview dialog so players can shift a recognized part
 * into a comfortable key and download the result. Accidentals inside the
 * same <note> block are re-synced to the new alter; <unpitched> untouched.
 */

const STEP_BASE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Prefer sharps on the way back (C, C#, D, D#, E, F, F#, G, G#, A, A#, B).
const SHARP_STEPS: Array<[string, number]> = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];

function alterToAccidental(alter: number): string | null {
  if (alter === 0) return "natural";
  if (alter === 1) return "sharp";
  if (alter === -1) return "flat";
  if (alter === 2) return "double-sharp";
  if (alter === -2) return "double-flat";
  return null;
}

function transposePitchBlock(block: string, semitones: number): string {
  const m = block.match(/<step>([A-G])<\/step>\s*(?:<alter>(-?\d+)<\/alter>\s*)?<octave>(\d+)<\/octave>/);
  if (!m) return block;
  const step = m[1];
  const alter = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const octave = parseInt(m[3], 10);
  if (!(step in STEP_BASE) || !Number.isFinite(alter) || !Number.isFinite(octave)) return block;
  const midi = (octave + 1) * 12 + STEP_BASE[step] + alter + semitones;
  const pc = ((midi % 12) + 12) % 12;
  const [newStep, newAlter] = SHARP_STEPS[pc];
  const newOctave = Math.floor(midi / 12) - 1;
  const alterXml = newAlter === 0 ? "" : `<alter>${newAlter}</alter>`;
  return `<step>${newStep}</step>${alterXml}<octave>${newOctave}</octave>`;
}

/** Transpose every <note><pitch> by semitones; returns the input unchanged for 0. */
export function transposeMusicXml(xml: string, semitones: number): string {
  if (!xml || !Number.isFinite(semitones) || Math.trunc(semitones) === 0) return xml;
  const shift = Math.trunc(semitones);
  return xml.replace(/<note[\s\S]*?<\/note>/g, (note) => {
    if (!/<pitch>[\s\S]*?<\/pitch>/.test(note)) return note;
    let out = note.replace(/<pitch>[\s\S]*?<\/pitch>/g, (pitch) =>
      pitch.replace(/<step>[A-G]<\/step>\s*(?:<alter>-?\d+<\/alter>\s*)?<octave>\d+<\/octave>/, (b) =>
        transposePitchBlock(b, shift),
      ),
    );
    // Re-sync <accidental> to the new alter so notation + playback agree.
    const pm = out.match(/<pitch>\s*<step>[A-G]<\/step>\s*(?:<alter>(-?\d+)<\/alter>\s*)?<octave>\d+<\/octave>/);
    if (pm) {
      const alter = pm[1] !== undefined ? parseInt(pm[1], 10) : 0;
      const acc = alterToAccidental(alter);
      if (acc === null) {
        out = out.replace(/\s*<accidental>[\s\S]*?<\/accidental>/, "");
      } else if (/<accidental>[\s\S]*?<\/accidental>/.test(out)) {
        out = out.replace(/<accidental>[\s\S]*?<\/accidental>/, `<accidental>${acc}</accidental>`);
      }
    }
    return out;
  });
}

/** Suffix for a transposed download, e.g. "_t-2" / "_t+3" (0 => ""). */
export function transposeSuffix(semitones: number): string {
  if (!semitones) return "";
  return `_t${semitones > 0 ? "+" : ""}${semitones}`;
}
