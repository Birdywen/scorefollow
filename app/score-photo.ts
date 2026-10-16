// 纯函数层(原 app/page.tsx 顶部): 谱面光栅裁剪/照片预处理/双语表, 不碰任何组件状态。
export type Lang = "zh" | "en";

// 界面中英双语: 静态 chrome 字符串走这里, 动态诊断 status 保持原文(调试用)
export const STR: Record<string, { zh: string; en: string }> = {
  score: { zh: "谱", en: "Score" },
  media: { zh: "媒体", en: "Media" },
  noScore: { zh: "未载入谱面", en: "No score loaded" },
  loadPdf: { zh: "载入 PDF 谱", en: "Load PDF score" },
  loadImage: { zh: "载入图片谱", en: "Load image score" },
  takePhoto: { zh: "拍照录谱", en: "Snap score photo" },
  loadMedia: { zh: "载入音频/视频", en: "Load audio/video" },
  settings: { zh: "设置", en: "Settings" },
  open: { zh: "打开", en: "Open" },
  play: { zh: "▶ 播放", en: "▶ Play" },
  pause: { zh: "❚❚ 暂停", en: "❚❚ Pause" },
  metroPlay: { zh: "▶ 节拍器", en: "▶ Metro" },
  metroStop: { zh: "■ 停止", en: "■ Stop" },
  prevPage: { zh: "上一页", en: "Previous page" },
  nextPage: { zh: "下一页", en: "Next page" },
  speed: { zh: "速度", en: "Speed" },
  correct: { zh: "纠错", en: "Correct" },
  correcting: { zh: "✓ 纠错中", en: "✓ Correcting" },
  cleanView: { zh: "干净视图", en: "Clean view" },
  panelBtn: { zh: "面板", en: "Panel" },
  waiting: { zh: "等待谱面", en: "Waiting for score" },
  sysUnit: { zh: "行", en: "systems" },
  barUnit: { zh: "小节", en: "measures" },
  lowConf: { zh: "低置信", en: "low-conf" },
  pageUnit: { zh: "页", en: " pages" },
  close: { zh: "关闭", en: "Close" },
  tuner: { zh: "调音器", en: "Tuner" },
  closePanel: { zh: "关闭面板", en: "Close panel" },
  practice: { zh: "练习控制", en: "Practice controls" },
  measureOps: { zh: "小节操作", en: "Measure actions" },
  resetDefaults: { zh: "恢复默认值", en: "Reset defaults" },
  pieSplit: { zh: "拆分", en: "Split" },
  pieMergeR: { zh: "右合▶", en: "Merge ▶" },
  pieDelete: { zh: "删除", en: "Delete" },
  pieRedo: { zh: "重做", en: "Redo" },
  pieAllPages: { zh: "全页", en: "All pgs" },
  pieReset: { zh: "重置", en: "Reset" },
  pieUndo: { zh: "撤销", en: "Undo" },
  pieMergeL: { zh: "◀左合", en: "◀ Merge" },
  barSetup: { zh: "小节设置", en: "Bar setup" },
  barMeter: { zh: "拍号", en: "Meter" },
  meterDefault: { zh: "默认", en: "Default" },
  pickup14: { zh: "1/4·弱起", en: "1/4 pickup" },
  barNo: { zh: "小节号", en: "Bar No." },
  renumber: { zh: "顺排↓", en: "Renumber↓" },
  loopFrom: { zh: "设为起点", en: "Set start" },
  loopTo: { zh: "设为终点", en: "Set end" },
  loopToggle: { zh: "循环", en: "Loop" },
  loopClear: { zh: "清除", en: "Clear" },
  loopMark: { zh: "圈Loop", en: "Mark loop" },
  loopMarking: { zh: "✓圈Loop中", en: "✓Marking" },
  adjust: { zh: "调整", en: "Adjust" },
  adjusting: { zh: "✓调整中", en: "✓Adjusting" },
  diagnostics: { zh: "诊断视图", en: "Diagnostics" },
  correctHint: { zh: "点击选中 · 拖动线条 · 长按/双击新增 · Ctrl+Z 撤销", en: "Click to select · drag a line · long-press/double-click to add · Ctrl+Z to undo" },
  exitCorrect: { zh: "完成校正", en: "Done correcting" },
  noPdfHint: { zh: "加载 PDF 乐谱，开始连续练习", en: "Load a PDF score to begin practicing" },
  emptyDrop: { zh: "拖入 PDF / 图片，或选择文件。识别小节后按 ▶ 开始跟谱。", en: "Drop a PDF / image, or pick a file. After bars are found, press ▶ to play along." },
  step1: { zh: "载入谱面", en: "Load a score" },
  step2: { zh: "检查小节", en: "Check the bars" },
  step3: { zh: "播放练习", en: "Play & practice" },
  expertDev: { zh: "开发者", en: "dev" },
  exportPreview: { zh: "导出预览", en: "Export preview" },
  selected: { zh: "已选中", en: "Selected" },
  fileSection: { zh: "文件与导出", en: "Files & export" },
  viewSection: { zh: "谱面视图", en: "Score display" },
  modeSection: { zh: "识别模式", en: "Recognition mode" },
  timingSection: { zh: "识别参数", en: "Recognition settings" },
  barsSection: { zh: "小节与批注", en: "Measures & annotations" },
  expertSection: { zh: "专家参数", en: "Expert settings" },
  systemOverlay: { zh: "系统区域", en: "Systems" },
  barOverlay: { zh: "小节线", en: "Barlines" },
  cursorOverlay: { zh: "播放光标", en: "Cursor" },
  lowOverlay: { zh: "低置信区域", en: "Low confidence" },
  lineCursor: { zh: "线形光标", en: "Line cursor" },
  blackThresh: { zh: "黑色阈值", en: "Black thresh" },
  beforeAfter: { zh: "前后阈值", en: "Before/after" },
  barlineThresh: { zh: "小节线阈值", en: "Barline thresh" },
  annotate: { zh: "批注", en: "Annotations" },
  enableSync: { zh: "启用同步", en: "Enable sync" },
  saveTiming: { zh: "导出同步数据", en: "Save timing" },
  loadTiming: { zh: "导入同步数据", en: "Load timing" },
  savePreload: { zh: "导出 preload.js", en: "Save preload.js" },
  loadPreload: { zh: "导入 preload.js", en: "Load preload.js" },
  reportIssue: { zh: "上报异常", en: "Report" },
  reportTitle: { zh: "上报识别异常", en: "Report recognition issue" },
  reportConfirmDone: { zh: "我已逐页核对，确认校正完成", en: "I have reviewed every page; correction is complete" },
  reportNoChangeOpt: { zh: "本谱无需校正（原识别正确，只报漏报/其他问题）", en: "No correction needed (recognition was right; reporting misses/other)" },
  reportNotePh: { zh: "问题描述（哪一页、哪一行、哪条线错了）…", en: "Describe the problem (page, system, which bar)…" },
  reportTokenPh: { zh: "GitHub token（仅存本机浏览器，用于自动建 issue/传文件）", en: "GitHub token (stored only in this browser, for auto issue/upload)" },
  reportSubmit: { zh: "提交到 GitHub", en: "Submit to GitHub" },
  reportDownloadOnly: { zh: "仅下载 bundle", en: "Download bundle only" },
  reportServer: { zh: "提交到服务器", en: "Submit to server" },
  reportEndpointPh: { zh: "上报地址（默认随站发布，无需改）", en: "Upload endpoint (default follows site, no change needed)" },
  reportSecretPh: { zh: "上报密钥（服务器 ~/sf-report-secret 首行，仅存本机浏览器）", en: "Upload secret (first line of ~/sf-report-secret; stored only in this browser)" },
};

export function cloneBars(bars: number[][]): number[][] {
  return bars.map((b) => b.slice());
}

/** ArrayBuffer → base64(分块, 防栈溢出): 上报 bundle 传 PDF/JSON 共用 */
export function bufToB64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  const CH = 32768;
  for (let i = 0; i < u.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + CH)));
  }
  return btoa(s);
}

/**
 * 无缝拼接: 裁掉渲染页上下纸张白边(内容包络 + 3px 保护边), 返回原图裁区。
 * 空白页/读数失败返回整页裁区。HD 显示按同一比例裁切，保持分析坐标严格一致。
 */
export interface PageCrop { top: number; bottom: number; sourceHeight: number }

export function cropCanvasRows(cv: HTMLCanvasElement, top: number, bottom: number): void {
  if (cv.height <= 0) return;
  top = Math.max(0, Math.min(cv.height - 1, top));
  bottom = Math.max(top, Math.min(cv.height - 1, bottom));
  const h = Math.max(1, bottom - top + 1);
  if (top === 0 && bottom === cv.height - 1) return;
  const tmp = document.createElement("canvas");
  tmp.width = cv.width;
  tmp.height = h;
  tmp.getContext("2d")!.drawImage(cv, 0, top, cv.width, h, 0, 0, cv.width, h);
  cv.height = h;
  cv.getContext("2d", { willReadFrequently: true })!.drawImage(tmp, 0, 0);
}

export function cropPageMargins(cv: HTMLCanvasElement): PageCrop {
  const W = cv.width, H = cv.height;
  const full = { top: 0, bottom: Math.max(0, H - 1), sourceHeight: H };
  if (!W || !H) return full;
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = cv.getContext("2d", { willReadFrequently: true }); } catch { return full; }
  if (!ctx) return full;
  let img: ImageData;
  try { img = ctx.getImageData(0, 0, W, H); } catch { return full; }
  const d = img.data;
  const minDark = Math.max(3, Math.floor(W * 0.002));
  const rowHas = (y: number): boolean => {
    let c = 0;
    const off = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = off + x * 4;
      if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) { if (++c >= minDark) return true; }
    }
    return false;
  };
  let top = 0;
  while (top < H && !rowHas(top)) top++;
  if (top >= H) return full; // 全白页
  let bot = H - 1;
  while (bot > top && !rowHas(bot)) bot--;
  const PAD = 3;
  top = Math.max(0, top - PAD);
  bot = Math.min(H - 1, bot + PAD);
  cropCanvasRows(cv, top, bot);
  return { top, bottom: bot, sourceHeight: H };
}

export function applyPageCrop(cv: HTMLCanvasElement, crop: PageCrop): void {
  if (!crop.sourceHeight || cv.height <= 0 || (crop.top === 0 && crop.bottom === crop.sourceHeight - 1)) return;
  const scale = cv.height / crop.sourceHeight;
  const top = Math.max(0, Math.round(crop.top * scale));
  const bottom = Math.min(cv.height - 1, Math.round((crop.bottom + 1) * scale) - 1);
  cropCanvasRows(cv, top, Math.max(top, bottom));
}

export function copyCanvas(src: HTMLCanvasElement, dst: HTMLCanvasElement): HTMLCanvasElement {
  dst.width = src.width;
  dst.height = src.height;
  dst.getContext("2d")!.drawImage(src, 0, 0);
  return dst;
}

export function releaseCanvas(cv: HTMLCanvasElement): void {
  cv.width = 0;
  cv.height = 0;
}

export async function pdfPageUsesLargeRaster(proxy: any): Promise<boolean> {
  try {
    const [ops, pdfjs] = await Promise.all([proxy.getOperatorList(), import("pdfjs-dist")]);
    const imageOps = new Set([
      pdfjs.OPS.paintImageXObject,
      pdfjs.OPS.paintInlineImageXObject,
      pdfjs.OPS.paintImageMaskXObject,
      pdfjs.OPS.paintSolidColorImageMask,
    ]);
    return ops.fnArray.some((fn: number, i: number) => {
      if (!imageOps.has(fn)) return false;
      const nums = (ops.argsArray[i] as unknown[]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const [w, h] = nums.slice(-2);
      return w >= 800 && h >= 800 && w * h >= 1_000_000;
    });
  } catch {
    return false;
  }
}

export interface AnalysisRasterEntry {
  canvas: HTMLCanvasElement;
  angle: number;
  crop: PageCrop;
}

export interface RenderCacheStats {
  analysisRasterHits: number;
  analysisRasterMisses: number;
  displayHits: number;
  displayMisses: number;
}

/**
 * 整谱级 skipn 切除页规则(逐页切会吃掉每一页, 多页谱/照片谱全毁):
 * +N 只切第 1 页的头, −N 只切末页的尾, 其余页 skip=0.
 * 首/末页可能是空白扫描页, 主循环后再 walk-back 到真正有系统的页(见 renderAllPages).
 */
export function scoreSkipFor(n: number, total: number, g: number): number {
  if (!Number.isFinite(g) || g === 0) return 0;
  if (g > 0 && n === 1) return g;
  if (g < 0 && n === total) return g;
  return 0;
}

/** 图片谱解码(EXIF 方向归一化, 供图片/相机输入): photo=true 时做拍摄预处理; 失败抛错由调用方报 status */
export async function decodeScoreImage(f: File, photo = false): Promise<{ bmp: ImageBitmap; w: number; h: number }> {
  const finish = async (bmp: ImageBitmap): Promise<{ bmp: ImageBitmap; w: number; h: number }> => {
    if (!photo) return { bmp, w: bmp.width, h: bmp.height };
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    if (typeof (bmp as ImageBitmap).close === "function") { try { bmp.close(); } catch { /* ignore */ } }
    try { preprocessPhoto(c); } catch { /* 预处理失败就用原图, 不丢整批 */ }
    const out = await createImageBitmap(c);
    return { bmp: out, w: out.width, h: out.height };
  };
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" } as ImageBitmapOptions);
    return finish(bmp);
  } catch {
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("image decode failed"));
        el.src = url;
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 1;
      c.height = img.naturalHeight || 1;
      c.getContext("2d")!.drawImage(img, 0, 0);
      const bmp = await createImageBitmap(c);
      return finish(bmp);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** 拍照预处理链(原地改 canvas): 限大 → 四边内容裁边 → 纠偏 → 纸面提亮. 步步有保护, 失败就跳过该步 */
export function preprocessPhoto(cv: HTMLCanvasElement): void {
  downscaleCanvas(cv, 2000);
  autocropPhoto(cv);
  deskewPhoto(cv);
  normalizePhoto(cv);
}

/** 最长边压到 maxDim 内(拍照 12MP 直接分析又慢又吃内存) */
export function downscaleCanvas(cv: HTMLCanvasElement, maxDim: number): void {
  const m = Math.max(cv.width, cv.height);
  if (m <= maxDim || m <= 0) return;
  const k = maxDim / m;
  const tmp = document.createElement("canvas");
  tmp.width = Math.max(1, Math.round(cv.width * k));
  tmp.height = Math.max(1, Math.round(cv.height * k));
  tmp.getContext("2d")!.drawImage(cv, 0, 0, tmp.width, tmp.height);
  cv.width = tmp.width;
  cv.height = tmp.height;
  cv.getContext("2d")!.drawImage(tmp, 0, 0);
}

export function photoCtx(cv: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try { return cv.getContext("2d", { willReadFrequently: true }); } catch { return null; }
}

export const PHOTO_DARK = 200; // 任一通道低于此算内容(谱线/音符), 其余算纸面/桌面

/** 内容包络四边裁边(含 8px 保护边); 内容过小则不动(防把谱裁没) */
export function autocropPhoto(cv: HTMLCanvasElement): boolean {
  const W = cv.width, H = cv.height;
  const ctx = photoCtx(cv);
  if (!ctx || !W || !H) return false;
  let img: ImageData;
  try { img = ctx.getImageData(0, 0, W, H); } catch { return false; }
  const d = img.data;
  const darkAt = (x: number, y: number): boolean => {
    const i = (y * W + x) * 4;
    return d[i] < PHOTO_DARK || d[i + 1] < PHOTO_DARK || d[i + 2] < PHOTO_DARK;
  };
  const needX = Math.max(2, Math.floor(H * 0.002));
  const needY = Math.max(2, Math.floor(W * 0.002));
  const colHas = (x: number): boolean => {
    let c = 0;
    for (let y = 0; y < H; y += 2) { if (darkAt(x, y) && ++c >= needX) return true; }
    return false;
  };
  const rowHas = (y: number): boolean => {
    let c = 0;
    for (let x = 0; x < W; x += 2) { if (darkAt(x, y) && ++c >= needY) return true; }
    return false;
  };
  let x1 = 0; while (x1 < W && !colHas(x1)) x1++;
  if (x1 >= W) return false;
  let x2 = W - 1; while (x2 > x1 && !colHas(x2)) x2--;
  let y1 = 0; while (y1 < H && !rowHas(y1)) y1++;
  let y2 = H - 1; while (y2 > y1 && !rowHas(y2)) y2--;
  const PAD = 8;
  x1 = Math.max(0, x1 - PAD); y1 = Math.max(0, y1 - PAD);
  x2 = Math.min(W - 1, x2 + PAD); y2 = Math.min(H - 1, y2 + PAD);
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  // 内容太小/几乎没裁就不动
  if (w < 200 || h < 200 || w * h < W * H * 0.3) return false;
  if (x1 === 0 && y1 === 0 && x2 === W - 1 && y2 === H - 1) return false;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  tmp.getContext("2d")!.drawImage(cv, x1, y1, w, h, 0, 0, w, h);
  cv.width = w;
  cv.height = h;
  cv.getContext("2d")!.drawImage(tmp, 0, 0);
  return true;
}

/** 纠偏: 小图上试 -4°~4°(步进 0.5°), 取行投影方差最大者; |角度|<0.25° 不动. 返回应用的角度 */
export function deskewPhoto(cv: HTMLCanvasElement): number {
  const W = cv.width, H = cv.height;
  if (!W || !H) return 0;
  const SW = 700;
  const k = Math.min(1, SW / W);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(W * k));
  small.height = Math.max(1, Math.round(H * k));
  const sctx = small.getContext("2d")!;
  sctx.drawImage(cv, 0, 0, small.width, small.height);
  let sdata: ImageData;
  try { sdata = sctx.getImageData(0, 0, small.width, small.height); } catch { return 0; }
  const sd = sdata.data;
  const sw = small.width, sh = small.height;
  // 暗像素掩膜(降采样步进 2)
  const pts: number[] = [];
  for (let y = 0; y < sh; y += 2) {
    for (let x = 0; x < sw; x += 2) {
      const i = (y * sw + x) * 4;
      const lum = (sd[i] + sd[i + 1] + sd[i + 2]) / 3;
      if (lum < 160) pts.push(x, y);
    }
  }
  if (pts.length < 200) return 0;
  let bestA = 0, bestV = -1;
  for (let deg = -4; deg <= 4.001; deg += 0.5) {
    const t = Math.tan((deg * Math.PI) / 180);
    const bins = new Float64Array(sh);
    for (let p = 0; p < pts.length; p += 2) {
      const r = Math.round(pts[p + 1] - pts[p] * t);
      if (r >= 0 && r < sh) bins[r]++;
    }
    let mean = 0;
    for (let r = 0; r < sh; r++) mean += bins[r];
    mean /= sh;
    let v = 0;
    for (let r = 0; r < sh; r++) { const dd = bins[r] - mean; v += dd * dd; }
    if (v > bestV) { bestV = v; bestA = deg; }
  }
  if (Math.abs(bestA) < 0.25) return 0;
  // 绕中心旋回 -bestA, 白底, 画布按需放大防切角
  const rad = (-bestA * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const nw = Math.ceil(W * cos + H * sin), nh = Math.ceil(W * sin + H * cos);
  const tmp = document.createElement("canvas");
  tmp.width = nw;
  tmp.height = nh;
  const tctx = tmp.getContext("2d")!;
  tctx.fillStyle = "#fff";
  tctx.fillRect(0, 0, nw, nh);
  tctx.translate(nw / 2, nh / 2);
  tctx.rotate(rad);
  tctx.drawImage(cv, -W / 2, -H / 2);
  cv.width = nw;
  cv.height = nh;
  cv.getContext("2d")!.drawImage(tmp, 0, 0);
  return bestA;
}

/** 纸面提亮: 亮度 p5→0、p95→255 等比拉伸(保色相); 纸面本来就白(p5≥160)或近乎空白不动 */
export function normalizePhoto(cv: HTMLCanvasElement): void {
  const W = cv.width, H = cv.height;
  const ctx = photoCtx(cv);
  if (!ctx || !W || !H) return;
  let img: ImageData;
  try { img = ctx.getImageData(0, 0, W, H); } catch { return; }
  const d = img.data;
  const N = W * H;
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i += 4) {
    const lum = Math.round((d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3);
    hist[lum]++;
  }
  const cut = N / 4 / 100; // 采样步进 4, 百分位换算
  let p5 = 0, acc = 0;
  while (p5 < 255 && acc < cut * 5) { acc += hist[p5]; p5++; }
  let p95 = 255;
  acc = 0;
  while (p95 > 0 && acc < cut * 5) { acc += hist[p95]; p95--; }
  if (p5 >= 160 || p95 - p5 < 10) return;
  const gain = 255 / Math.max(1, p95 - p5);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round((v - p5) * gain)));
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
}
