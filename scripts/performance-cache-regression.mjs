// Deterministic regression for the PerformancePanel session analysis cache and
// no-score guidance. Part 1 checks the source contract in
// app/PerformancePanel.tsx; part 2 simulates the exact dedup/cache protocol
// (same rules as the component) against a stub POST /jobs counter.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = await readFile("app/PerformancePanel.tsx", "utf8");

// --- Part 1: source contract ---
// Session/in-memory cache, never localStorage, never raw audio blobs.
assert.ok(src.includes("analysisCache = useRef(new Map"), "session cache must be an in-memory Map");
assert.ok(src.includes("analysisInflight = useRef(new Set"), "in-flight dedup must be session scoped");
for (const key of [...src.matchAll(/localStorage\.(setItem|getItem)\("([^"]+)"/g)].map((m) => m[2])) {
  assert.ok(["sf-takes-meta-v1", "sf-analysis-api"].includes(key), `analysis cache must not use localStorage (found ${key})`);
}
assert.ok(!src.includes("analysisCache.current.set(signature, body"), "cache must not store the request body/audio blob");
assert.equal((src.match(/analysisCache\.current\.set\(/g) ?? []).length, 1, "exactly one cache store: validated completed results only");
// Signature covers every analysis input.
for (const field of ["xml", "audioId", "instrument", "bpm", "startMeasure", "syncMode", "syncData"]) {
  assert.ok(src.includes(field), `signature must include ${field}`);
}
assert.ok(src.includes("take.id") && src.includes("take.blob.size"), "signature must include audio/take identity");
assert.ok(src.includes("measureSync") && src.includes("firstBeatAudioSec"), "signature sync data must cover manual + metronome modes");
// Ordering: cache-hit and in-flight checks run before any POST /jobs.
const postIdx = src.indexOf("`${base}/jobs`");
assert.ok(postIdx > 0, "POST /jobs must exist");
assert.ok(src.indexOf("analysisCache.current.get(signature)") < postIdx, "cache hit must precede POST");
assert.ok(src.indexOf("analysisInflight.current.has(signature)") < postIdx, "in-flight dedup must precede POST");
assert.ok(src.indexOf("analysisInflight.current.delete(signature)") > postIdx, "in-flight entry must be released");
// Failed results are never cached: the only store sits in the completed branch.
const completedIdx = src.indexOf('job.status === "completed"');
assert.ok(completedIdx > 0 && src.indexOf("analysisCache.current.set(") > completedIdx, "cache store must be inside the completed branch");
const failedBranch = src.slice(src.indexOf('job.status === "failed"'), src.indexOf('job.status === "failed"') + 120);
assert.ok(!failedBranch.includes("analysisCache"), "failed results must not be cached");
// No-score guidance: accessible, load-first, no false availability claims.
assert.ok(src.includes("scoreLoaded"), "no-score state must be derived");
assert.ok(src.includes('role="status"') && src.includes("!scoreLoaded"), "no-score guidance must be an accessible status");
assert.ok(src.includes("尚未载入谱面") && src.includes("No score loaded"), "guidance must be bilingual load-first instruction");
assert.ok(src.includes("先在上方载入 PDF 或导入 MusicXML") && src.includes("load a PDF or import MusicXML first"), "guidance must require a score first");
// Corrected state: pdfName alone must not count as a loaded score; only
// reliable signals (pdfMeasures, pdfBytes(), xmlFile) may derive scoreLoaded.
const scoreLoadedDecl = src.split("\n").find((l) => l.includes("scoreLoaded =") || l.includes("scoreLoaded="));
assert.ok(scoreLoadedDecl, "scoreLoaded derivation must exist");
assert.ok(!scoreLoadedDecl.includes("pdfName"), "pdfName alone must not count as a loaded score");
assert.ok(scoreLoadedDecl.includes("pdfMeasures"), "scoreLoaded must consider pdfMeasures");
assert.ok(scoreLoadedDecl.includes("pdfBytes("), "scoreLoaded must consider pdfBytes()");
assert.ok(scoreLoadedDecl.includes("xmlFile"), "scoreLoaded must consider xmlFile");
// Functional check mirroring the component derivation: initial state shows
// guidance; any real PDF bytes / measures / MusicXML clears it.
function scoreLoadedFor({ pdfMeasures, pdfBytes, xmlFile }) {
  return pdfMeasures > 0 || xmlFile !== null || (() => { try { return pdfBytes() != null; } catch { return false; } })();
}
assert.equal(scoreLoadedFor({ pdfMeasures: 0, pdfBytes: () => null, xmlFile: null }), false, "initial state (0 measures, no bytes, no MusicXML) must show no-score guidance");
assert.equal(scoreLoadedFor({ pdfMeasures: 0, pdfBytes: () => { throw new Error("unavailable"); }, xmlFile: null }), false, "unavailable pdfBytes must still show no-score guidance");
assert.ok(scoreLoadedFor({ pdfMeasures: 3, pdfBytes: () => null, xmlFile: null }), "PDF measures must clear no-score guidance");
assert.ok(scoreLoadedFor({ pdfMeasures: 0, pdfBytes: () => new ArrayBuffer(8), xmlFile: null }), "real PDF bytes must clear no-score guidance");
assert.ok(scoreLoadedFor({ pdfMeasures: 0, pdfBytes: () => null, xmlFile: {} }), "imported MusicXML must clear no-score guidance");

// --- Part 2: protocol simulation (mirrors the component rules) ---
function hashSignature(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
function analysisSignature(input) {
  return hashSignature([input.xml.length, input.xml, input.audioId, input.instrument,
    String(input.bpm), String(input.startMeasure), input.syncMode, input.syncData].join("\n"));
}
const base = { xml: "<score/>", audioId: "t-1:100:audio/wav", instrument: "violin", bpm: 80, startMeasure: 1, syncMode: "metronome", syncData: '{"firstBeatAudioSec":0.5}' };
const sig = (over = {}) => analysisSignature({ ...base, ...over });
assert.equal(sig(), sig(), "same inputs must produce the same signature");
assert.notEqual(sig({ xml: "<score></score>" }), sig(), "MusicXML content change must miss");
assert.notEqual(sig({ xml: "<other/>" }), sig(), "same-length MusicXML change must miss");
assert.notEqual(sig({ audioId: "t-2:100:audio/wav" }), sig(), "take/audio identity change must miss");
assert.notEqual(sig({ instrument: "cello" }), sig(), "instrument change must miss");
assert.notEqual(sig({ bpm: 90 }), sig(), "BPM change must miss");
assert.notEqual(sig({ startMeasure: 2 }), sig(), "start measure change must miss");
assert.notEqual(sig({ syncMode: "vamp-beat", syncData: "null" }), sig(), "sync mode change must miss");
assert.notEqual(sig({ syncData: '{"firstBeatAudioSec":0.6}' }), sig(), "sync data change must miss");

let postCount = 0;
const cache = new Map();
const inflight = new Set();
async function fakePost(signature, { fail = false } = {}) {
  postCount += 1;
  await new Promise((r) => setTimeout(r, 5));
  if (fail) throw new Error("failed");
  return { for: signature };
}
async function analyze(signature, opts) {
  if (cache.has(signature)) return { hit: "cache", result: cache.get(signature) };
  if (inflight.has(signature)) {
    while (inflight.has(signature)) await new Promise((r) => setTimeout(r, 1));
    if (cache.has(signature)) return { hit: "joined", result: cache.get(signature) };
    throw new Error("in-flight analysis failed");
  }
  inflight.add(signature);
  try {
    const result = await fakePost(signature, opts);
    cache.set(signature, result);
    return { hit: "fresh", result };
  } finally {
    inflight.delete(signature);
  }
}
// Duplicate in-flight submissions share a single POST /jobs.
const [first, second] = await Promise.all([analyze(sig()), analyze(sig())]);
assert.equal(postCount, 1, "duplicate in-flight analysis must not submit another POST /jobs");
assert.ok(["fresh", "joined"].includes(first.hit) && ["fresh", "joined"].includes(second.hit));
assert.deepEqual(first.result, second.result);
// Completed result is reused without another POST.
const third = await analyze(sig());
assert.equal(third.hit, "cache");
assert.equal(postCount, 1, "cache hit must not POST");
// Different inputs always re-submit.
await analyze(sig({ bpm: 90 }));
assert.equal(postCount, 2, "changed inputs must re-submit");
// Failures are never treated as cache hits.
await assert.rejects(() => analyze(sig({ bpm: 100 }), { fail: true }));
assert.ok(!cache.has(sig({ bpm: 100 })), "failed results must not be cached");
await assert.rejects(() => analyze(sig({ bpm: 100 }), { fail: true }));
assert.equal(postCount, 4, "failed analysis must re-submit on retry");

console.log("PERFORMANCE_CACHE_REGRESSION_PASS: signature coverage, single POST dedup, cache hit, failure exclusion, no-score guidance verified");
