// Hidden rests in the preview: a bass voice packed to the start of the bar is listed, filled one
// measure at a time or all at once, and the saved score gets invisible <forward> gaps, no printed rests.
// Needs a built app: SF_UI_URL (default http://127.0.0.1:8794/scorefollow/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const n = (pitch, dur, voice, staff, type) => `<note>${pitch}<duration>${dur}</duration><voice>${voice}</voice><type>${type}</type><staff>${staff}</staff></note>`;
const p = (s, o) => `<pitch><step>${s}</step><octave>${o}</octave></pitch>`;
const R = "<rest/>";
const bar = (num, attrs, bass1, bass2) => `<measure number="${num}">${attrs}${n(p("D", 5), 4, 1, 1, "quarter")}${n(p("E", 5), 4, 1, 1, "quarter")}<backup><duration>8</duration></backup>`
  + `${n(p(...bass1), 1, 5, 2, "16th")}${n(p("G", 3), 1, 5, 2, "16th")}${n(R, 2, 5, 2, "eighth")}${n(p(...bass2), 1, 5, 2, "16th")}${n(p("G", 3), 1, 5, 2, "16th")}${n(R, 2, 5, 2, "eighth")}`
  + `<backup><duration>8</duration></backup>${n(p(...bass1), 2, 6, 2, "eighth")}${n(p(...bass2), 2, 6, 2, "eighth")}</measure>`;
const attrs = `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
${bar(1, attrs, ["B", 2], ["C", 3])}
${bar(2, "", ["A", 2], ["B", 2])}
${bar(3, "", ["G", 2], ["A", 2])}</part></score-partwise>`;
const url = process.env.SF_UI_URL || "http://127.0.0.1:8794/scorefollow/";
const shots = process.env.SF_SHOTS || "/tmp";
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/omr/jobs", (route) => route.fulfill({ json: { id: `gap-${width}`, status: "completed",
      result: { musicXml: xml, compatible: true, noteCount: 30, measureCount: 3, restoredFirstRest: false } } }));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^((演奏)?分析|Analyze)$/ }).click();
    await page.getByText(/^(从 PDF 识别（OMR，可选）|Recognize from PDF \(OMR, optional\))$/).click();
    await page.getByLabel(/另选用于识别的 PDF|PDF for recognition/).setInputFiles({ name: "gap.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture") });
    await page.getByRole("button", { name: /^(识别 PDF|Recognize PDF)$/ }).click();
    const trigger = page.getByRole("button", { name: /预览识别乐谱|Preview recognized score/ });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /识别乐谱预览|Recognized score preview/ });
    await dialog.locator("svg").first().waitFor();
    const zh = /识别乐谱预览/.test(await dialog.getAttribute("aria-label"));
    const editor = dialog.getByRole("region", { name: /小节修改|Measure editor/ });
    const list = dialog.getByText(zh ? "疑似漏写休止符：" : "Likely hidden rests:");
    await list.waitFor();
    for (const m of [1, 2, 3]) await dialog.getByRole("button", { name: zh ? `第${m}小节` : `m${m}` }).waitFor();

    // One measure by hand: the suggestion names the beats, the button fills it, the bar leaves the list.
    await dialog.getByRole("button", { name: zh ? "第1小节" : "m1" }).click();
    await editor.getByText(zh ? /从第 1、1\.5 拍移到第 1、2 拍/ : /from beats 1, 1\.5 to 1, 2/).waitFor();
    if (width === 1280) await page.screenshot({ path: `${shots}/voice-fill-${width}.png` });
    await editor.getByRole("button", { name: zh ? "补上隐藏休止符" : "Fill hidden rest" }).click();
    await dialog.getByRole("button", { name: zh ? "第1小节" : "m1" }).waitFor({ state: "detached" });
    await editor.getByText(zh ? /可能漏写了休止符/ : /Probably a hidden rest/).waitFor({ state: "detached" });
    // The rest at once.
    await dialog.getByRole("button", { name: zh ? "全部补上（2 小节）" : "Fill all (2 measures)" }).click();
    await dialog.getByText(zh ? "已在 2 个声部补上隐藏休止符（乐谱外观不变）。" : "Filled hidden rests in 2 voices (the printed score looks the same).").waitFor();
    await list.waitFor({ state: "detached" });
    if (width === 390) await page.screenshot({ path: `${shots}/voice-fill-${width}.png` });

    await dialog.getByRole("button", { name: /保存修改用于分析|Save edits for analysis/ }).click();
    await dialog.getByText(/已保存|Saved:/).waitFor();
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: /下载当前预览的 MusicXML|Download the previewed MusicXML/ }).click();
    const saved = readFileSync(await (await pending).path(), "utf8");
    assert.equal((saved.match(/<forward><duration>2<\/duration><voice>6<\/voice><staff>2<\/staff><\/forward>/g) ?? []).length, 3);
    assert.equal((saved.match(/<rest\/>/g) ?? []).length, (xml.match(/<rest\/>/g) ?? []).length, "no printed rest added");
    assert.equal(saved.replace(/<forward>[\s\S]*?<\/forward>/g, ""), xml, "only the invisible gaps were added");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `no horizontal page scroll (${overflow})`);
    assert.deepEqual(errors, []);
    console.log(`VOICE_FILL_UI_OK ${width}`);
    await page.close();
  }
} finally { await browser.close(); }
