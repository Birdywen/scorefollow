/**
 * synpdf-legacy.ts — synpdf rev.194 像素分析层的 TypeScript 移植
 *
 * 衍生自 Wim Vree 的 synpdf.js rev.194 (https://wim.vree.org/js2/)
 * 原作品版权 (c) Willem Vree 2015-2023, 以 GPL-2.0-or-later 发布。
 * 本文件为其衍生作品, 同样以 GPL-2.0-or-later 发布。
 *
 * 核心思想(零预处理, 纯像素): 水平投影找谱线成五线谱行(drawRes),
 * 行组间空隙聚类成系统(countVsys), 竖向暗贯穿全谱高且上下不越线者
 * 为小线、越线者为符干需排除(findBarLines)。
 *
 * 本模块持有全部可变状态; synpdf-core.ts 做类型 + analyzePage 封装,
 * app/page.tsx 的 advanced 面板通过下面的 setter 调参。
 */

export interface SynpdfOpt {
  speed: number; no_menu: number; btns: number; spdctl: number; cropx: number;
  drmpl: number; pagewd: number; synbox: number; wpdf: number; lncsr: number;
  nomed: number; noplyr: number; nodash: number; skipn: number; drmpl2: number;
  seln: number; delay: number; ipaddr: string; mstr: number; bpmsr: string;
  loop: number; annot: number; zwgrens: number; voorna: number; mtdrmpl: number;
  dx: number; fscr: number; pagenum: number; playbtn: number; mmin: string;
  fixwd: number; lastSynced: number; eerst: number; sysprf: number; onestf: number;
}

export interface SysXs { x1: number; x2: number; }
export interface SystemInfo { cs: number[]; xs: SysXs; }
export interface CountPixResult { cxs: SystemInfo[]; bxs: number[][]; }

/** 原版 rev.194 opt_default 逐字段默认值 */
export const legacyOpt: SynpdfOpt = {
  speed: 1, no_menu: 0, btns: 1, spdctl: 1, cropx: 0, drmpl: 0.4, pagewd: 1000,
  synbox: 0, wpdf: 1, lncsr: 0, nomed: 0, noplyr: 0, nodash: 0, skipn: 0,
  drmpl2: 2, seln: 0, delay: 0, ipaddr: "", mstr: 0, bpmsr: "4-20-1", loop: 0,
  annot: 0, zwgrens: 0.7, voorna: 0.9, mtdrmpl: 0.8, dx: 3, fscr: 0, pagenum: 1,
  playbtn: 0, mmin: "", fixwd: 1000, lastSynced: -2, eerst: 0, sysprf: 0, onestf: 0,
};

/** 算法版本号: 缓存键与 timing 校验共用, 改动识别逻辑时递增 */
export const ALGO_VERSION = 2;
/** 模块状态: 每系统亮度阈值数组(drawRes 写, countVsys/findBarLines 读) */
export const witArr: number[] = [];
/** 谱线间距(drawRes 内计算, findBarLines 依赖) */
export let spatium = 0;
/** 最近一次 findBarLines 的逐候选诊断(供 core 组装 confidence/覆盖层) */
export interface BarDiagnostic {
  system: number; x: number; strength: number; rel: number;
  kept: boolean; reason: string;
}
export const lastBarDiagnostics: BarDiagnostic[] = [];
/** 最近一次每系统的置信度(0..1), 与 cxs 等长 */
export const lastSystemConfidence: number[] = [];
/** 注释字号(原版 annot_fontpx, drawRes 内按谱距推导) */
export let annotFontPx = 32;
/** 跳过前 N 个系统(countVsys 后切除, 原版 opt.skipn 語義) */
export let skipnV = 0;
/** 系统聚类方向标志(原版内部布尔 sysprf, 与 opt.sysprf 联动) */
let sysprf = false;

export function getSpatium(): number { return spatium; }
export function getAnnotFontPx(): number { return annotFontPx; }
export function setSkipn(v: number): void { skipnV = v ? 1 * v : 0; }
export function setSysprf(v: number): void { sysprf = v ? true : false; legacyOpt.sysprf = v ? 1 : 0; }

function drawRes(a: any, b: any, c: any): any { function d(a: any, b: any): any { for (var c: any, d: any; 5 < a.length;)if (c = a.length - 1, d = a[1] - a[0], c = a[c] - a[c - 1], d > b + 1 || d < b - 1)a.shift(); else if (c > b + 1 || c < b - 1)a.pop(); else break; a[a.length - 1] - a[0] < 2 * b && (a = []); return a } a = function (a: any): any { var b: any, c = a[0], d = 0, e = 0, f = 0, h = 0, m: any[] = []; a.push(a[a.length - 1] - 2); for (b = 0; b < a.length; b++) { var u = a[b]; var q = u - c; 1 > q && -1 < q || (0 < q ? q > d && (d = q, f = b) : (0 == d && q < e && (e = q, h = b), 0 < d && (-e > d && (d = -e), m.push({ y: f, t: d, d: f - h }), d = 0, e = q, f = h = b)), c = u) } return m }(a); var e = a.map(function (a: any) { return a.t }).sort(function (a: any, b: any) { return b - a }).slice(0, 10).reduce(function (a: any, b: any) { return a + b }, 0) / 10 * legacyOpt.drmpl; a = a.filter(function (a: any) { return a.t >= e }); b = function (a: any, b: any): any { var c = 0, d: any = {}; for (b = 0; b < a.length; ++b) { var e = a[b].y; c = e - c; d[c] = (d[c] || 0) + 1; c = e } a = Object.keys(d).sort(function (a: any, b: any) { return d[b] - d[a] }); return parseInt(a[0]) }(a, b); annotFontPx = 4 * b; spatium = b; b = function (a: any, b: any): any { var c = 4, e: any, f = a[0].y, g: any[] = [], h = [f]; for (e = 1; e < a.length; ++e) { var m = a[e].y; if (m - f <= c * b + 2) switch (h.push(m), h.length) { case 1: break; case 2: c = 3; break; case 3: c = 2; break; default: c = 1 } else h = d(h, b), h.length && g.push(h), c = 3, h = [m]; f = m } h = d(h, b); h.length && g.push(d(h, b)); return g }(a, b); b.map(function (a: any) { return a.reduce(function (a: any, b: any) { return a + b }) / a.length }); return b }

export function countPix(a: any, b: number): CountPixResult { var c: any, d: any, e: any; var f: any = a.width; var g = 4 * f; var k = a.height; a = d = a.getContext("2d").getImageData(0, 0, f, k).data; var l = 0; var p: any = []; var n = 3 * g / 4, h = g; legacyOpt.eerst && (n = 0, h = g / 4); for (e = 0; e < k; e++) { var m = 0; for (c = l + n; c < l + h; c += 4)m += d[c], m += d[c + 1], m += d[c + 2]; c = m / (3 * (h - n)); p.push(c); l += g } f = drawRes(p, f, k); for (f = countVsys(f, g, a); f.length && skipnV;)f.shift(), --skipnV; b && (f = f.slice(b - 1, b)); const foundBars = findBarLines(f, g, a); return { cxs: f, bxs: foundBars } }

function countVsys(a: any, b: any, c: any): any { var d: any, e: any, f: any, g: any = [], k: any = [], l: any = []; for (f = 0; f < a.length; ++f) { var p = a[f][0]; var n: any = a[f][a[f].length - 1]; var h: any = []; for (d = 0; d < b; d += 4) { var m = 0; for (e = p * b + d; e < n * b + d; e += b)m += c[e], m += c[e + 1], m += c[e + 2]; h.push(m / (3 * (n - p))) } for (d = m = 0; d < h.length; ++d)h[d] > m && (m = h[d]); witArr[f] = m * legacyOpt.zwgrens; d = Math.floor(h.length / 2); e = d + d / 2; for (p = 0; d < e; d++)n = h[d], n > m - 10 && (p += 1); if (!(5 < p) || legacyOpt.eerst) { g.push(a[f]); n = []; for (d = 0; d < h.length;)if (h[d] > m - 15)d += 1; else { for (e = d; d < h.length && h[d] <= m - 5;)d += 1; n.push([e, d - 1]) } n.sort(function (a: any, b: any) { return b[1] - b[0] - (a[1] - a[0]) }); h = n[0][0]; d = n[0][1]; l.push({ x1: h, x2: d }) } } a = g; g = []; if (0 == a.length) return a; for (f = 0; f < a.length - 1; ++f) { n = a[f][a[f].length - 1]; p = a[f + 1][0]; h = []; for (d = 0; d < b; d += 4) { m = 0; for (e = n * b + d; e < p * b + d; e += b)m += c[e], m += c[e + 1], m += c[e + 2]; h.push(m / (3 * (p - n))) } e = h[0]; for (d = m = 0; d < h.length; d++)n = h[d], e = Math.abs(n - e), 10 < e && e > m && (m = e), e = n; 0 < m && k.push(m) } const gaps: number[] = (k as number[]).slice().sort(function (x: number, y: number) { return x - y });
  if (!gaps.length) { for (let fi = 0; fi < a.length; ++fi) g.push({ cs: a[fi], xs: l[fi] }); return g; }
  let lowMean = gaps[0];
  let highMean = gaps[gaps.length - 1];
  let low: number[] = [lowMean];
  let high: number[] = [highMean];
  const ordered = sysprf ? gaps.slice().reverse() : gaps;
  for (let mi = 1; mi < ordered.length - 1; ++mi) {
    const gap = ordered[mi];
    if (gap - lowMean > highMean - gap) high.push(gap); else low.push(gap);
    lowMean = low.reduce(function (s: number, v: number) { return s + v }, 0) / low.length;
    highMean = high.reduce(function (s: number, v: number) { return s + v }, 0) / high.length;
  }
  const merge = highMean > legacyOpt.drmpl2 * lowMean && 5 * high.length > low.length && !legacyOpt.onestf;
  for (let fi = 0; fi < a.length - 1; ++fi) {
    const gap = (k as number[])[fi];
    const closerHigh = gap - lowMean > highMean - gap ? 1 : 0;
    if (((merge ? 1 : 0) & closerHigh) || 0 == legacyOpt.drmpl2) a[fi + 1] = (a[fi] as any[]).concat(a[fi + 1]);
    else g.push({ cs: a[fi], xs: l[fi] });
  }
  g.push({ cs: a[a.length - 1], xs: l[a.length - 1] });
  return g }

/** 纯函数: 非极大抑制, 半径按 spatium 比例, 强双线对予以保留 */
export function nmsBarPeaks(
  peaks: { x: number; rel: number }[],
  spatiumPx: number,
): { x: number; rel: number }[] {
  const sp = Math.max(1, spatiumPx || 8);
  const radius = Math.max(2, Math.round(sp * 0.6));
  const dblGap = sp * 0.7;
  const byStrength = peaks.slice().sort((p1, p2) => p2.rel - p1.rel);
  const kept: { x: number; rel: number }[] = [];
  for (const p of byStrength) {
    let suppressed = false;
    for (const k of kept) {
      const dist = Math.abs(p.x - k.x);
      if (dist < radius) {
        // 双线/终止线: 两者都很强且间距达到 0.7 spatium 则同时保留
        const bothStrong = p.rel >= 0.85 && k.rel >= 0.85;
        if (!(bothStrong && dist >= dblGap)) { suppressed = true; break; }
      }
    }
    if (!suppressed) kept.push(p);
  }
  return kept.sort((p1, p2) => p1.x - p2.x);
}

/** 纯函数: 系统置信度(内部候选中位强度 0.5 + 间距规则度 0.3 + 数量合理性 0.2) */
export function scoreSystemConfidence(
  keptInternal: { x: number; rel: number }[],
  spatiumPx: number,
): number {
  if (!keptInternal.length) return 0.35;
  const sp = Math.max(1, spatiumPx || 8);
  const rels = keptInternal.map((p) => p.rel).sort((x, y) => x - y);
  const median = rels[Math.floor(rels.length / 2)] ?? 0;
  const strengthScore = Math.max(0, Math.min(1, median));
  let regularity = 1;
  if (keptInternal.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < keptInternal.length; i++) gaps.push(keptInternal[i].x - keptInternal[i - 1].x);
    const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    const variance = gaps.reduce((s, v) => s + (v - mean) * (v - mean), 0) / gaps.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
    regularity = Math.max(0, Math.min(1, 1 - cv));
    // 过密/过疏直接降权(符干误检或漏检的典型症状)
    if (mean < 2 * sp || mean > 40 * sp) regularity *= 0.5;
  }
  const countScore = keptInternal.length >= 1 && keptInternal.length <= 32 ? 1 : 0.5;
  return Math.round((0.5 * strengthScore + 0.3 * regularity + 0.2 * countScore) * 100) / 100;
}

function findBarLines(a: any, b: any, c: any): any { var d: any, e: any, f: any, g: any, k = legacyOpt.mtdrmpl, l = legacyOpt.voorna, p = 1 * legacyOpt.dx, n = 2 * spatium, h: any[] = []; lastBarDiagnostics.length = 0; lastSystemConfidence.length = 0; for (d = 0; d < a.length; ++d) { var m = 3 * witArr[d]; var u = a[d].xs; var q = u.x1 + 50; var v = u.x2 - 20; q >= v && (q = u.x1, v = u.x2); var r = a[d].cs; var w = r[0]; var t = r[r.length - 1]; var C = (w - n) * b; var z = w * b; var A = t * b; var D = (t + n) * b; r = []; var y: any = []; for (f = 0; f < b; f += 4) { var B = e = 0; for (g = C + f; g < z + f; g += b) { var x = c[g] + c[g + 1] + c[g + 2]; e += x } for (g = z + f; g < A + f; g += b) { x = c[g] + c[g + 1] + c[g + 2]; var E = c[g + 4] + c[g + 5] + c[g + 6]; B += Math.min(x, E) < m ? 1 : 0; e += x } for (g = A + f; g < D + f; g += b)x = c[g] + c[g + 1] + c[g + 2], e += x; r.push(e / (3 * (t - w + 2 * n))); y.push(B) } f = y.slice(q, v); f.sort(function (a: any, b: any) { return b - a }); m = f[0]; t = w = 0; for (f = q; f < v; f++)q = y[f], q > m * k && (r[f - p] > w && (w = r[f - p]), r[f + p] > t && (t = r[f + p])); var cands: { x: number; rel: number }[] = []; for (f = 5; f < r.length - 5; f++) { var yy = y[f]; if (!(yy > m * k)) continue; if (!(r[f - p] > w * l && r[f + p] > t * l)) continue; cands.push({ x: f, rel: m > 0 ? yy / m : 0 }); } var keptNms = nmsBarPeaks(cands, spatium); var minGap = 3 * spatium; var dblGap = Math.max(2, spatium * 0.7); var kept: number[] = []; var keptRel: { x: number; rel: number }[] = []; for (const cand of keptNms) { if (!kept.length) { kept.push(cand.x); keptRel.push(cand); continue; } var prevX = kept[kept.length - 1]; var prevRel = keptRel[keptRel.length - 1].rel; var gap = cand.x - prevX; var strongPair = cand.rel >= 0.85 && prevRel >= 0.85; var need = strongPair ? dblGap : minGap; if (gap >= need) { kept.push(cand.x); keptRel.push(cand); } else if (cand.rel > prevRel + 0.05) { kept[kept.length - 1] = cand.x; keptRel[keptRel.length - 1] = cand; } } for (const cd of cands) { var isKept = kept.indexOf(cd.x) >= 0; lastBarDiagnostics.push({ system: d, x: cd.x, strength: cd.rel, rel: Math.round(cd.rel * 100) / 100, kept: isKept, reason: isKept ? "kept" : "suppressed-by-nms-or-gap" }); } var conf = scoreSystemConfidence(keptRel, spatium); lastSystemConfidence.push(conf); e = [u.x1]; v = e[0]; for (const kx of kept) { if (kx > u.x1 + 2 && kx < u.x2 - 2) { e.push(kx); v = kx; } } if (u.x2 - v > 3 * spatium || e.length === 1) e.push(u.x2); h.push(e) } return h }
