// Fix recognition errors in the preview: click a measure, change notes, edit raw XML, save for analysis.
// Needs a built app: SF_UI_URL (default http://127.0.0.1:8794/scorefollow/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const n = (pitch, dur, type) => `<note>${pitch}<duration>${dur}</duration><voice>1</voice><type>${type}</type></note>`;
const p = (s, o) => `<pitch><step>${s}</step><octave>${o}</octave></pitch>`;
const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>1</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${n(p("G", 4), 1, "quarter")}${n(p("F", 4), 1, "quarter")}${n(p("A", 4), 1, "quarter")}${n(p("B", 4), 1, "quarter")}</measure>
<measure number="2">${n(p("C", 5), 2, "half")}${n(p("D", 5), 1, "quarter")}</measure>
<measure number="3">${n(p("E", 5), 4, "whole")}</measure>
<measure number="4">${n(p("G", 4), 4, "whole")}</measure></part></score-partwise>`;
const url = process.env.SF_UI_URL || "http://127.0.0.1:8794/scorefollow/";
const shots = process.env.SF_SHOTS || "/tmp";
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/omr/jobs", (route) => route.fulfill({ json: { id: `edit-${width}`, status: "completed",
      result: { musicXml: xml, compatible: true, noteCount: 7, measureCount: 4, restoredFirstRest: false } } }));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^((演奏)?分析|Analyze)$/ }).click();
    await page.getByText(/^(从 PDF 识别（OMR，可选）|Recognize from PDF \(OMR, optional\))$/).click();
    await page.getByLabel(/另选用于识别的 PDF|PDF for recognition/).setInputFiles({ name: "edit.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture") });
    await page.getByRole("button", { name: /^(识别 PDF|Recognize PDF)$/ }).click();
    const trigger = page.getByRole("button", { name: /预览识别乐谱|Preview recognized score/ });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /识别乐谱预览|Recognized score preview/ });
    await dialog.locator("svg").first().waitFor();
    const zh = /识别乐谱预览/.test(await dialog.getAttribute("aria-label"));
    const editor = dialog.getByRole("region", { name: /小节修改|Measure editor/ });
    const measureNo = editor.getByLabel(/小节序号|Measure index/);
    const rows = editor.getByTestId("edit-note");

    // The short bar is listed; clicking a note picks its measure and outlines it.
    const issue = dialog.getByRole("button", { name: zh ? "第2小节" : "m2" });
    await issue.waitFor();
    const heads = dialog.locator("svg .vf-stavenote");
    await page.waitForFunction(() => document.querySelectorAll("dialog svg .vf-stavenote").length >= 7);
    await heads.nth(1).scrollIntoViewIfNeeded();
    const second = await heads.nth(1).boundingBox();
    await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
    await editor.waitFor();
    assert.equal(await measureNo.inputValue(), "1", "click on a note of bar 1 opens bar 1");
    const mark = await dialog.getByTestId("measure-mark").boundingBox();
    assert(mark.x <= second.x && mark.x + mark.width >= second.x + second.width && mark.y <= second.y + second.height && mark.y + mark.height >= second.y, "outline covers the clicked note");
    await heads.nth(4).scrollIntoViewIfNeeded();
    const fifth = await heads.nth(4).boundingBox(); // the half note in bar 2
    await page.mouse.click(fifth.x + fifth.width / 2, fifth.y + fifth.height / 2);
    await page.waitForFunction(() => document.querySelector("dialog input[type=number]")?.value === "2");
    await editor.getByRole("button", { name: /上一小节|Previous measure/ }).click();
    assert.equal(await measureNo.inputValue(), "1");
    assert.deepEqual(await rows.locator("b").allInnerTexts(), ["G4", "F♯4", "A4", "B4"], "key signature applied");

    // Fix a pitch: F♯4 -> E4. The score re-renders; nothing is saved yet.
    await editor.getByLabel(zh ? "第 2 个音 音名" : "Note 2 step").selectOption("E");
    await page.waitForFunction(() => [...document.querySelectorAll("dialog [data-testid=edit-note] b")].map((b) => b.textContent).join() === "G4,E4,A4,B4");
    await editor.getByLabel(zh ? "第 1 个音 升降" : "Note 1 accidental").selectOption("1");
    await page.waitForFunction(() => document.querySelector("dialog [data-testid=edit-note] b")?.textContent === "G♯4");
    await editor.getByRole("button", { name: zh ? "改为休止" : "To rest" }).nth(2).click();
    assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => (tr.querySelector("b") ?? tr.children[3]).textContent)), ["G♯4", "E4", zh ? "休止" : "rest", "B4"]);
    await dialog.getByRole("button", { name: zh ? "撤销" : "Undo" }).click();
    assert.deepEqual(await rows.locator("b").allInnerTexts(), ["G♯4", "E4", "A4", "B4"], "undo brings the A back");

    // Bar 2 is a beat short: invalid XML is refused and kept for fixing; valid XML clears the warning.
    await issue.click();
    assert.equal(await measureNo.inputValue(), "2");
    await editor.getByRole("button", { name: /编辑本小节 XML|Edit this measure's XML/ }).click();
    const box = editor.getByLabel(/本小节 MusicXML|This measure's MusicXML/);
    const original = await box.inputValue();
    assert.match(original, /^<measure number="2">/);
    await box.fill("<measure number=\"2\"><note></measure>");
    await editor.getByRole("button", { name: zh ? "应用 XML" : "Apply XML" }).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal(await box.inputValue(), "<measure number=\"2\"><note></measure>", "bad XML stays in the box");
    await box.fill(original.replace("</measure>", n(p("B", 4), 1, "quarter") + "</measure>"));
    await editor.getByRole("button", { name: zh ? "应用 XML" : "Apply XML" }).click();
    await issue.waitFor({ state: "detached" });
    assert.deepEqual(await rows.locator("b").allInnerTexts(), ["C5", "D5", "B4"]);
    if (width === 1280) await page.screenshot({ path: `${shots}/score-edit-${width}.png` });

    // Unsaved changes ask before closing; save, close, reopen: the edits are there and analysis uses them.
    page.once("dialog", (d) => d.dismiss());
    await page.keyboard.press("Escape");
    assert(await dialog.isVisible(), "dismissed confirm keeps the editor open");
    await dialog.getByRole("button", { name: /保存修改用于分析|Save edits for analysis/ }).click();
    await dialog.getByText(/已保存|Saved:/).waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(/已手动修正识别错误|Recognition errors fixed by hand/).waitFor();
    await page.getByText(/edit-edited\.musicxml/).first().waitFor({ state: "attached" }); // the step summary may be collapsed
    await trigger.click();
    await dialog.locator("svg").first().waitFor();
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: /下载当前预览的 MusicXML|Download the previewed MusicXML/ }).click();
    const saved = readFileSync(await (await pending).path(), "utf8");
    assert.match(saved, /<step>G<\/step><alter>1<\/alter><octave>4<\/octave><\/pitch><duration>1<\/duration><voice>1<\/voice><type>quarter<\/type><accidental>sharp<\/accidental>/);
    assert.match(saved, /<step>E<\/step><octave>4<\/octave>/);
    assert.match(saved, /<measure number="2">[\s\S]*<step>B<\/step><octave>4<\/octave>[\s\S]*?<\/measure>/);
    assert.equal(saved.replace(/<measure number="[12]">[\s\S]*?<\/measure>/g, ""), xml.replace(/<measure number="[12]">[\s\S]*?<\/measure>/g, ""), "untouched bars are byte-identical");
    // Restore the recognized version.
    await dialog.getByRole("button", { name: /恢复识别原版|Restore recognized/ }).click();
    await dialog.getByRole("button", { name: zh ? "第2小节" : "m2" }).waitFor();
    await dialog.getByRole("button", { name: /保存修改用于分析|Save edits for analysis/ }).click();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(/已手动修正识别错误|Recognition errors fixed by hand/).waitFor({ state: "detached" });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `no horizontal page scroll (${overflow})`);
    assert.deepEqual(errors, []);
    console.log(`SCORE_EDIT_UI_OK ${width}`);
    await page.close();
  }
} finally { await browser.close(); }
