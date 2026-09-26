/**
 * synpdf-core.ts — 页级分析封装(Next.js 移植层门面)
 *
 * 衍生自 Wim Vree 的 synpdf.js rev.194, GPL-2.0-or-later。
 * 算法与可变状态在 ./synpdf-legacy, 本文件只做类型 + 页缓存 + 门面导出,
 * app/page.tsx 只从这里 import。
 */
import {
  legacyOpt,
  witArr,
  countPix,
  countPixFromBuffer,
  setSkipn,
  setSysprf,
  setHomrGate,
  applyHomrGate,
  getHomrGate,
  getSpatium,
  getAnnotFontPx,
  deskewCanvasInPlace,
  estimateSkewAngle,
  ALGO_VERSION,
  lastBarDiagnostics,
  lastHomrGateVetoes,
  lastMaskStats,
  lastSystemConfidence,
  type BarDiagnostic,
  type HomrGateFile,
} from "./synpdf-legacy";
import type { SynpdfOpt, SystemInfo, CountPixResult } from "./synpdf-legacy";
import type { TimeEntry } from "./synpdf-wijzer";

export type { SynpdfOpt, SystemInfo, CountPixResult, BarDiagnostic, HomrGateFile };
export {
  legacyOpt as opt,
  witArr,
  countPix,
  countPixFromBuffer,
  setSkipn,
  setSysprf,
  setHomrGate,
  applyHomrGate,
  getSpatium,
  getAnnotFontPx,
  deskewCanvasInPlace,
  estimateSkewAngle,
  ALGO_VERSION,
  lastBarDiagnostics,
  lastHomrGateVetoes,
  getHomrGate,
  lastMaskStats,
};

export interface PageAnalysis {
  systems: SystemInfo[];
  bars: number[][];
  spatium: number;
  annotFontPx: number;
  pageW: number;
  pageH: number;
  pageNumber: number;
  algoVersion: number;
  confidence: number[];
  diagnostics: BarDiagnostic[];
  elapsedMs: number;
}

/** 稳定分析预设: 快速 / 均衡 / 扫描谱(低对比度) */
export const ANALYSIS_PROFILES = {
  fast: { zwgrens: 0.7, drmpl: 0.4, drmpl2: 2, mtdrmpl: 0.8, voorna: 0.9, dx: 3 },
  balanced: { zwgrens: 0.7, drmpl: 0.4, drmpl2: 2, mtdrmpl: 0.75, voorna: 0.88, dx: 3 },
  scan: { zwgrens: 0.6, drmpl: 0.35, drmpl2: 2, mtdrmpl: 0.65, voorna: 0.85, dx: 3 },
} as const;
export type AnalysisProfileName = keyof typeof ANALYSIS_PROFILES;

export function applyAnalysisProfile(name: AnalysisProfileName): void {
  const p = ANALYSIS_PROFILES[name];
  legacyOpt.zwgrens = p.zwgrens;
  legacyOpt.drmpl = p.drmpl;
  legacyOpt.drmpl2 = p.drmpl2;
  legacyOpt.mtdrmpl = p.mtdrmpl;
  legacyOpt.voorna = p.voorna;
  legacyOpt.dx = p.dx;
  clearPageCache();
}

export const TIMING_SCHEMA = "scorefollow-timing/2" as const;

export interface TimingPayload {
  app: string;
  schema: typeof TIMING_SCHEMA;
  version: string;
  pdfName?: string;
  numPages?: number;
  pageW?: number;
  pageH?: number;
  algoVersion: number;
  measureCount: number;
  opt: Record<string, number | string>;
  times_arr: TimeEntry[];
  manualBarsByPage?: Record<string, number[][]>;
  loop: { start: number; end: number };
}

export function buildTimingPayload(args: {
  pdfName?: string; numPages?: number; pageW?: number; pageH?: number;
  measureCount: number; times: TimeEntry[];
  manualBarsByPage?: Record<string, number[][]>;
  loop: { start: number; end: number };
}): TimingPayload {
  const optSnap: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(legacyOpt)) {
    if (typeof v === "number" || typeof v === "string") optSnap[k] = v;
  }
  return {
    app: "scorefollow",
    schema: TIMING_SCHEMA,
    version: "2.1",
    pdfName: args.pdfName,
    numPages: args.numPages,
    pageW: args.pageW,
    pageH: args.pageH,
    algoVersion: ALGO_VERSION,
    measureCount: args.measureCount,
    opt: optSnap,
    times_arr: args.times.map((e) => ({ t: 1 * e.t, mix: 1 * e.mix })),
    manualBarsByPage: args.manualBarsByPage,
    loop: args.loop,
  };
}

export function validateTimingPayload(p: unknown): { ok: boolean; reason: string; data?: TimingPayload } {
  if (!p || typeof p !== "object") return { ok: false, reason: "not-an-object" };
  const q = p as Record<string, unknown>;
  if (q.app !== "scorefollow") return { ok: false, reason: "bad-app" };
  if (q.schema !== TIMING_SCHEMA && (q as { version?: unknown }).version !== "2.1") {
    return { ok: false, reason: "unsupported-schema" };
  }
  if (!Array.isArray(q.times_arr)) return { ok: false, reason: "missing-times_arr" };
  const times = (q.times_arr as unknown[]).filter(
    (e): e is TimeEntry => !!e && typeof e === "object" &&
      Number.isFinite((e as TimeEntry).t) && Number.isFinite((e as TimeEntry).mix),
  ).map((e) => ({ t: 1 * (e as TimeEntry).t, mix: Math.max(0, Math.floor(1 * (e as TimeEntry).mix)) }));
  const data = { ...(q as object), times_arr: times } as TimingPayload;
  return { ok: true, reason: "ok", data };
}

/** 页级缓存: 渲染尺寸变化或跨页时失效 */
const pageCache = new Map<string, PageAnalysis>();

export function clearPageCache(): void {
  pageCache.clear();
  witArr.length = 0;
}

/**
 * 页级分析封装: 渲染尺寸变化或跨页时缓存失效。
 * seln 语义同原版 opt.seln: >0 时只保留第 seln 个系统。
 */
export function analyzePage(
  canvas: HTMLCanvasElement,
  pageNumber: number,
  seln: number = 0,
  docId: string = "",
): PageAnalysis {
  const homrGateOn = getHomrGate() !== null;
  const key = docId + "_" + pageNumber + "_" + canvas.width + "x" + canvas.height + "_v" + ALGO_VERSION + "_" +
    [legacyOpt.seln, legacyOpt.skipn, legacyOpt.zwgrens, legacyOpt.drmpl,
      legacyOpt.drmpl2, legacyOpt.mtdrmpl, legacyOpt.voorna, legacyOpt.dx,
      legacyOpt.sysprf, legacyOpt.onestf, legacyOpt.eerst,
      legacyOpt.cropx, legacyOpt.pagewd, legacyOpt.hd, legacyOpt.deskew,
      legacyOpt.notemask, legacyOpt.widrescue, legacyOpt.homrgate,
      homrGateOn ? "hg1" : "hg0"].join(",");
  const hit = pageCache.get(key);
  if (hit) return hit;

  legacyOpt.seln = seln;
  setSkipn(parseInt(String(legacyOpt.skipn), 10) || 0);

  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const r: CountPixResult = countPix(canvas, seln);
  // HoMR 音符模板门(有门数据且 homrgate 开时): veto 符干, 只否决不新增
  const gated = homrGateOn && legacyOpt.homrgate
    ? applyHomrGate(r.cxs, r.bxs, pageNumber, canvas.width)
    : r.bxs;
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const conf = lastSystemConfidence.slice();
  while (conf.length < r.cxs.length) conf.push(0.35);
  const out: PageAnalysis = {
    systems: r.cxs,
    bars: gated,
    spatium: getSpatium(),
    annotFontPx: getAnnotFontPx(),
    pageW: canvas.width,
    pageH: canvas.height,
    pageNumber,
    algoVersion: ALGO_VERSION,
    confidence: conf.slice(0, r.cxs.length),
    diagnostics: lastBarDiagnostics.slice(),
    elapsedMs: Math.round((t1 - t0) * 10) / 10,
  };
  pageCache.set(key, out);
  return out;
}
