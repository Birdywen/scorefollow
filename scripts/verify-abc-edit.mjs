// Fix rhythm per voice in the preview with a line of ABC: a lost triplet (bar too long) and an omitted
// rest in the bass. Needs a built app: SF_UI_URL (default http://127.0.0.1:8794/scorefollow/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const p = (s, o, a) => `<pitch><step>${s}</step>${a != null ? `<alter>${a}</alter>` : ""}<octave>${o}</octave></pitch>`;
const n = (pitch, dur, type, voice, staff, extra = "") => `<note>${pitch}<duration>${dur}</duration><voice>${voice}</voice><type>${type}</type>${extra}<staff>${staff}</staff></note>`;
const attrs = `<attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
<measure number="1">${attrs}${n(p("E", 5), 2, "quarter", 1, 1)}${n(p("F", 5, 1), 2, "quarter", 1, 1)}${n(p("G", 5), 4, "half", 1, 1)}<backup><duration>8</duration></backup>${n(p("C", 3), 1, "eighth", 5, 2, '<beam number="1">begin</beam>')}${n(p("E", 3), 1, "eighth", 5, 2, '<beam number="1">end</beam>')}</measure>
<measure number="2">${n(p("C", 5), 1, "eighth", 1, 1)}${n(p("D", 5), 1, "eighth", 1, 1)}${n(p("E", 5), 1, "eighth", 1, 1)}${n(p("D", 5), 2, "quarter", 1, 1)}${n(p("E", 5), 2, "quarter", 1, 1)}${n(p("F", 5, 1), 2, "quarter", 1, 1)}<backup><duration>9</duration></backup>${n(p("G", 2), 8, "whole", 5, 2)}</measure>
<measure number="3">${n(p("G", 5), 8, "whole", 1, 1)}<backup><duration>8</duration></backup>${n(p("G", 2), 8, "whole", 5, 2)}</measure></part></score-partwise>`;
const url = process.env.SF_UI_URL || "http://127.0.0.1:8794/scorefollow/";
const shots = process.env.SF_SHOTS || "/tmp";
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/omr/jobs", (route) => route.fulfill({ json: { id: `abc-${width}`, status: "completed",
      result: { musicXml: xml, compatible: true, noteCount: 14, measureCount: 3, restoredFirstRest: false } } }));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^((演奏)?分析|Analyze)$/ }).click();
    await page.getByText(/^(从 PDF 识别（OMR，可选）|Recognize from PDF \(OMR, optional\))$/).click();
    await page.getByLabel(/另选用于识别的 PDF|PDF for recognition/).setInputFiles({ name: "abc.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture") });
    await page.getByRole("button", { name: /^(识别 PDF|Recognize PDF)$/ }).click();
    await page.getByRole("button", { name: /预览识别乐谱|Preview recognized score/ }).click();
    const dialog = page.getByRole("dialog", { name: /识别乐谱预览|Recognized score preview/ });
    await dialog.locator("svg").first().waitFor();
    const zh = /识别乐谱预览/.test(await dialog.getAttribute("aria-label"));
    const editor = dialog.getByRole("region", { name: /小节修改|Measure editor/ });

    // Bar 2 is too long: the triplet mark was lost. One line fixes it.
    await dialog.getByRole("button", { name: zh ? "第2小节" : "m2" }).click();
    const v1 = editor.getByLabel(zh ? /^声部 1/ : /^Voice 1/);
    assert.equal(await v1.inputValue(), "c d e d2 e2 f2");
    const s1 = editor.locator("#abc-0-1-status"), s5 = editor.locator("#abc-0-5-status");
    const says = async (loc, text) => { await page.waitForFunction(([sel, t]) => document.querySelector(sel)?.textContent === t, [`#${await loc.getAttribute("id")}`, text]); };
    await says(s1, zh ? "4.5 拍，超出小节（4 拍）" : "4.5 beats, longer than the bar (4)");
    await v1.fill("(3c d e d2 e2 f2");
    await says(s1, zh ? "4 拍 ✓" : "4 beats ✓");
    // A typo is caught before anything is applied.
    await v1.fill("(3c d e d2 e2 q");
    await editor.getByRole("alert").filter({ hasText: zh ? /看不懂 "q"/ : /unexpected "q"/ }).waitFor();
    assert.equal(await editor.getByRole("button", { name: zh ? "应用" : "Apply" }).first().isDisabled(), true);
    await v1.fill("(3c d e d2 e2 f2");
    await v1.press("Enter");
    await dialog.getByRole("button", { name: zh ? "第2小节" : "m2" }).waitFor({ state: "detached" });
    assert.equal(await v1.inputValue(), "(3c d e d2 e2 f2", "the line is read back from the score");
    if (width === 1280) await page.screenshot({ path: `${shots}/abc-edit-${width}.png` });

    // Bar 1: the bass enters on beat 2 and 3 (rests omitted in print).
    await editor.getByRole("button", { name: /上一小节|Previous measure/ }).click();
    const v5 = editor.getByLabel(zh ? /^声部 5/ : /^Voice 5/);
    assert.equal(await v5.inputValue(), "C, E,");
    await v5.fill("x2 C, x E,");
    await says(s5, zh ? "2.5 拍，小节 4 拍，其余按末尾休止" : "2.5 beats of 4; the rest counts as a rest at the end");
    await editor.locator('[data-testid="abc-row"]:has(#abc-0-5) button').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="abc-row"] input[value="x2 C, x E,"]'));
    if (width === 390) await page.screenshot({ path: `${shots}/abc-edit-${width}.png` });

    // Undo goes back one edit; redo it by hand and save.
    await dialog.getByRole("button", { name: zh ? "撤销" : "Undo" }).click();
    assert.equal(await v5.inputValue(), "C, E,");
    await v5.fill("x2 C, x E,");
    await v5.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="abc-row"] input[value="x2 C, x E,"]'));
    await dialog.getByRole("button", { name: /保存修改用于分析|Save edits for analysis/ }).click();
    await dialog.getByText(/已保存|Saved:/).waitFor();
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: /下载当前预览的 MusicXML|Download the previewed MusicXML/ }).click();
    const saved = readFileSync(await (await pending).path(), "utf8");
    const ms = [...saved.matchAll(/<measure(?=[\s>])[\s\S]*?<\/measure>/g)].map((m) => m[0]);
    assert.equal((ms[0].match(/<forward>/g) ?? []).length, 2, "two hidden rests in bar 1");
    assert.equal((ms[0].match(/<rest/g) ?? []).length, 0, "nothing printed");
    assert.match(ms[0], /<beam number="1">begin<\/beam>/);
    assert.match(ms[1], /<divisions>6<\/divisions>/);
    assert.equal((ms[1].match(/<time-modification>/g) ?? []).length, 3);
    assert.match(ms[2], /<divisions>2<\/divisions>/);
    assert.equal(ms[2], xml.match(/<measure number="3">[\s\S]*?<\/measure>/)[0].replace("<note>", "<attributes><divisions>2</divisions></attributes><note>"));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `no horizontal page scroll (${overflow})`);
    assert.deepEqual(errors, []);
    console.log(`ABC_EDIT_UI_OK ${width}`);
    await page.close();
  }
} finally { await browser.close(); }
