/** 从 preload.js 里抽原 PDF: auto-report 的 fixed.preload.js 自带 pdf_data(分块 base64),
 * 本脚本拼回二进制, 供 homr-dump/gpu 管线直接消费.
 * 用法: node scripts/preload-pdf.mjs <in.preload.js> [out.pdf]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [src, dst] = process.argv.slice(2);
if (!src) { console.error("usage: node scripts/preload-pdf.mjs <in.preload.js> [out.pdf]"); process.exit(1); }
const text = readFileSync(src, "utf8");
const m = text.match(/pdf_data\s*=\s*\[(.*?)\];/s);
if (!m) { console.error("no pdf_data in", src); process.exit(1); }
const chunks = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
if (!chunks.length) { console.error("pdf_data empty in", src); process.exit(1); }
const out = dst ?? src.replace(/\.preload\.js$/i, "").replace(/\.js$/i, "") + ".pdf";
writeFileSync(out, Buffer.from(chunks.join(""), "base64"));
console.log(`wrote ${out} (${chunks.length} chunks)`);
