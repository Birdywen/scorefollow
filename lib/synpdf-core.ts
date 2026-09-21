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
  setSkipn,
  setSysprf,
  getSpatium,
  getAnnotFontPx,
} from "./synpdf-legacy";
import type { SynpdfOpt, SystemInfo, CountPixResult } from "./synpdf-legacy";

export type { SynpdfOpt, SystemInfo, CountPixResult };
export {
  legacyOpt as opt,
  witArr,
  countPix,
  setSkipn,
  setSysprf,
  getSpatium,
  getAnnotFontPx,
};

export interface PageAnalysis {
  systems: SystemInfo[];
  bars: number[][];
  spatium: number;
  annotFontPx: number;
  pageW: number;
  pageH: number;
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
): PageAnalysis {
  const key = pageNumber + "_" + canvas.width + "x" + canvas.height;
  const hit = pageCache.get(key);
  if (hit) return hit;

  legacyOpt.seln = seln;
  setSkipn(parseInt(String(legacyOpt.skipn), 10) || 0);

  const r: CountPixResult = countPix(canvas, seln);
  const out: PageAnalysis = {
    systems: r.cxs,
    bars: r.bxs,
    spatium: getSpatium(),
    annotFontPx: getAnnotFontPx(),
    pageW: canvas.width,
    pageH: canvas.height,
  };
  pageCache.set(key, out);
  return out;
}
