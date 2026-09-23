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
export const ALGO_VERSION = 17;
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
/** 最近一次 findBarLines 的输入(供 barColumnDebug 诊断, 不参与识别) */
let lastEB_A: any = null;
let lastEB_B = 0;
let lastEB_C: any = null;
/** 最近一次 drawRes 的行分组(供系统级诊断, 不参与识别) */
export const lastRowGroups: number[][] = [];
export const lastJoinDebug: { k: number[]; vgap: number[]; lowMean: number; highMean: number; mergeK: boolean; spatium: number } = { k: [], vgap: [], lowMean: 0, highMean: 0, mergeK: false, spatium: 0 };
export function getLastRowGroups(): number[][] { return lastRowGroups.map((g) => g.slice()); }
export function getLastJoinDebug() { return lastJoinDebug; }
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

function drawRes(a: any, b: any, c: any): any {
  if (!a || !a.length) { spatium = 8; annotFontPx = 32; return []; }
  function d(a: any, b: any): any { for (var c: any, d: any; 5 < a.length;)if (c = a.length - 1, d = a[1] - a[0], c = a[c] - a[c - 1], d > b + 1 || d < b - 1)a.shift(); else if (c > b + 1 || c < b - 1)a.pop(); else break; a[a.length - 1] - a[0] < 2 * b && (a = []); return a } a = function (a: any): any { var b: any, c = a[0], d = 0, e = 0, f = 0, h = 0, m: any[] = []; a.push(a[a.length - 1] - 2); for (b = 0; b < a.length; b++) { var u = a[b]; var q = u - c; 1 > q && -1 < q || (0 < q ? q > d && (d = q, f = b) : (0 == d && q < e && (e = q, h = b), 0 < d && (-e > d && (d = -e), m.push({ y: f, t: d, d: f - h }), d = 0, e = q, f = h = b)), c = u) } return m }(a); if (!a.length) { spatium = 8; annotFontPx = 32; return []; } var e = a.map(function (a: any) { return a.t }).sort(function (a: any, b: any) { return b - a }).slice(0, 10).reduce(function (a: any, b: any) { return a + b }, 0) / 10 * legacyOpt.drmpl; a = a.filter(function (a: any) { return a.t >= e }); if (!a.length) { spatium = 8; annotFontPx = 32; return []; } b = function (a: any, b: any): any { var c = 0, d: any = {}; for (b = 0; b < a.length; ++b) { var e = a[b].y; c = e - c; d[c] = (d[c] || 0) + 1; c = e } a = Object.keys(d).sort(function (a: any, b: any) { return d[b] - d[a] }); return parseInt(a[0]) }(a, b); annotFontPx = 4 * b; spatium = b; b = function (a: any, b: any): any { if (!a || !a.length) return []; var c = 4, e: any, f = a[0].y, g: any[] = [], h = [f]; for (e = 1; e < a.length; ++e) { var m = a[e].y; if (m - f <= c * b + 2) switch (h.push(m), h.length) { case 1: break; case 2: c = 3; break; case 3: c = 2; break; default: c = 1 } else h = d(h, b), h.length && g.push(h), c = 3, h = [m]; f = m } h = d(h, b); h.length && g.push(d(h, b)); return g }(a, b); b.map(function (a: any) { return a.reduce(function (a: any, b: any) { return a + b }) / a.length }); return b }

export function countPix(a: any, b: number): CountPixResult { const w: any = a.width; const hgt: any = a.height; const data = a.getContext("2d").getImageData(0, 0, w, hgt).data; return countPixFromBuffer(w, hgt, data, b) }

/**
 * 无头像素输入: 与 countPix 同一流水线(drawRes→countVsys→findBarLines),
 * 供 Node 合成谱回归直接喂 RGBA 缓冲, 行为与 canvas 输入逐行一致。
 */
export function countPixFromBuffer(w: number, h: number, data: Uint8ClampedArray | number[], seln: number): CountPixResult { var c: any, e: any; var f: any = w; var g = 4 * f; var k = h; var a: any = data; var l = 0; var p: any = []; var n = 3 * g / 4, stride = g; legacyOpt.eerst && (n = 0, stride = g / 4); for (e = 0; e < k; e++) { var m = 0; for (c = l + n; c < l + stride; c += 4)m += a[c], m += a[c + 1], m += a[c + 2]; c = m / (3 * (stride - n)); p.push(c); l += g } f = drawRes(p, f, k); lastRowGroups.length = 0; for (const gg of (f as number[][])) lastRowGroups.push((gg as number[]).slice()); for (f = countVsys(f, g, a); f.length && skipnV;)f.shift(), --skipnV; seln && (f = f.slice(seln - 1, seln)); const foundBars = findBarLines(f, g, a); return { cxs: f, bxs: foundBars } }

function countVsys(a: any, b: any, c: any): any { var d: any, e: any, f: any, g: any = [], k: any = [], l: any = []; for (f = 0; f < a.length; ++f) { var p = a[f][0]; var n: any = a[f][a[f].length - 1]; var h: any = []; for (d = 0; d < b; d += 4) { var m = 0; for (e = p * b + d; e < n * b + d; e += b)m += c[e], m += c[e + 1], m += c[e + 2]; h.push(m / (3 * (n - p))) } for (d = m = 0; d < h.length; ++d)h[d] > m && (m = h[d]); witArr[f] = m * legacyOpt.zwgrens; d = Math.floor(h.length / 2); e = d + d / 2; for (p = 0; d < e; d++)n = h[d], n > m - 10 && (p += 1); var brightLimit = Math.max(5, Math.floor(h.length * 0.03)); if (!(brightLimit < p) || legacyOpt.eerst) { g.push(a[f]); n = []; for (d = 0; d < h.length;)if (h[d] > m - 15)d += 1; else { for (e = d; d < h.length && h[d] <= m - 5;)d += 1; n.push([e, d - 1]) } n.sort(function (a: any, b: any) { return b[1] - b[0] - (a[1] - a[0]) }); var wideRuns = n.filter(function (rg: any) { return rg[1] - rg[0] > 10 * spatium }); var spanRuns = wideRuns.length ? wideRuns : [n[0]]; h = spanRuns[0][0]; d = spanRuns[0][1]; for (var sri = 1; sri < spanRuns.length; sri++) { if (spanRuns[sri][0] < h) h = spanRuns[sri][0]; if (spanRuns[sri][1] > d) d = spanRuns[sri][1]; } l.push({ x1: h, x2: d }) } } a = g; g = []; if (0 == a.length) return a; for (f = 0; f < a.length - 1; ++f) { n = a[f][a[f].length - 1]; p = a[f + 1][0]; h = []; for (d = 0; d < b; d += 4) { m = 0; for (e = n * b + d; e < p * b + d; e += b)m += c[e], m += c[e + 1], m += c[e + 2]; h.push(m / (3 * (p - n))) } e = h[0]; for (d = m = 0; d < h.length; d++)n = h[d], e = Math.abs(n - e), 10 < e && e > m && (m = e), e = n;     k.push(m) } const gaps: number[] = (k as number[]).slice().sort(function (x: number, y: number) { return x - y });
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
  const verticalGaps: number[] = [];
  for (let vi = 0; vi < a.length - 1; vi++) verticalGaps.push(a[vi + 1][0] - a[vi][a[vi].length - 1]);
  const merge = highMean > legacyOpt.drmpl2 * lowMean && 5 * high.length > low.length && !legacyOpt.onestf;
  lastJoinDebug.k = (k as number[]).slice();
  lastJoinDebug.vgap = verticalGaps.slice();
  lastJoinDebug.lowMean = lowMean;
  lastJoinDebug.highMean = highMean;
  lastJoinDebug.mergeK = merge;
  lastJoinDebug.spatium = spatium;
  const minBrace = 8 * Math.max(1, spatium);
  const staffGap = 8 * Math.max(1, spatium);
  for (let fi = 0; fi < a.length - 1; ++fi) {
    const kv = (k as number[])[fi] || 0;
    const closerHigh = kv - lowMean > highMean - kv ? 1 : 0;
    const byK = merge && closerHigh && kv >= minBrace;
    // byV 设防(v17.4): 小间隙+强边缘即并带, 会把单谱表上下两行并成一带
    // (No.19 m.24/m.28: vgap 58px=7.25sp + kv 76 合并, 后续小节全错位)。
    // 真大谱表并带走 byK(k 均值聚类, merge=true); byV 只在 merge 或带数 ≤3 时放行
    // (单/双系统页保持原行为,  Toccatta/secret_garden 大谱表 merge=true 不受影响)。
    const byV = !legacyOpt.onestf && (merge || a.length <= 3) && verticalGaps[fi] <= staffGap && kv >= minBrace;
    if (byK || byV || 0 == legacyOpt.drmpl2) a[fi + 1] = (a[fi] as any[]).concat(a[fi + 1]);
    else g.push({ cs: a[fi], xs: l[fi] });
  }
  g.push({ cs: a[a.length - 1], xs: l[a.length - 1] });
  return g }

/**
 * 纯函数: 非极大抑制, 半径按 spatium 比例, 强双线对予以保留。
 * 同簇等强 plateau 取中位数 x(线中心而非左缘): 相邻墨迹粘连时仍锁定小节线中心,
 * 且消除逐列扫描左偏好的系统性 -1px 偏差。
 */
export function nmsBarPeaks(
  peaks: { x: number; rel: number }[],
  spatiumPx: number,
): { x: number; rel: number }[] {
  const sp = Math.max(1, spatiumPx || 8);
  const radius = Math.max(2, Math.round(sp * 0.6));
  const dblGap = sp * 0.7;
  const byStrength = peaks.slice().sort((p1, p2) => p2.rel - p1.rel);
  const clusters: { x: number; rel: number }[][] = [];
  for (const p of byStrength) {
    let placed = false;
    for (const cl of clusters) {
      let near = false;
      let exempt = false;
      for (const k of cl) {
        const dist = Math.abs(p.x - k.x);
        if (dist >= radius) continue;
        near = true;
        // 双线/终止线: 两者都很强且间距达到 0.7 spatium 则分属两簇同时保留
        if (p.rel >= 0.85 && k.rel >= 0.85 && dist >= dblGap) exempt = true;
        break;
      }
      if (near && !exempt) { cl.push(p); placed = true; break; }
    }
    if (!placed) clusters.push([p]);
  }
  return clusters
    .map((cl) => {
      let rel = 0, lo = 1;
      for (const p of cl) { if (p.rel > rel) rel = p.rel; if (p.rel < lo) lo = p.rel; }
      if (rel - lo > 0.15) {
        // 强弱悬殊: 主峰 + 弱粘连, 取最强列(原左缘优先行为, 保底)
        for (const p of cl) if (p.rel === rel) return { x: p.x, rel };
      }
      const xs = cl.map((p) => p.x).sort((a, b) => a - b);
      const mid = xs.length % 2
        ? xs[(xs.length - 1) / 2]
        : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
      return { x: mid, rel };
    })
    .sort((p1, p2) => p1.x - p2.x);
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

/**
 * 列证据扫描(原 findBarLines 内层循环逐字抽取, 行为一致):
 * ys[x]=系统纵贯暗像素计数, rs[x]=含上下边距的列平均亮度。
 */
function columnEvidence(csRows: number[], darkSum: number, stride: number, pix: any, margin: number): { ys: number[]; rs: number[] } {
  var f: any, g: any, e: any;
  var w0 = csRows[0]; var t0 = csRows[csRows.length - 1];
  var C = (w0 - margin) * stride; var z = w0 * stride; var A = t0 * stride; var D = (t0 + margin) * stride;
  var r: number[] = []; var y: number[] = [];
  for (f = 0; f < stride; f += 4) { var B = e = 0; for (g = C + f; g < z + f; g += stride) { var x = pix[g] + pix[g + 1] + pix[g + 2]; e += x } for (g = z + f; g < A + f; g += stride) { x = pix[g] + pix[g + 1] + pix[g + 2]; var E = pix[g + 4] + pix[g + 5] + pix[g + 6]; B += Math.min(x, E) < darkSum ? 1 : 0; e += x } for (g = A + f; g < D + f; g += stride)x = pix[g] + pix[g + 1] + pix[g + 2], e += x; r.push(e / (3 * (t0 - w0 + 2 * margin))); y.push(B) }
  return { ys: y, rs: r };
}

export interface BarColumnDebug {
  x: number; q: number; v: number;
  y: number; rel: number; m: number;
  rLeft: number; rRight: number; wThr: number; tThr: number;
  passStrength: boolean; passContrast: boolean;
  longestRun: number; runRatio: number; sysH: number;
}

/**
 * 诊断某系统某列未被选中的确切原因(只读, 不影响识别)。
 * longestRun/runRatio 区分直小节线(≈1)与弧形琴架(≈0.3-0.5)。
 */
/** 单列最长连续暗游程/系统高(直度): 小节线≈1, 琴架弧线≈0.3, 短符干<0.7 */
export function columnRunRatio(col: number, w0: number, t0: number, stride: number, pix: any, darkSum: number): number {
  let run = 0, best = 0;
  for (let row = w0; row <= t0; row++) {
    const g = row * stride + col * 4;
    const s0 = pix[g] + pix[g + 1] + pix[g + 2];
    const s1 = pix[g + 4] + pix[g + 5] + pix[g + 6];
    if (Math.min(s0, s1) < darkSum) { run++; if (run > best) best = run; }
    else run = 0;
  }
  return best / Math.max(1, t0 - w0 + 1);
}

export function barColumnDebug(sysIdx: number, x: number): BarColumnDebug | null {
  if (!lastEB_A || sysIdx < 0 || sysIdx >= lastEB_A.length) return null;
  const sys = lastEB_A[sysIdx];
  const stride: number = lastEB_B; const pix: any = lastEB_C;
  const darkSum = 3 * witArr[sysIdx]; const margin = 2 * spatium;
  const k = legacyOpt.mtdrmpl, l = legacyOpt.voorna, p = 1 * legacyOpt.dx;
  const ev = columnEvidence(sys.cs, darkSum, stride, pix, margin);
  const ys = ev.ys, rs = ev.rs;
  let q = sys.xs.x1 + 50; let v = sys.xs.x2 - 20;
  if (q >= v) { q = sys.xs.x1; v = sys.xs.x2; }
  let m = 0;
  for (let f = q; f < v && f < ys.length; f++) if (ys[f] > m) m = ys[f];
  let w = 0, t = 0;
  for (let f = q; f < v && f < ys.length; f++) {
    const yy = ys[f];
    if (yy > m * k) {
      if (rs[f - p] > w) w = rs[f - p];
      if (rs[f + p] > t) t = rs[f + p];
    }
  }
  const xi = Math.max(0, Math.min(ys.length - 1, x));
  const w0 = sys.cs[0]; const t0 = sys.cs[sys.cs.length - 1];
  let run = 0, best = 0;
  for (let row = w0; row <= t0; row++) {
    const g = row * stride + xi * 4;
    const s0 = pix[g] + pix[g + 1] + pix[g + 2];
    const s1 = pix[g + 4] + pix[g + 5] + pix[g + 6];
    if (Math.min(s0, s1) < darkSum) { run++; if (run > best) best = run; }
    else run = 0;
  }
  const sysH = t0 - w0 + 1;
  return {
    x: xi, q, v,
    y: ys[xi], rel: m > 0 ? Math.round((ys[xi] / m) * 1000) / 1000 : 0, m,
    rLeft: rs[xi - p], rRight: rs[xi + p],
    wThr: Math.round(w * l * 10) / 10, tThr: Math.round(t * l * 10) / 10,
    passStrength: ys[xi] > m * k,
    passContrast: rs[xi - p] > w * l && rs[xi + p] > t * l,
    longestRun: best, runRatio: Math.round((best / sysH) * 1000) / 1000, sysH,
  };
}

export interface BarStemFeatures {
  x: number; runRatio: number;
  topBlob: number; botBlob: number; midWidth: number;
  neighbors: number; strength: number; noteheadProximity: number;
  headSegs: { y: number; h: number; w: number }[];
  twinDist: number; twinRel: number; extAbove: number; beamAbove: number; beamBelow: number;
}

/** 只读: 茎干判别特征(符干必带符头/符梁附着 + 成束出现, 小节线孤独)。
 *  top/botBlob=上下端带内最大连续暗宽, midWidth=中段暗宽, neighbors=±spatium 内强垂直列数。 */
let lastFeatEv: { sys: any; m: number; ys: number[] } | null = null;

export function barStemFeatures(sysIdx: number, x: number): BarStemFeatures | null {
  if (!lastEB_A || sysIdx < 0 || sysIdx >= lastEB_A.length) return null;
  const sys = lastEB_A[sysIdx];
  const stride: number = lastEB_B; const pix: any = lastEB_C;
  const darkSum = 3 * witArr[sysIdx];
  const w0 = sys.cs[0]; const t0 = sys.cs[sys.cs.length - 1];
  const H = Math.max(1, t0 - w0 + 1);
  const xi = Math.max(8, Math.min(stride / 4 - 9, Math.round(x)));
  const darkAt = (row: number, col: number): boolean => {
    const g = row * stride + col * 4;
    const s0 = pix[g] + pix[g + 1] + pix[g + 2];
    const s1 = pix[g + 4] + pix[g + 5] + pix[g + 6];
    return Math.min(s0, s1) < darkSum;
  };
  const bandWidth = (r1: number, r2: number): number => {
    // 谱线行整行皆黑(离群), 取中位数得真实杆宽: 小节线≈2-3, 符头≈7-9, 符梁更大
    const ws: number[] = [];
    for (let row = r1; row <= r2; row++) {
      if (!darkAt(row, xi)) continue;
      let lo = xi, hi = xi;
      while (lo - 1 >= xi - 10 && darkAt(row, lo - 1)) lo--;
      while (hi + 1 <= xi + 10 && darkAt(row, hi + 1)) hi++;
      ws.push(hi - lo + 1);
    }
    if (!ws.length) return 0;
    ws.sort((a, b) => a - b);
    return ws[Math.floor(ws.length / 2)];
  };
  const band = Math.max(2, Math.round(H * 0.2));
  let run = 0, best = 0, bestR1 = w0, bestR2 = w0;
  for (let row = w0; row <= t0; row++) {
    if (darkAt(row, xi)) {
      if (!run) run = 1, bestR1 = row;
      else run++;
      if (run > best) { best = run; bestR2 = row; }
    } else run = 0;
  }
  // 符干游程终结于符头/符梁(端点多宽行); 真线游程终结于干净处(端点仅谱线行宽)。
  // 8 行窗 + 宽行总数: 谱线最多贡献 2 行, 符头 5-8 行, 符梁 3-4 行, 双梁 2+2 行。
  const sp = Math.max(1, spatium);
  // head 扫描上延 3*sp: 上行符干的符头常在谱表框之上(bestR1=w0 处截断)。
  // 下方不延(歌词区黑块多, 易误伤)。rowWidth/blob 共用此上界, blob 窗仍限谱表内。
  const headTopLim = Math.max(0, w0 - 3 * sp);
  const headBotLim = Math.min(Math.floor(pix.length / stride) - 1, t0 + 3 * sp);
  const wideThr = Math.max(5, Math.round(sp * 0.7));
  const rowWidth = (row: number): number => {
    if (row < headTopLim || row > headBotLim) return 0;
    // NMS 峰列可偏符干中心 1-2px(侧面连符头时偏右缘列测不到符头), 取 3 列最大宽。
    // 5 列已验证不可行: Le Reve FN+19(邻音符头被扫入, v17 回退)。
    let best = 0;
    for (let c = xi - 1; c <= xi + 1; c++) {
      if (!darkAt(row, c)) continue;
      let lo = c, hi = c;
      while (lo - 1 >= c - 10 && darkAt(row, lo - 1)) lo--;
      while (hi + 1 <= c + 10 && darkAt(row, hi + 1)) hi++;
      if (hi - lo + 1 > best) best = hi - lo + 1;
    }
    return best;
  };
  const wideRows = (r1: number, r2: number): number => {
    let n = 0;
    for (let row = Math.max(w0, r1); row <= Math.min(t0, r2); row++)
      if (rowWidth(row) >= wideThr) n++;
    return n;
  };
  const endTop = wideRows(bestR1 - 2, bestR1 + 5);
  const endBot = wideRows(bestR2 - 5, bestR2 + 2);
  // 符头相接: 符干必连符头(与杆连通的符头级宽段, 高 4~12 行), 小节线永不相接。
  // 行宽以 xi±1 三列为中心向两侧扩展, 中间有 1px 白缝即断开 → 紧贴不算相接。
  // 跳过谱线行但不断段(符头常横跨谱线)。梁行(>2*sp)排除在外, 只认符头级宽度。
  // 扫描上延 3*sp(上行符干符头在谱表框之上); 紧贴粘连高仅 2-3 行, 高度过滤。
  const isStaffRow = (row: number): boolean =>
    sys.cs.some((y: number) => Math.abs(y - row) <= 1);
  const headLo = Math.max(5, Math.round(sp * 0.7));
  // headHi 放宽到 2*sp+4: 并排和弦符头可宽至 16(实测 @591), 梁(20+)仍排除。
  const headHi = Math.max(headLo + 1, 2 * sp + 4);
  // 谱上延伸墨(符头/符梁在谱表框之上): 下行符干头在上、符梁悬空, 谱表内端部干净
  // (sonata-no3 小提琴独奏 @155/379/462/875/920 实测 extAbove 4-8, 真线全 ≤1)。
  // 谱表线/延音线仅 1-2 行、和弦记号笔画多 <headLo 宽, 以连续 headLo 级宽行 ≥3 判定。
  let extAbove = 0, extRun = 0;
  for (let row = Math.max(0, Math.round(w0 - 2 * sp)); row < w0; row++) {
    if (rowWidth(row) >= headLo) { extRun++; if (extRun > extAbove) extAbove = extRun; }
    else extRun = 0;
  }
  // 横梁(谱外符梁): 连在杆上的长水平墨(宽 ≥15), 真线谱外只有连音线/力度记号
  // (细 <15 或不足 3 行)。sonata-no3 符干 beamA 3-8/beamB 4, 真线 beamA ≤1/beamB ≤1。
  const beamRun = (r1: number, r2: number): number => {
    let best = 0, run = 0;
    for (let row = Math.max(0, r1); row <= Math.min(Math.floor(pix.length / stride) - 1, r2); row++) {
      if (rowWidth(row) >= 15) { run++; if (run > best) best = run; }
      else run = 0;
    }
    return best;
  };
  const beamAbove = beamRun(Math.round(w0 - 3 * sp), w0 - 1);
  const beamBelow = beamRun(t0 + 1, Math.round(t0 + 3 * sp));
  let noteheadProximity = 0, headRun = 0, headY0 = 0, headW: number[] = [];
  const headSegs: { y: number; h: number; w: number }[] = [];
  const flushHead = (): void => {
    // 真符头高 4-8 行; 2-3 行是紧贴粘连/连音线交叉(实测 9 个 FN 误杀全落此区间), 不计。
    if (headRun >= 4 && headRun <= 12) {
      noteheadProximity++;
      headW.sort((a, b) => a - b);
      headSegs.push({ y: headY0, h: headRun, w: headW[Math.floor(headW.length / 2)] });
    }
    headRun = 0; headW = [];
  };
  for (let row = Math.max(headTopLim, bestR1 - 3 * sp); row <= Math.min(headBotLim, bestR2 + sp); row++) {
    // 谱线行跳过但不断段: 符头常横跨谱线, flush 会把它切成 2-3 行的粘连级小段。
    // 谱线带最多连续 4 行, 不会把两个独立段连起来(中间窄行仍 flush)。
    if (isStaffRow(row)) continue;
    const w = rowWidth(row);
    if (w >= headLo && w <= headHi) { if (!headRun) headY0 = row; headRun++; headW.push(w); }
    else flushHead();
  }
  flushHead();
  let evm: { m: number; ys: number[] };
  if (lastFeatEv && lastFeatEv.sys === sys) evm = lastFeatEv;
  else {
    const ev = columnEvidence(sys.cs, darkSum, stride, pix, 2 * spatium);
    let mm = 0;
    for (const v of ev.ys) if (v > mm) mm = v;
    evm = { m: mm, ys: ev.ys };
    lastFeatEv = { sys, m: mm, ys: ev.ys };
  }
  const m = evm.m; const ev = { ys: evm.ys };
  let neighbors = 0;
  for (let c = xi - sp; c <= xi + sp; c++) {
    if (c === xi || c < 0 || c >= ev.ys.length) continue;
    if (ev.ys[c] > m * 0.7) neighbors++;
  }
  // 升号双竖: 3..0.75*sp 内另一根强竖线. 反复/双小节线间距通常 >=0.7sp 且两根都很强.
  let twinDist = 0, twinRel = 0;
  const twinHi = Math.max(4, Math.round(0.75 * sp));
  for (let dist = 3; dist <= twinHi; dist++) {
    for (const c of [xi - dist, xi + dist]) {
      if (c < 0 || c >= ev.ys.length) continue;
      const rel = m > 0 ? ev.ys[c] / m : 0;
      if (rel >= 0.55 && rel > twinRel) { twinDist = dist; twinRel = Math.round(rel * 1000) / 1000; }
    }
  }
  return {
    x: xi, runRatio: Math.round((best / H) * 1000) / 1000,
    topBlob: endTop, botBlob: endBot,
    midWidth: bandWidth(w0 + band, t0 - band),
    neighbors, strength: m > 0 ? Math.round((ev.ys[xi] / m) * 1000) / 1000 : 0,
    noteheadProximity, headSegs, twinDist, twinRel, extAbove, beamAbove, beamBelow,
  };
}

/** 调试: 返回候选列 head 扫描窗内逐行 [row, width3col, staff?] 明细(行内无黑记为 -)。 */
export function debugBarColumn(sysIdx: number, x: number): { sp: number; w0: number; t0: number; rows: string } | null {
  const f = barStemFeatures(sysIdx, x);
  if (!f || !lastEB_A) return null;
  const sys = lastEB_A[sysIdx];
  const stride: number = lastEB_B; const pix: any = lastEB_C;
  const darkSum = 3 * witArr[sysIdx];
  const w0 = sys.cs[0]; const t0 = sys.cs[sys.cs.length - 1];
  const sp = Math.max(1, spatium);
  const xi = Math.max(8, Math.min(stride / 4 - 9, Math.round(x)));
  const darkAt = (row: number, col: number): boolean => {
    if (row < 0 || col < 0 || col >= stride / 4) return false;
    const g = row * stride + col * 4;
    if (g + 6 >= pix.length) return false;
    return Math.min(pix[g] + pix[g + 1] + pix[g + 2], pix[g + 4] + pix[g + 5] + pix[g + 6]) < darkSum;
  };
  const isStaff = (row: number): boolean => sys.cs.some((y: number) => Math.abs(y - row) <= 1);
  const top = Math.max(0, w0 - 3 * sp), bot = Math.min(Math.floor(pix.length / stride) - 1, t0 + sp);
  const out: string[] = [];
  for (let row = top; row <= bot; row++) {
    let best = -1;
    for (let c = xi - 1; c <= xi + 1; c++) {
      if (!darkAt(row, c)) continue;
      let lo = c, hi = c;
      while (lo - 1 >= c - 10 && darkAt(row, lo - 1)) lo--;
      while (hi + 1 <= c + 10 && darkAt(row, hi + 1)) hi++;
      if (hi - lo + 1 > best) best = hi - lo + 1;
    }
    if (best >= 5) out.push(`${row}:${best}${isStaff(row) ? "*" : ""}`);
  }
  return { sp, w0, t0, rows: out.join(" ") };
}

/** 否决判据(候选阶段 + NMS 后复核共用): NMS 中位数可把峰搬到 1-2px 外、
 * 落到否决区内的列上, 复核 catches 这类漏网。525 个 TP 在终检位置零命中(实测)。 */
export function barColumnVetoed(sysIdx: number, x: number, rw0: number, rt0: number): boolean {
  var sf0 = barStemFeatures(sysIdx, x);
  if (!sf0) return false;
  // v17 双线豁免: 强孪生竖线即双小节线的一半。孪生线落在 ±10px 特征窗内,
  // 会把 midWidth/blob/nh 全部污染(实测 Toccatta 8 处双线 mid=8~10、nh=1~8,
  // 全因此被规则 3/新纵贯规则误杀)。豁免后交由 NMS 归一为单线输出。
  // 三重收紧(实测 GT 上符干对混入 +9FP 后加): twinRel≥0.95(双线≈1.0, 符干对
  // 0.87~0.96)、runRatio≥0.97(双线全纵贯 0.983+, 符干对常缺一截)、远离谱表
  // 边缘 1.5sp(终线粗细对 GT 只计单线, 用户 Toccatta 校正也未动终线)。
  // 升号双竖(twinRel<0.65)不受影响, 仍走否决。
  if (sf0.twinDist > 0 && sf0.twinRel >= 0.95 && sf0.runRatio >= 0.97) {
    const xsa = lastEB_A && lastEB_A[sysIdx] ? lastEB_A[sysIdx].xs : null;
    const edge = Math.max(10, 1.5 * spatium);
    if (xsa && x - xsa.x1 >= edge && xsa.x2 - x >= edge) {
      // 孪生边也得直: 琴架两瓣互为强孪生但都是弧线(Toccatta 缩进系统琴架
      // 705 即此类)；真双线的两边都是全纵贯直线。查孪生列纵贯度。
      const darkSumT = 3 * (witArr[sysIdx] ?? 0);
      for (const s of [-1, 1]) {
        const c = x + s * sf0.twinDist;
        if (c < 0) continue;
        if (columnRunRatio(c, rw0, rt0, lastEB_B, lastEB_C, darkSumT) >= 0.9) return false;
      }
    }
  }
  var narrowSys = (rt0 - rw0 + 1) <= 6.5 * spatium;
  return ((Math.max(sf0.topBlob, sf0.botBlob) >= 4 && sf0.runRatio >= 0.8 && sf0.midWidth <= 5) ||
    (sf0.runRatio >= 0.9 && sf0.noteheadProximity >= 1) ||
    (sf0.runRatio >= 0.95 && sf0.noteheadProximity >= 1) ||
    (sf0.runRatio >= 0.6 && sf0.midWidth >= 6) ||
    (sf0.twinDist >= 4 && sf0.twinDist <= 6 && sf0.twinRel >= 0.55 && sf0.twinRel < 0.65) ||
    (sf0.runRatio >= 0.8 && sf0.noteheadProximity >= 1 && Math.max(sf0.topBlob, sf0.botBlob) >= 6) ||
    // extAbove(谱上延伸墨)全局否决已证伪: GT 上 26 个真线被邻音符头误杀
    // (自头/邻头单列不可分, v17.4), 保留字段供窄对仲裁等上下文规则参考。
    ((sf0.beamAbove >= 3 || sf0.beamBelow >= 4) && narrowSys) ||
    (narrowSys && sf0.runRatio < 0.95 && sf0.midWidth <= 2));
}

function findBarLines(a: any, b: any, c: any): any { lastEB_A = a; lastEB_B = b; lastEB_C = c; var d: any, e: any, f: any, g: any, k = legacyOpt.mtdrmpl, l = legacyOpt.voorna, p = 1 * legacyOpt.dx, n = 2 * spatium, h: any[] = []; lastBarDiagnostics.length = 0; lastSystemConfidence.length = 0; for (d = 0; d < a.length; ++d) { var m = 3 * witArr[d]; var u = a[d].xs; var q = u.x1 + 50; var v = u.x2 - 20; q >= v && (q = u.x1, v = u.x2); var r = a[d].cs; var w = r[0]; var t = r[r.length - 1]; var C = (w - n) * b; var z = w * b; var A = t * b; var D = (t + n) * b; var evd = columnEvidence(r, m, b, c, n); r = evd.rs; var y: any = evd.ys; f = y.slice(q, v); f.sort(function (a: any, b: any) { return b - a }); m = f[0]; t = w = 0; for (f = q; f < v; f++)q = y[f], q > m * k && (r[f - p] > w && (w = r[f - p]), r[f + p] > t && (t = r[f + p])); var cands: { x: number; rel: number; bypass: boolean; weak: boolean }[] = []; var csRows0: number[] = a[d].cs; var rw0 = csRows0[0]; var rt0 = csRows0[csRows0.length - 1]; var darkSum0 = 3 * witArr[d]; for (f = 5; f < r.length - 5; f++) { var yy = y[f]; var weakPeak = false; if (!(yy > m * k)) { if (r[f - p] > w * l && r[f + p] > t * l) { if (yy > m * 0.7 && columnRunRatio(f, rw0, rt0, b, c, darkSum0) >= 0.65) { weakPeak = true; var wLo = Math.max(5, f - Math.round(spatium)); var wHi = Math.min(r.length - 6, f + Math.round(spatium)); for (var wnb = wLo; wnb <= wHi; wnb++) { if (y[wnb] > yy) { weakPeak = false; break; } } if (weakPeak) { var wsf = barStemFeatures(d, f); if (!wsf || Math.max(wsf.topBlob, wsf.botBlob) >= 4) weakPeak = false; } } } if (!weakPeak) continue; } if (f - u.x1 < Math.max(80, 8 * spatium)) continue; var passC = r[f - p] > w * l && r[f + p] > t * l; var bypass = false; if (!passC) { if (columnRunRatio(f, rw0, rt0, b, c, darkSum0) < 0.9) continue; bypass = true; } var sf0 = barStemFeatures(d, f); if (barColumnVetoed(d, f, rw0, rt0)) continue; cands.push({ x: f, rel: m > 0 ? yy / m : 0, bypass, weak: weakPeak }); } var keptNms = nmsBarPeaks(cands, spatium); var minGap = 3 * spatium; var dblGap = Math.max(2, spatium * 0.7); var kept: number[] = []; var keptRel: { x: number; rel: number }[] = []; for (const cand of keptNms) { if (!kept.length) { kept.push(cand.x); keptRel.push(cand); continue; } var prevX = kept[kept.length - 1]; var prevRel = keptRel[keptRel.length - 1].rel; var gap = cand.x - prevX; var strongPair = cand.rel >= 0.85 && prevRel >= 0.85; var need = strongPair ? dblGap : minGap; if (gap >= need) { kept.push(cand.x); keptRel.push(cand); } else if (cand.rel > prevRel + 0.05) { kept[kept.length - 1] = cand.x; keptRel[keptRel.length - 1] = cand; } } var keptF: number[] = []; var keptRelF: { x: number; rel: number }[] = []; for (var kfi = 0; kfi < kept.length; kfi++) { if (!barColumnVetoed(d, kept[kfi], rw0, rt0)) { keptF.push(kept[kfi]); keptRelF.push(keptRel[kfi]); } } kept = keptF; keptRel = keptRelF; var mgA: number[] = []; for (var mgi = 1; mgi < kept.length; mgi++) mgA.push(kept[mgi] - kept[mgi - 1]); if (mgA.length) { mgA.sort(function (x, y) { return x - y }); var medGap = mgA[Math.floor(mgA.length / 2)]; var mergeMax = Math.min(0.45 * medGap, 2 * spatium); var pairMax2 = Math.min(0.45 * medGap, 3.5 * spatium); var pairMax = Math.max(mergeMax, pairMax2); if (pairMax >= 3) { var mPass = true; while (mPass) { mPass = false; for (var mqi = 1; mqi < kept.length; mqi++) { var pairGap = kept[mqi] - kept[mqi - 1]; if (pairGap < pairMax) { var featL = barStemFeatures(d, kept[mqi - 1]); var featR = barStemFeatures(d, kept[mqi]); var nbL = featL ? featL.noteheadProximity : 0; var nbR = featR ? featR.noteheadProximity : 0; var mdi = -1; var mdReason = ""; if (pairGap < mergeMax) { if (nbL >= 1 && nbR < 1) mdi = mqi - 1; else if (nbR >= 1 && nbL < 1) mdi = mqi; if (mdi >= 0) mdReason = "dropped-stem-graze"; } if (mdi < 0 && pairGap < pairMax2) { var relL = keptRel[mqi - 1].rel; var relR = keptRel[mqi].rel; var runL = featL ? featL.runRatio : 0; var runR = featR ? featR.runRatio : 0; var weakL = relL < 0.9 && runL < 0.85; var weakR = relR < 0.9 && runR < 0.85; var strongL = relL >= 0.95 && runL >= 0.9; var strongR = relR >= 0.95 && runR >= 0.9; if (weakL && strongR) mdi = mqi - 1; else if (weakR && strongL) mdi = mqi; if (mdi >= 0) mdReason = "dropped-weak-graze"; } if (mdi >= 0) { var mdx = kept[mdi]; kept.splice(mdi, 1); keptRel.splice(mdi, 1); lastBarDiagnostics.push({ system: d, x: mdx, strength: 0, rel: 0, kept: false, reason: mdReason }); mPass = true; break; } } } } } } for (const cd of cands) { var isKept = kept.indexOf(cd.x) >= 0; lastBarDiagnostics.push({ system: d, x: cd.x, strength: cd.rel, rel: Math.round(cd.rel * 100) / 100, kept: isKept, reason: isKept ? (cd.weak ? "kept-weak-peak" : cd.bypass ? "kept-straight-bypass" : "kept") : "suppressed-by-nms-or-gap" }); } var conf = scoreSystemConfidence(keptRel, spatium); lastSystemConfidence.push(conf); e = []; v = u.x1; for (const kx of kept) { if (kx > u.x1 + 2 && kx < u.x2 - 2) { e.push(kx); v = kx; } } if (!e.length) { e = [u.x1]; v = u.x1; } else if (e[0] - u.x1 > 3 * spatium) e.unshift(u.x1); if (u.x2 - v > 3 * spatium || e.length === 1) e.push(u.x2); h.push(e) } return h }
