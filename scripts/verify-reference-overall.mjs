// evidence-4: borderline coverage still shows the overall score, labelled "for reference" with the
// share of notes that were not heard. Needs a built app: SF_UI_URL.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const notes = [["C", 3, 48], ["E", 3, 52], ["G", 3, 55], ["C", 4, 60]];
const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list><part id="P1">`
  + `<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>`
  + notes.map(([s, o]) => `<note><pitch><step>${s}</step><octave>${o}</octave></pitch><duration>1</duration><type>quarter</type></note>`).join("")
  + `</measure></part></score-partwise>`;
const result = {
  version: "string-mono-0.27", instrument: "cello", limitations: [],
  notes: notes.map(([, , midi], i) => ({ id: `n${i}`, measure: 1, pitchMidi: midi, expectedSec: .5 + i * .5, performedSec: .5 + i * .5,
    pitchErrorCents: i === 3 ? null : 0, timingErrorMs: 0, confidence: .9, status: "correct", pitchStatus: i === 3 ? "uncertain" : "correct" })),
  measureIntervals: [{ measure: 1, startSec: .5, endSec: 2.5 }, { measure: 2, startSec: 2.5, endSec: 4.5 }],
  summary: { pitchScore: 90, rhythmScore: 94, noteCount: 630, voicedNotes: 503, scoredPitchNotes: 500, timedNotes: 600, timingCandidateNotes: 629,
    confidence: "low", timingOffsetMs: 0, timingSpreadMs: 10 },
  quality: { version: "evidence-4", outcome: "partial", overallScore: 92, overallReliability: "reference", unheardRatio: .202,
    overallWeights: { pitch: .5, rhythm: .5 }, pitchMatchRate: .88, issues: ["low_coverage"], pitchCoverage: .794, timingCoverage: .954, followReady: false },
};
const rate = 22050, samples = rate * 3, wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 131 / rate)), 44 + i * 2);

const url = process.env.SF_UI_URL || "http://127.0.0.1:8794/scorefollow/";
const shots = process.env.SF_SHOTS || "/tmp";
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/jobs**", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(route.request().method() === "POST" ? { id: `ro-${width}`, status: "queued" } : { id: `ro-${width}`, status: "completed", result }) }));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^((演奏)?分析|Analyze)$/ }).click();
    const panel = page.getByRole("complementary", { name: /Performance analysis|演奏分析/ });
    await page.evaluate(() => document.querySelectorAll("aside details").forEach((d) => { d.open = true; }));
    await panel.getByLabel(/^(乐器|Instrument)/).selectOption("cello");
    await panel.locator('input[accept=".xml,.musicxml"]').setInputFiles({ name: "score.musicxml", mimeType: "application/xml", buffer: Buffer.from(xml) });
    await panel.locator('input[accept^="audio/"]').setInputFiles({ name: "take.wav", mimeType: "audio/wav", buffer: wav });
    await panel.getByRole("button", { name: /^(Analyze|分析这一遍)$/ }).click();
    const report = page.getByRole("region", { name: /Analysis report|分析报告/ });
    await report.getByText(/综合分仅供参考：有 20% 的音没听清|Overall score is indicative only: 20% of notes/).first().waitFor();
    const ring = await report.getByText("92", { exact: true }).count();
    assert(ring > 0, "overall 92 is shown");
    await page.screenshot({ path: `${shots}/reference-overall-${width}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `no horizontal page scroll (${overflow})`);
    assert.deepEqual(errors, []);
    console.log(`REFERENCE_OVERALL_OK ${width}`);
    await page.close();
  }
} finally {
  await browser.close();
}
