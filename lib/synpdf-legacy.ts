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
  hd: number; deskew: number; notemask: number; widrescue: number;
}

export interface SysXs { x1: number; x2: number; }
export interface SystemInfo { cs: number[]; xs: SysXs; }
export interface CountPixResult { cxs: SystemInfo[]; bxs: number[][]; }

/** 原版 rev.194 opt_default 逐字段默认值 */
export const legacyOpt: SynpdfOpt = {
  speed: 1, no_menu: 0, btns: 1, spdctl: 1, cropx: 0, drmpl: 0.4, pagewd: 1000,
  synbox: 0, wpdf: 1, lncsr: 0, nomed: 0, noplyr: 0, nodash: 0, skipn: 0,
  drmpl2: 2, seln: 0, delay: 0, ipaddr: "", mstr: 0, bpmsr: "4-20-1", loop: 0,
  annot: 0, zwgrens: 0.7, voorna: 0.9, mtdrmpl: 0.85, dx: 3, fscr: 0, pagenum: 1, // mtdrmpl 原版默认 0.8, 本项目默认 0.85(用户指定)
  playbtn: 0, mmin: "", fixwd: 1000, lastSynced: -2, eerst: 0, sysprf: 0, onestf: 0,
  hd: 1, deskew: 1, // hd: 显示高清渲染(分析仍用 pagewd); deskew: 扫描偏斜自动转正
  notemask: 0, widrescue: 0, // 逆向路线(默认关): notemask=先抠实心符头+符干再认线; widrescue=宽度先验抢救淡线
};

/** 算法版本号: 缓存键与 timing 校验共用, 改动识别逻辑时递增 */
export const ALGO_VERSION = 18;
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
/** 最近一次 findBarLines 每系统的列强度标尺 {top,bot,m}(两遍制冻结用) */
export const lastSysM: { top: number; bot: number; m: number }[] = [];
/** 两遍制冻结标尺(几何对齐): 置位时 findBarLines 用原图 m, 不随 mask 漂移 */
let frozenM: { top: number; bot: number; m: number }[] | null = null;
/** 两遍制冻结 wit(按 band 对齐, 两遍同 bands 必等长): 原图暗阈, 不随 mask 变宽松 */
let frozenWit: number[] | null = null;
/** mask 收尾: 恢复冻结 wit(有则), 透传系统数组(无 mask 时纯透传零行为变化) */
function maskFinalize(fsys: any): any {
  if (frozenWit && frozenWit.length === witArr.length) witArr.splice(0, witArr.length, ...frozenWit);
  frozenWit = null;
  return fsys;
}
/** 取值即清 frozenM(防泄漏到下一页/下一次调用) */
function maskUnfreeze<T>(v: T): T { frozenM = null; return v; }
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
/** 单页原语: skipn>0 跳过该页前 N 个系统(原版 opt.skipn 语义); skipn<0 切除该页末尾 |N| 个系统. App 层按整谱语义调用(见 scoreSkipFor): +N 只用于首个有系统页, −N 只用于末个有系统页, 其余页传 0 */
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
 * 偏斜估计(扫描 PDF/照片摆不正): 代理小图逐角度旋转 + 水平投影方差,
 * 方差最大即谱线摆正. 返回内容倾角(度, 顺时针为正, 校正时反向旋转),
 * |角| < 0.15° 或近空白页视为摆正返回 0. 识别算法本身不动, 只转正输入.
 */
export function estimateSkewAngle(src: HTMLCanvasElement): number {
  const W = 360;
  const H = Math.max(1, Math.round((W * src.height) / Math.max(1, src.width)));
  const pc = document.createElement("canvas");
  pc.width = W; pc.height = H;
  const pctx = pc.getContext("2d", { willReadFrequently: true });
  if (!pctx) return 0;
  pctx.fillStyle = "#fff"; pctx.fillRect(0, 0, W, H);
  pctx.drawImage(src, 0, 0, W, H);
  let data: ImageData;
  try { data = pctx.getImageData(0, 0, W, H); } catch { return 0; }
  const d = data.data;
  const gray = new Float32Array(W * H);
  let darkSum = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const g = 255 - (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114);
    gray[i] = g; darkSum += g;
  }
  if (darkSum < W * H * 1.0) return 0; // 近空白页, 无可估方向
  void gray;
  const rc = document.createElement("canvas");
  rc.width = W; rc.height = H;
  const rctx = rc.getContext("2d", { willReadFrequently: true });
  if (!rctx) return 0;
  const y0 = Math.floor(H * 0.15), y1 = Math.ceil(H * 0.85);
  const rows = Math.max(1, y1 - y0);
  const rm = new Float32Array(rows);
  let bestA = 0, bestV = -1;
  for (let a = -5; a <= 5.001; a += 0.25) {
    rctx.fillStyle = "#fff"; rctx.fillRect(0, 0, W, H);
    rctx.save();
    rctx.translate(W / 2, H / 2);
    rctx.rotate((-a * Math.PI) / 180);
    rctx.translate(-W / 2, -H / 2);
    rctx.drawImage(pc, 0, 0);
    rctx.restore();
    let rd: ImageData;
    try { rd = rctx.getImageData(0, 0, W, H); } catch { continue; }
    const dd = rd.data;
    let mean = 0;
    for (let y = y0; y < y1; y++) {
      let s = 0;
      const off = y * W * 4;
      for (let x = 0; x < W; x++) {
        const o = off + x * 4;
        s += 255 - (dd[o] * 0.299 + dd[o + 1] * 0.587 + dd[o + 2] * 0.114);
      }
      rm[y - y0] = s / W; mean += s / W;
    }
    mean /= rows;
    let v = 0;
    for (let k = 0; k < rows; k++) { const e = rm[k] - mean; v += e * e; }
    if (v > bestV) { bestV = v; bestA = a; }
  }
  return Math.abs(bestA) < 0.15 ? 0 : bestA;
}

/**
 * 白底旋转画布(原地): 偏斜扫描页转正, 尺寸按包络扩大. 返回施加的角度, 0 表示未动.
 * @param maxDeg 钳制范围, 超出视为误检不转
 */
export function deskewCanvasInPlace(cv: HTMLCanvasElement, maxDeg = 5): number {
  const ang = estimateSkewAngle(cv);
  if (!ang || Math.abs(ang) > maxDeg) return 0;
  // ang 是内容倾角(顺时针为正), 校正反向转
  const rad = (-ang * Math.PI) / 180;
  const w = cv.width, h = cv.height;
  if (!w || !h) return 0;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const nw = Math.ceil(w * cos + h * sin), nh = Math.ceil(w * sin + h * cos);
  const tmp = document.createElement("canvas");
  tmp.width = nw; tmp.height = nh;
  const ctx = tmp.getContext("2d");
  if (!ctx) return 0;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, nw, nh);
  ctx.translate(nw / 2, nh / 2); ctx.rotate(rad); ctx.drawImage(cv, -w / 2, -h / 2);
  cv.width = nw; cv.height = nh;
  const c2 = cv.getContext("2d");
  if (!c2) return 0;
  c2.drawImage(tmp, 0, 0);
  return ang;
}

/** 最近一次 maskNoteheads 战果(供状态栏/诊断): 抠掉的符头数与涂白像素数 */
export const lastMaskStats = { heads: 0, masked: 0 };
/**
 * 逆向路线 Phase1: 实心符头 + 附着符干 mask(原地涂白)。
 * v2(形态学): 符头粘谱线时连通域会连成整行, 先做矩形 opening
 * (两次一维腐蚀, 核随 spatium 自适应)干掉细线条(谱线/符干/小节线/梁),
 * 剩符头芯; 芯上连通域 + 尺寸/填充率/谱表邻近三过滤; 芯膨胀 2px 恰落回真符头
 * 内部(腐蚀吃掉 arm px/边), 涂白零外溢; 最后原图上双向追符干(窄才延,
 * 遇梁/符尾即停, 最长 6sp, 梁是竖线的终点无需越过)。
 * 调用方: drawRes 之后(spatium 已知)。sp<7 时小符头不可靠, 直接跳过。
 */
/** mask 保护列(两遍制): 第一遍已检出的小节线 ±3px 永不涂白,
 * 后续追踪也不得越过。mask 只删墨不添墨 + 强线锁定 = 单调不退化。 */
let maskProt: Uint8Array | null = null;
export function maskNoteheads(w: number, h: number, pix: any, prot?: Uint8Array | null): { heads: number; masked: number } {
  const sp = Math.max(1, spatium);
  lastMaskStats.heads = 0; lastMaskStats.masked = 0;
  maskProt = prot ?? null;
  if (sp < 7 || w < 16 || h < 16) return { heads: 0, masked: 0 };
  let heads = 0, masked = 0;
  // 自包含暗阈: 整页采样均值×0.7(白纸≈765, 阈≈535, 与管线 3*wit 同量级)
  let sum = 0, n = 0;
  for (let o = 0; o < w * h * 4; o += 64) { sum += pix[o] + pix[o + 1] + pix[o + 2]; n++; }
  if (!n) return { heads, masked };
  const thr = (sum / n) * 0.7;
  // 二值化 + 矩形腐蚀(两次一维滑窗 running-sum, 窗外垫 0):
  // 核自适应(sp≤10 用 5, 大扫描用 7): 真实渲染有灰边, 实心核比纯黑
  // synth 小, 大核会把符头也吃光; 残留线头由 bbox 过滤(腐蚀只需切断连接)
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    bin[i] = pix[o] + pix[o + 1] + pix[o + 2] < thr ? 1 : 0;
  }
  const K = sp > 10 ? 7 : 5, arm = (K - 1) / 2;
  const e1 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let run = 0;
    for (let x = 0; x <= Math.min(w - 1, arm); x++) if (bin[base + x]) run++;
    for (let x = 0; x < w; x++) {
      e1[base + x] = run >= K ? 1 : 0;
      if (x - arm >= 0 && bin[base + x - arm]) run--;
      if (x + arm + 1 < w && bin[base + x + arm + 1]) run++;
    }
  }
  const e2 = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y <= Math.min(h - 1, arm); y++) if (e1[y * w + x]) run++;
    for (let y = 0; y < h; y++) {
      e2[y * w + x] = run >= K ? 1 : 0;
      if (y - arm >= 0 && e1[(y - arm) * w + x]) run--;
      if (y + arm + 1 < h && e1[(y + arm + 1) * w + x]) run++;
    }
  }
  const darkAt = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const o = (y * w + x) * 4;
    return pix[o] + pix[o + 1] + pix[o + 2] < thr;
  };
  // 核阈值(只看最黑的芯, 排除扫描灰边): 宽度测量专用, 连续性仍用 darkAt
  const coreAt = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const o = (y * w + x) * 4;
    return pix[o] + pix[o + 1] + pix[o + 2] < thr * 0.55;
  };
  const whiteAt = (x: number, y: number): void => {
    if (maskProt && maskProt[x]) return; // 保护列: 已检出小节线不动
    const o = (y * w + x) * 4;
    if (pix[o] + pix[o + 1] + pix[o + 2] < 255 * 3) { pix[o] = pix[o + 1] = pix[o + 2] = 255; masked++; }
  };
  // 谱表纵向范围(drawRes 行组刚算好, 取其并集±2.5sp): 标题/歌词/页码不碰
  const bands: { lo: number; hi: number }[] = [];
  for (const gg of getLastRowGroups()) {
    if (!gg.length) continue;
    let lo = gg[0], hi = gg[0];
    for (const y of gg) { if (y < lo) lo = y; if (y > hi) hi = y; }
    bands.push({ lo: lo - 2.5 * sp, hi: hi + 2.5 * sp });
  }
  const nearStaff = (y: number): boolean => bands.some((b) => y >= b.lo && y <= b.hi);
  // 芯连通域(8 连通): 腐蚀后只剩符头芯(3×5 起)与大墨块, 细线全灭
  const seen = new Uint8Array(w * h);
  const maxB = 2 * sp;
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      if (seen[sy * w + sx] || !e2[sy * w + sx]) continue;
      // BFS 芯连通域
      let x0 = sx, x1 = sx, y0 = sy, y1 = sy, cnt = 0;
      const stack: number[] = [sy * w + sx];
      seen[sy * w + sx] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % w, cy = (cur / w) | 0;
        cnt++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx]) continue;
          seen[ny * w + nx] = 1;
          if (e2[ny * w + nx]) stack.push(ny * w + nx);
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw < 2 || bh < 2 || bw > maxB || bh > maxB) continue;
      if (cnt < 8 || cnt / (bw * bh) < 0.4) continue;
      if (bands.length && !nearStaff((y0 + y1) / 2)) continue;
      // 芯膨胀 1px(严格落在真符头内部, 零外溢; 未检出的淡线不受牵连)
      const zx0 = Math.max(0, x0 - 1), zx1 = Math.min(w - 1, x1 + 1);
      const zy0 = Math.max(0, y0 - 1), zy1 = Math.min(h - 1, y1 + 1);
      // 原子提交: 先试追踪(dry-run)记录符干像素, 两方向都自然结束
      // (白缝/横墨梁/图像边, 非 maxLen 预算撞墙)才一起涂白头+干;
      // 否则整个头都不动(纯 base 行为)。有头无干安全, 无头有干是 FP 之源。
      // 符干在符头边缘, 追踪列按原符头跨度取(core±arm±1)。
      const maxW = Math.max(3, Math.round(0.5 * sp) + 1);
      const rowWidthAt = (tx: number, yy: number): number => {
        let lo = tx, hi = tx;
        while (lo - 1 >= 0 && darkAt(lo - 1, yy)) lo--;
        while (hi + 1 < w && darkAt(hi + 1, yy)) hi++;
        return hi - lo + 1;
      };
      // 核宽度(严格阈): 灰边不计入, 扫描件上 2px 符干仍判窄
      const coreWidthAt = (tx: number, yy: number): number => {
        if (!coreAt(tx, yy)) return 99;
        let lo = tx, hi = tx;
        while (lo - 1 >= 0 && coreAt(lo - 1, yy)) lo--;
        while (hi + 1 < w && coreAt(hi + 1, yy)) hi++;
        return hi - lo + 1;
      };
      const narrowAt = (tx: number, yy: number): boolean =>
        darkAt(tx, yy) && coreWidthAt(tx, yy) <= maxW;
      const tx0 = Math.max(0, x0 - arm - 1), tx1 = Math.min(w - 1, x1 + arm + 1);
      const whites: number[] = [];
      let ok = true;
      for (let tx = tx0; tx <= tx1 && ok; tx++) {
        for (const dir of [-1, 1]) {
          let yy = dir < 0 ? zy0 - 1 : zy1 + 1;
          let adv = 0;
          while (adv < 10 && yy >= 0 && yy < h && !narrowAt(tx, yy)) { yy += dir; adv++; }
          if (adv >= 10 || yy < 0 || yy >= h) continue;
          let done = false;
          for (let len = 0; len < 6 * sp && yy >= 0 && yy < h; len++, yy += dir) {
            if (!darkAt(tx, yy)) { done = true; break; }
            const rw = rowWidthAt(tx, yy);
            if (rw > 20) continue; // 横贯行(谱线/加线/长梁): 跳过, 符干不断
            if (coreWidthAt(tx, yy) > maxW) { done = true; break; } // 梁/符头: 自然终点
            let lo = tx, hi = tx;
            while (lo - 1 >= 0 && darkAt(lo - 1, yy)) lo--;
            while (hi + 1 < w && darkAt(hi + 1, yy)) hi++;
            for (let wx = lo; wx <= hi; wx++) whites.push(yy * w + wx);
          }
          if (!done) { ok = false; break; }
        }
      }
      if (!ok) continue;
      for (let yy = zy0; yy <= zy1; yy++) for (let xx = zx0; xx <= zx1; xx++) whiteAt(xx, yy);
      for (const o of whites) whiteAt(o % w, (o / w) | 0);
      heads++;
    }
  }
  lastMaskStats.heads = heads; lastMaskStats.masked = masked;
  return { heads, masked };
}

/**
 * 逆向路线 Phase2: 宽度先验抢救淡线(EM 式: 间距模型预测 + 图像低阈验证)。
 * 某内部 gap 明显宽于本系统中位数(≥1.6×)时, 按 k 等分预测小节线位置,
 * 在预测窗内用放宽的强度阈(0.4m, 原 0.85/弱峰 0.7)找直列, 形状否决
 * (barColumnVetoed)照常执行——只放松强度, 不放松形状, 找不到就认,
 * 绝不硬造。护栏: 贴边 gap 跳过(缩进/弱起/终线天然不规则)、多小节休止符
 * (中部粗横杠)跳过、每系统至少 2 个内部 gap 才有可信中位数、最多 4 轮。
 */
export function rescueWideGapBars(f: any, bars: any[], stride: number, pix: any): any[] {
  if (!legacyOpt.widrescue) return bars;
  const sp = Math.max(1, spatium);
  const W = Math.max(1, Math.floor(stride / 4));
  return bars.map((row0, d) => {
    const sys = f[d];
    if (!sys || !row0 || row0.length < 4) return row0;
    const x1 = sys.xs.x1, x2 = sys.xs.x2;
    const cs: number[] = sys.cs, w0 = cs[0], t0 = cs[cs.length - 1];
    const darkT = 3 * (witArr[d] ?? 175);
    let row = row0.slice();
    for (let pass = 0; pass < 4; pass++) {
      const gaps: { i: number; w: number }[] = [];
      for (let i = 1; i < row.length; i++) {
        if (row[i - 1] - x1 < 3 * sp || x2 - row[i] < 3 * sp) continue;
        gaps.push({ i, w: row[i] - row[i - 1] });
      }
      if (gaps.length < 2) return row;
      const sw = gaps.map((g) => g.w).sort((a, b) => a - b);
      const med = sw[Math.floor((sw.length - 1) / 2)];
      if (!(med > 5 * sp)) return row;
      let tgt: { i: number; w: number } | null = null;
      for (const g of gaps) if (g.w >= 1.6 * med && (!tgt || g.w > tgt.w)) tgt = g;
      if (!tgt) return row;
      const gx0 = row[tgt.i - 1], gw = tgt.w;
      // 多休止符护栏: 中部行区找长横杠(≥0.3 gap 宽, 且连续≥3 行——谱线只
      // 有 2px 厚, 不能算; 否则所有 gap 都被误判, rescue 永不触发)
      let restBar = false;
      const H = t0 - w0 + 1;
      let thickRows = 0;
      for (let y = Math.round(w0 + H * 0.3); y <= Math.round(w0 + H * 0.7); y++) {
        let run = 0, longRow = false;
        for (let x = Math.round(gx0 + gw * 0.1); x <= Math.round(gx0 + gw * 0.9); x++) {
          const o = (y * W + x) * 4;
          if (pix[o] + pix[o + 1] + pix[o + 2] < darkT) { if (++run >= gw * 0.3) { longRow = true; break; } }
          else run = 0;
        }
        if (longRow && ++thickRows >= 3) { restBar = true; break; }
        if (!longRow) thickRows = 0;
      }
      if (restBar) return row;
      const k = Math.max(2, Math.round(gw / med));
      const ev = columnEvidence(cs, darkT, stride, pix, 2 * sp);
      let m = 0;
      const q = Math.max(0, x1 + 50), v = Math.min(ev.ys.length - 1, x2 - 20);
      for (let x = q; x <= v; x++) if (ev.ys[x] > m) m = ev.ys[x];
      if (!(m > 0)) return row;
      const found: number[] = [];
      for (let j = 1; j < k; j++) {
        const pc = gx0 + (gw * j) / k, win = Math.max(3, Math.round(0.18 * med));
        let bx = -1, bv = -1;
        for (let x = Math.max(5, Math.round(pc - win)); x <= Math.min(ev.ys.length - 6, Math.round(pc + win)); x++) {
          if (ev.ys[x] < m * 0.4 || ev.ys[x] < bv) continue;
          let isMax = true;
          for (let z = x - 2; z <= x + 2; z++) {
            if (z !== x && z >= 0 && z < ev.ys.length && ev.ys[z] > ev.ys[x]) { isMax = false; break; }
          }
          if (!isMax) continue;
          if (columnRunRatio(x, w0, t0, stride, pix, darkT) < 0.6) continue;
          if (barColumnVetoedRescue(d, x, w0, t0)) continue;
          bx = x; bv = ev.ys[x];
        }
        if (bx >= 0) found.push(bx);
      }
      if (!found.length) return row;
      const minGap = Math.max(3, Math.round(1.5 * sp));
      for (const nx of found) {
        if (row.some((ex: number) => Math.abs(ex - nx) < minGap)) continue;
        row.push(nx);
      }
      row.sort((a: number, b: number) => a - b);
    }
    return row;
  });
}
export function countPixFromBuffer(w: number, h: number, data: Uint8ClampedArray | number[], seln: number): CountPixResult { var c: any, e: any; var f: any = w; var g = 4 * f; var k = h; var a: any = data; var l = 0; var p: any = []; var n = 3 * g / 4, stride = g; legacyOpt.eerst && (n = 0, stride = g / 4); for (e = 0; e < k; e++) { var m = 0; for (c = l + n; c < l + stride; c += 4)m += a[c], m += a[c + 1], m += a[c + 2]; c = m / (3 * (stride - n)); p.push(c); l += g } f = drawRes(p, f, k); lastRowGroups.length = 0; for (const gg of (f as number[][])) lastRowGroups.push((gg as number[]).slice()); if (legacyOpt.notemask) { const W = Math.max(1, Math.floor(g / 4)); const f0 = countVsys(f, g, a); frozenWit = witArr.slice(); const baseBars = findBarLines(f0, g, a); frozenM = lastSysM.slice(); const prot = new Uint8Array(W); for (const row of baseBars) for (const bx of row) for (let c = Math.max(0, Math.round(bx) - 3); c <= Math.min(W - 1, Math.round(bx) + 3); c++) prot[c] = 1; const mc = (a as any).slice(); maskNoteheads(g / 4, k, mc, prot); a = mc; } for (f = maskFinalize(countVsys(f, g, a)); f.length && skipnV > 0;)f.shift(), --skipnV; for (; f.length && skipnV < 0;)f.pop(), ++skipnV; seln && (f = f.slice(seln - 1, seln)); const foundBars = maskUnfreeze(findBarLines(f, g, a)); const resBars = rescueWideGapBars(f, foundBars, g, a); return { cxs: f, bxs: resBars } }

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
  // 并带兜底: 相邻单谱表之间若有笔画纵贯纵向 gap(小节线/起奏花括号同时穿过
  // 上下两行的夹缝), 即为误拆的大谱表, 直接合并。只认物理连接, 不依赖
  // sysprf/drmpl2 聚类(双带单 gap 时聚类恒为 merge=false, sysprf 勾选也无用,
  // Passacaglia 末页即此类: 高音底 117→低音顶 195, gap 78px≈9.75sp 被 byV
  // 的 8sp 设防拦住, 高/低音被顺延编号成两个系统)。纯空白 gap 的相邻单谱表
  // (人声谱/独奏谱)无纵贯笔画, 不受影响; onestf=1 强制单谱表时跳过。
  if (!legacyOpt.onestf && g.length >= 2) {
    const fsp = Math.max(1, spatium);
    const fstride = b as number, fpix: any = c, fW = Math.max(1, Math.floor(fstride / 4));
    const gapLinked = (top: number[], bot: number[], x1: number, x2: number): boolean => {
      const gt = top[top.length - 1] + 1, gb = bot[0] - 1;
      const gh = gb - gt + 1;
      if (gh < fsp || gh > 20 * fsp) return false;
      const xa = Math.max(0, Math.min(x1, x2)), xb = Math.min(fW - 1, Math.max(x1, x2));
      if (xb - xa < 10 * fsp) return false;
      let sum = 0, n = 0;
      for (let x = xa; x <= xb; x += 4) for (let y = gt; y <= gb; y += 4) {
        const o = (y * fW + x) * 4;
        sum += fpix[o] + fpix[o + 1] + fpix[o + 2]; n++;
      }
      if (!n) return false;
      const thr = (sum / n) * 0.7;
      let linked = 0;
      for (let x = xa; x <= xb; x++) {
        let dark = 0;
        for (let y = gt; y <= gb; y++) {
          const o = (y * fW + x) * 4;
          if (fpix[o] + fpix[o + 1] + fpix[o + 2] < thr) dark++;
        }
        if (dark >= gh * 0.7 && ++linked >= 2) return true;
      }
      return false;
    };
    const isSingle = (cs: number[]): boolean => cs.length >= 4 && cs.length <= 9;
    const joined: any[] = [];
    let cur = g[0];
    let curChain = isSingle(cur.cs as number[]);
    for (let mi = 1; mi < g.length; mi++) {
      const nx = g[mi];
      const nxSingle = isSingle(nx.cs as number[]);
      const x1ok = Math.abs(cur.xs.x1 - nx.xs.x1) <= 3 * fsp;
      const x2ok = Math.abs(cur.xs.x2 - nx.xs.x2) <= 6 * fsp;
      if (nxSingle && curChain && x1ok && x2ok &&
        gapLinked(cur.cs as number[], nx.cs as number[], Math.max(cur.xs.x1, nx.xs.x1), Math.min(cur.xs.x2, nx.xs.x2))) {
        cur = { cs: (cur.cs as any[]).concat(nx.cs), xs: { x1: Math.min(cur.xs.x1, nx.xs.x1), x2: Math.max(cur.xs.x2, nx.xs.x2) } };
      } else { joined.push(cur); cur = nx; curChain = nxSingle; }
    }
    joined.push(cur);
    g = joined;
  }
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
  headDip: boolean;
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
  let headDip = false;
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
    // headDip: 计入段行序宽度先降后升(斜穿连音线如 740:[10,7,6,8], 实符头单调如
    // 931:[8,10,11,11]), rule2 遇 dip 放行(救 740, 931 照杀)。topDip(顶端窗版)
    // 已证伪: 放进 4 个 GT 符干, 已删。
    if (headRun >= 4 && headRun <= 12) {
      if (headW.length >= 3 && headW[1] < headW[0] && headW[headW.length - 1] > headW[headW.length - 2]) headDip = true;
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
    headDip,
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
  // 谱表带内符头数(Boek: 真线旁 1.5sp 外的邻音符头把 rule2/3 全点着,
  // 符干自带头必贴杆端落在带内; 只认与 [rw0-0.5sp, rt0+0.5sp] 相交的段)。
  var spN = Math.max(1, spatium);
  var nearProx = 0;
  for (const sg of (sf0.headSegs ?? [])) {
    if (sg.y < rt0 + 0.5 * spN && sg.y + sg.h > rw0 - 0.5 * spN) nearProx++;
  }
  return ((Math.max(sf0.topBlob, sf0.botBlob) >= 4 && sf0.runRatio >= 0.8 && sf0.midWidth <= 5) ||
    (sf0.runRatio >= 0.9 && nearProx >= 1 && !sf0.headDip) ||
    (sf0.runRatio >= 0.95 && nearProx >= 1 && !sf0.headDip) ||
    (sf0.runRatio >= 0.6 && sf0.midWidth >= 6) ||
    (sf0.twinDist >= 4 && sf0.twinDist <= 6 && sf0.twinRel >= 0.55 && sf0.twinRel < 0.65) ||
    (sf0.runRatio >= 0.8 && sf0.noteheadProximity >= 1 && Math.max(sf0.topBlob, sf0.botBlob) >= 6) ||
    // extAbove(谱上延伸墨)全局否决已证伪: GT 上 26 个真线被邻音符头误杀
    // (自头/邻头单列不可分, v17.4), 保留字段供窄对仲裁等上下文规则参考。
    ((sf0.beamAbove >= 3 || sf0.beamBelow >= 4) && narrowSys) ||
    (narrowSys && sf0.runRatio < 0.95 && sf0.midWidth <= 2));
}

/** rescue 专用否决: notemask 开启时符干已被删, 专杀符干的子句冗余且会
 * 误杀淡线(窄系统细竖线条款), 只保留宽度/形状类(过宽/升号双竖)。
 * mask 关闭时走全套 barColumnVetoed(保守)。 */
export function barColumnVetoedRescue(sysIdx: number, x: number, rw0: number, rt0: number): boolean {
  if (!legacyOpt.notemask) return barColumnVetoed(sysIdx, x, rw0, rt0);
  const sf0 = barStemFeatures(sysIdx, x);
  if (!sf0) return false;
  if (sf0.runRatio >= 0.6 && sf0.midWidth >= 6) return true;
  if (sf0.twinDist >= 4 && sf0.twinDist <= 6 && sf0.twinRel >= 0.55 && sf0.twinRel < 0.65) return true;
  return false;
}

function findBarLines(a: any, b: any, c: any): any { lastEB_A = a; lastEB_B = b; lastEB_C = c; var d: any, e: any, f: any, g: any, k = legacyOpt.mtdrmpl, l = legacyOpt.voorna, p = 1 * legacyOpt.dx, n = 2 * spatium, h: any[] = []; lastBarDiagnostics.length = 0; lastSystemConfidence.length = 0; lastSysM.length = 0; for (d = 0; d < a.length; ++d) { var m = 3 * witArr[d]; var u = a[d].xs; var q = u.x1 + 50; var v = u.x2 - 20; q >= v && (q = u.x1, v = u.x2); var r = a[d].cs; var w = r[0]; var t = r[r.length - 1]; var C = (w - n) * b; var z = w * b; var A = t * b; var D = (t + n) * b; var evd = columnEvidence(r, m, b, c, n); r = evd.rs; var y: any = evd.ys; f = y.slice(q, v); f.sort(function (a: any, b: any) { return b - a }); m = f[0]; if (frozenM) { var fhit = false; for (var fmi = 0; fmi < frozenM.length; fmi++) { var fe = frozenM[fmi]; if (Math.abs(fe.top - w) <= 3 && Math.abs(fe.bot - t) <= 3) { m = fe.m; fhit = true; break; } } } lastSysM.push({ top: w, bot: t, m: m }); t = w = 0; for (f = q; f < v; f++)q = y[f], q > m * k && (r[f - p] > w && (w = r[f - p]), r[f + p] > t && (t = r[f + p])); var cands: { x: number; rel: number; bypass: boolean; weak: boolean }[] = []; var csRows0: number[] = a[d].cs; var rw0 = csRows0[0]; var rt0 = csRows0[csRows0.length - 1]; var darkSum0 = 3 * witArr[d]; for (f = 5; f < r.length - 5; f++) { var yy = y[f]; var weakPeak = false; if (!(yy > m * k)) { if (r[f - p] > w * l && r[f + p] > t * l) { if (yy > m * 0.7 && columnRunRatio(f, rw0, rt0, b, c, darkSum0) >= 0.65) { weakPeak = true; var wLo = Math.max(5, f - Math.round(spatium)); var wHi = Math.min(r.length - 6, f + Math.round(spatium)); for (var wnb = wLo; wnb <= wHi; wnb++) { if (y[wnb] > yy) { weakPeak = false; break; } } if (weakPeak) { var wsf = barStemFeatures(d, f); if (!wsf || Math.max(wsf.topBlob, wsf.botBlob) >= 4) weakPeak = false; } } } if (!weakPeak) continue; } if (f - u.x1 < Math.max(80, 8 * spatium)) continue; var passC = r[f - p] > w * l && r[f + p] > t * l; var bypass = false; if (!passC) { if (columnRunRatio(f, rw0, rt0, b, c, darkSum0) < 0.9) continue; bypass = true; } var sf0 = barStemFeatures(d, f); if (barColumnVetoed(d, f, rw0, rt0)) continue; cands.push({ x: f, rel: m > 0 ? yy / m : 0, bypass, weak: weakPeak }); } var keptNms = nmsBarPeaks(cands, spatium); var minGap = 3 * spatium; var dblGap = Math.max(2, spatium * 0.7); var kept: number[] = []; var keptRel: { x: number; rel: number }[] = []; for (const cand of keptNms) { if (!kept.length) { kept.push(cand.x); keptRel.push(cand); continue; } var prevX = kept[kept.length - 1]; var prevRel = keptRel[keptRel.length - 1].rel; var gap = cand.x - prevX; var strongPair = cand.rel >= 0.85 && prevRel >= 0.85; var need = strongPair ? dblGap : minGap; if (gap >= need) { kept.push(cand.x); keptRel.push(cand); } else if (cand.rel > prevRel + 0.05) { kept[kept.length - 1] = cand.x; keptRel[keptRel.length - 1] = cand; } } var keptF: number[] = []; var keptRelF: { x: number; rel: number }[] = []; for (var kfi = 0; kfi < kept.length; kfi++) { if (!barColumnVetoed(d, kept[kfi], rw0, rt0)) { keptF.push(kept[kfi]); keptRelF.push(keptRel[kfi]); } } kept = keptF; keptRel = keptRelF; var mgA: number[] = []; for (var mgi = 1; mgi < kept.length; mgi++) mgA.push(kept[mgi] - kept[mgi - 1]); if (mgA.length) { mgA.sort(function (x, y) { return x - y }); var medGap = mgA[Math.floor(mgA.length / 2)]; var mergeMax = Math.min(0.45 * medGap, 2 * spatium); var pairMax2 = Math.min(0.45 * medGap, 3.5 * spatium); var pairMax = Math.max(mergeMax, pairMax2); if (pairMax >= 3) { var mPass = true; while (mPass) { mPass = false; for (var mqi = 1; mqi < kept.length; mqi++) { var pairGap = kept[mqi] - kept[mqi - 1]; if (pairGap < pairMax) { var featL = barStemFeatures(d, kept[mqi - 1]); var featR = barStemFeatures(d, kept[mqi]); var nbL = featL ? featL.noteheadProximity : 0; var nbR = featR ? featR.noteheadProximity : 0; var mdi = -1; var mdReason = ""; if (pairGap < mergeMax) { if (nbL >= 1 && nbR < 1) mdi = mqi - 1; else if (nbR >= 1 && nbL < 1) mdi = mqi; if (mdi >= 0) mdReason = "dropped-stem-graze"; } if (mdi < 0 && pairGap < pairMax2) { var relL = keptRel[mqi - 1].rel; var relR = keptRel[mqi].rel; var runL = featL ? featL.runRatio : 0; var runR = featR ? featR.runRatio : 0; var weakL = relL < 0.9 && runL < 0.85; var weakR = relR < 0.9 && runR < 0.85; var strongL = relL >= 0.95 && runL >= 0.9; var strongR = relR >= 0.95 && runR >= 0.9; if (weakL && strongR) mdi = mqi - 1; else if (weakR && strongL) mdi = mqi; if (mdi >= 0) mdReason = "dropped-weak-graze"; } if (mdi >= 0) { var mdx = kept[mdi]; kept.splice(mdi, 1); keptRel.splice(mdi, 1); lastBarDiagnostics.push({ system: d, x: mdx, strength: 0, rel: 0, kept: false, reason: mdReason }); mPass = true; break; } } } } } } for (const cd of cands) { var isKept = kept.indexOf(cd.x) >= 0; lastBarDiagnostics.push({ system: d, x: cd.x, strength: cd.rel, rel: Math.round(cd.rel * 100) / 100, kept: isKept, reason: isKept ? (cd.weak ? "kept-weak-peak" : cd.bypass ? "kept-straight-bypass" : "kept") : "suppressed-by-nms-or-gap" }); } var conf = scoreSystemConfidence(keptRel, spatium); lastSystemConfidence.push(conf); e = []; v = u.x1; for (const kx of kept) { if (kx > u.x1 + 2 && kx < u.x2 - 2) { e.push(kx); v = kx; } } if (!e.length) { e = [u.x1]; v = u.x1; } else if (e[0] - u.x1 > 3 * spatium) e.unshift(u.x1); if (u.x2 - v > 3 * spatium || e.length === 1) e.push(u.x2); h.push(e) } return h }
