/**
 * score-video.ts — render a followed take as an MP4: title card, the score with the moving
 * measure shade, and a closing card. Frames are drawn offline from the page canvases, so no
 * page UI can cover the score. Encoding uses WebCodecs through mediabunny (loaded on demand).
 *
 * Layout: the systems that hold measures are cut into bands and shown in n stacked slots.
 * System s always sits in slot s % n, so while one slot is being played the others already
 * show what comes next (a rolling page turn).
 */
import type { MeasureRect, TimeEntry } from "./synpdf-wijzer";

export type VideoLayout = "landscape" | "portrait";
export type PageOffset = { page: number; y: number; h: number; w: number };
/** A system band in global analysis coordinates (pages stacked top to bottom). */
export type VideoSystem = { top: number; bottom: number; page: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const FRAME: Record<VideoLayout, { w: number; h: number }> = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};
/** Score area inside the frame (below the title line, above the progress bar). */
export const CONTENT: Record<VideoLayout, Rect> = {
  landscape: { x: 48, y: 104, w: 1824, h: 944 },
  portrait: { x: 40, y: 230, w: 1000, h: 1600 },
};
export const FPS = 30;
/** The shade runs this far ahead of the sound, like the live follow. */
export const VIDEO_LEAD_SEC = 0.05;
const SLOT_FADE_SEC = 0.3;

/** Systems holding measures, top to bottom; `systemOf[mix]` is each measure's system. */
export function videoSystems(measures: MeasureRect[], offsets: PageOffset[]):
  { systems: VideoSystem[]; systemOf: number[]; x1: number; x2: number } {
  const rows: { y: number; h: number }[] = [];
  for (const m of measures) if (!rows.some((r) => r.y === m.y && r.h === m.h)) rows.push({ y: m.y, h: m.h });
  rows.sort((a, b) => a.y - b.y);
  const systemOf = measures.map((m) => rows.findIndex((r) => r.y === m.y && r.h === m.h));
  const pageOf = (y: number) => offsets.find((o) => y >= o.y && y < o.y + o.h) ?? offsets[offsets.length - 1];
  const systems = rows.map((r, i) => {
    const page = pageOf(r.y);
    const H = Math.max(8, r.h);
    const prev = rows[i - 1], next = rows[i + 1];
    const samePage = (o?: { y: number }) => o && page && pageOf(o.y)?.page === page.page;
    const gapAbove = samePage(prev) ? r.y - (prev.y + prev.h) : null;
    const gapBelow = samePage(next) ? next.y - (r.y + r.h) : null;
    const pad = (g: number | null, other: number | null) => Math.min(1.3 * H, Math.max(4, (g ?? other ?? 1.6 * H) / 2));
    const top = Math.max(page?.y ?? 0, r.y - pad(gapAbove, gapBelow));
    const bottom = Math.min(page ? page.y + page.h : Infinity, r.y + r.h + pad(gapBelow, gapAbove));
    return { top, bottom, page: page?.page ?? 1 };
  });
  const W = offsets[0]?.w ?? Math.max(...measures.map((m) => m.x + m.w));
  const x1 = Math.max(0, Math.min(...measures.map((m) => m.x)) - 0.025 * W);
  const x2 = Math.min(W, Math.max(...measures.map((m) => m.x + m.w)) + 0.015 * W);
  return { systems, systemOf, x1, x2 };
}

/** Slot count and scale: as many slots as fit (2..6) without shrinking below full width. */
export function slotLayout(systems: VideoSystem[], x1: number, x2: number, area: Rect): { n: number; k: number; slots: Rect[] } {
  const maxH = Math.max(1, ...systems.map((s) => s.bottom - s.top));
  const kW = area.w / Math.max(1, x2 - x1);
  const n = Math.max(2, Math.min(6, Math.floor(area.h / (maxH * kW))));
  const slotH = area.h / n;
  const k = Math.min(kW, slotH / maxH);
  const slots = Array.from({ length: n }, (_, j) => ({ x: area.x, y: area.y + j * slotH, w: area.w, h: slotH }));
  return { n, k, slots };
}

/** Which system each slot shows while `current` is played; slots past the end show earlier systems. */
export function slotSystems(current: number, n: number, count: number): (number | null)[] {
  const out: (number | null)[] = Array(n).fill(null);
  for (let s = current; s < Math.min(count, current + n); s++) out[s % n] = s;
  for (let s = current - 1; s >= Math.max(0, current - n + 1); s--) if (out[s % n] == null) out[s % n] = s;
  return out;
}

/** Index of the time entry that is active at q (same rule as Wijzer.time2x). */
export function entryAt(times: TimeEntry[], q: number): number {
  for (let i = times.length - 1; i >= 0; i--) if (!(times[i].t > q)) return i;
  return 0;
}

/** Moments where the played system changes, for cross-fading slots. */
export function systemChanges(times: TimeEntry[], systemOf: number[]): { t: number; from: number; to: number }[] {
  const out: { t: number; from: number; to: number }[] = [];
  for (let i = 1; i < times.length; i++) {
    const a = systemOf[times[i - 1].mix] ?? 0, b = systemOf[times[i].mix] ?? 0;
    if (a !== b) out.push({ t: times[i].t, from: a, to: b });
  }
  return out;
}

export type Timeline = { intro: number; fade: number; outro: number; a: number; b: number; total: number };
/** Video timeline: intro card, take seconds a..b, closing card. */
export function makeTimeline(a: number, b: number, intro = 3, outro = 4, fade = 0.5): Timeline {
  return { intro, fade, outro, a, b, total: intro + (b - a) + outro };
}
/** What a frame at video time v shows. */
export function phaseAt(v: number, tl: Timeline): { intro: number; outro: number; t: number } {
  const d = tl.b - tl.a;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return {
    intro: v < tl.intro ? clamp((tl.intro - v) / tl.fade) : 0,
    outro: clamp((v - tl.intro - d) / tl.fade),
    t: tl.a + Math.max(0, Math.min(d, v - tl.intro)),
  };
}
/** Gain of the take audio at video time v (short fade in, 0.8 s fade out). */
export function audioGain(v: number, tl: Timeline): number {
  const u = v - tl.intro, d = tl.b - tl.a;
  if (u < 0 || u >= d) return 0;
  return Math.min(1, u / 0.03, (d - u) / 0.8);
}

// ---------- browser rendering ----------

export type VideoMeta = {
  title: string;
  subtitle: string;
  date: string;
  /** Shown on the closing card when set, e.g. [["音准", "92"], ["跟拍", "88"]]. */
  scores?: [string, string][];
  closing: string;
  footer: string;
};
export type VideoInput = {
  layout: VideoLayout;
  pages: Map<number, HTMLCanvasElement>;
  offsets: PageOffset[];
  measures: MeasureRect[];
  times: TimeEntry[];
  mediaUrl: string;
  a: number;
  b: number;
  meta: VideoMeta;
};

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",system-ui,sans-serif';

function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number): void {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (s > 14 && ctx.measureText(text).width > maxW) { s -= 2; ctx.font = `${weight} ${s}px ${FONT}`; }
}

function drawCard(ctx: CanvasRenderingContext2D, W: number, H: number, meta: VideoMeta, closing: boolean): void {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#0f172a");
  g.addColorStop(1, "#1e3a8a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2, unit = Math.min(W, H) / 1080;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Staff-line ornament.
  ctx.strokeStyle = "rgba(147,197,253,0.35)";
  ctx.lineWidth = 2 * unit;
  for (let i = 0; i < 5; i++) {
    const y = H / 2 - 190 * unit + i * 12 * unit;
    ctx.beginPath(); ctx.moveTo(cx - 160 * unit, y); ctx.lineTo(cx + 160 * unit, y); ctx.stroke();
  }
  let y = H / 2 - 40 * unit;
  if (closing && meta.closing) {
    ctx.fillStyle = "#93c5fd";
    fitFont(ctx, meta.closing, 500, 40 * unit, W * 0.8);
    ctx.fillText(meta.closing, cx, H / 2 - 110 * unit);
  }
  ctx.fillStyle = "#ffffff";
  fitFont(ctx, meta.title, 700, (closing ? 64 : 84) * unit, W * 0.86);
  ctx.fillText(meta.title, cx, y);
  y += 90 * unit;
  if (meta.subtitle) {
    ctx.fillStyle = "#bfdbfe";
    fitFont(ctx, meta.subtitle, 500, 40 * unit, W * 0.8);
    ctx.fillText(meta.subtitle, cx, y);
    y += 70 * unit;
  }
  if (closing && meta.scores?.length) {
    const n = meta.scores.length, tw = 220 * unit, gap = 28 * unit;
    const x0 = cx - (n * tw + (n - 1) * gap) / 2;
    y += 30 * unit;
    meta.scores.forEach(([label, value], i) => {
      const x = x0 + i * (tw + gap);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath(); ctx.roundRect(x, y, tw, 150 * unit, 18 * unit); ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${64 * unit}px ${FONT}`;
      ctx.fillText(value, x + tw / 2, y + 62 * unit);
      ctx.fillStyle = "#bfdbfe";
      ctx.font = `500 ${28 * unit}px ${FONT}`;
      ctx.fillText(label, x + tw / 2, y + 118 * unit);
    });
    y += 180 * unit;
  }
  if (meta.date) {
    ctx.fillStyle = "rgba(191,219,254,0.8)";
    ctx.font = `400 ${30 * unit}px ${FONT}`;
    ctx.fillText(meta.date, cx, y);
  }
  if (meta.footer) {
    ctx.fillStyle = "rgba(191,219,254,0.6)";
    ctx.font = `400 ${26 * unit}px ${FONT}`;
    ctx.fillText(meta.footer, cx, H - 70 * unit);
  }
}

type Prepared = {
  W: number; H: number; layout: VideoLayout;
  systems: VideoSystem[]; systemOf: number[]; x1: number; x2: number;
  n: number; k: number; slots: Rect[];
  changes: { t: number; from: number; to: number }[];
};

function prepare(inp: VideoInput): Prepared {
  const { w: W, h: H } = FRAME[inp.layout];
  const vs = videoSystems(inp.measures, inp.offsets);
  const sl = slotLayout(vs.systems, vs.x1, vs.x2, CONTENT[inp.layout]);
  return { W, H, layout: inp.layout, ...vs, ...sl, changes: systemChanges(inp.times, vs.systemOf) };
}

function bandRect(p: Prepared, s: number, slot: Rect): Rect {
  const sys = p.systems[s];
  const w = (p.x2 - p.x1) * p.k, h = (sys.bottom - sys.top) * p.k;
  return { x: slot.x + (slot.w - w) / 2, y: slot.y + (slot.h - h) / 2, w, h };
}

function drawBand(ctx: CanvasRenderingContext2D, inp: VideoInput, p: Prepared, s: number, slot: Rect, alpha: number): void {
  const sys = p.systems[s];
  const off = inp.offsets.find((o) => o.page === sys.page);
  const c = inp.pages.get(sys.page);
  if (!off || !c || alpha <= 0) return;
  const d = bandRect(p, s, slot);
  const sx = c.width / off.w, sy = c.height / off.h;
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, p.x1 * sx, (sys.top - off.y) * sy, (p.x2 - p.x1) * sx, (sys.bottom - sys.top) * sy, d.x, d.y, d.w, d.h);
  ctx.globalAlpha = 1;
}

function drawShade(ctx: CanvasRenderingContext2D, r: Rect, k: number): void {
  const pad = 3 * k;
  const x = r.x - pad, y = r.y - pad * 2, w = r.w + pad * 2, h = r.h + pad * 4;
  const rad = Math.min(12, 6 * k + 4);
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "rgba(0,224,255,0.30)");
  g.addColorStop(1, "rgba(0,150,255,0.18)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(0,170,255,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); ctx.stroke();
}

function drawScore(ctx: CanvasRenderingContext2D, inp: VideoInput, p: Prepared, t: number, progress: number): void {
  const { W, H } = p;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  // Title line.
  ctx.textBaseline = "middle";
  if (p.layout === "landscape") {
    ctx.textAlign = "left"; ctx.fillStyle = "#1f2937";
    fitFont(ctx, inp.meta.title, 600, 34, W * 0.6);
    ctx.fillText(inp.meta.title, 48, 56);
    if (inp.meta.subtitle) {
      ctx.textAlign = "right"; ctx.fillStyle = "#6b7280";
      fitFont(ctx, inp.meta.subtitle, 400, 26, W * 0.34);
      ctx.fillText(inp.meta.subtitle, W - 48, 56);
    }
  } else {
    ctx.textAlign = "center"; ctx.fillStyle = "#1f2937";
    fitFont(ctx, inp.meta.title, 700, 50, W * 0.9);
    ctx.fillText(inp.meta.title, W / 2, 110);
    if (inp.meta.subtitle) {
      ctx.fillStyle = "#6b7280";
      fitFont(ctx, inp.meta.subtitle, 400, 32, W * 0.9);
      ctx.fillText(inp.meta.subtitle, W / 2, 168);
    }
  }
  // Score bands with a short cross-fade when a slot changes system.
  const q = t + VIDEO_LEAD_SEC;
  const ix = entryAt(inp.times, q);
  const mix = inp.times[ix]?.mix ?? 0;
  const cur = p.systemOf[mix] ?? 0;
  const now = slotSystems(cur, p.n, p.systems.length);
  let change: { t: number; from: number } | null = null;
  for (let i = p.changes.length - 1; i >= 0; i--) if (p.changes[i].t <= q) { change = p.changes[i]; break; }
  const f = change ? Math.min(1, (q - change.t) / SLOT_FADE_SEC) : 1;
  const before = change && f < 1 ? slotSystems(change.from, p.n, p.systems.length) : null;
  for (let j = 0; j < p.n; j++) {
    const s = now[j], old = before?.[j];
    if (before && old != null && old !== s) drawBand(ctx, inp, p, old, p.slots[j], 1 - f);
    if (s != null) drawBand(ctx, inp, p, s, p.slots[j], before && old !== s ? f : 1);
  }
  // Shade on the measure being played.
  const m = inp.measures[mix];
  const j = now.indexOf(cur);
  if (m && j >= 0) {
    const sys = p.systems[cur], d = bandRect(p, cur, p.slots[j]);
    drawShade(ctx, { x: d.x + (m.x - p.x1) * p.k, y: d.y + (m.y - sys.top) * p.k, w: m.w * p.k, h: m.h * p.k }, p.k);
  }
  // Progress bar.
  ctx.fillStyle = "#e5e7eb";
  ctx.fillRect(0, H - 6, W, 6);
  ctx.fillStyle = "#2563eb";
  ctx.fillRect(0, H - 6, W * Math.max(0, Math.min(1, progress)), 6);
}

/** Draw the frame at video time v. */
export function drawFrame(ctx: CanvasRenderingContext2D, inp: VideoInput, p: Prepared, tl: Timeline, v: number): void {
  const ph = phaseAt(v, tl);
  const prog = (ph.t - tl.a) / Math.max(1e-6, tl.b - tl.a);
  if (ph.intro >= 1) { drawCard(ctx, p.W, p.H, inp.meta, false); return; }
  if (ph.outro >= 1) { drawCard(ctx, p.W, p.H, inp.meta, true); return; }
  drawScore(ctx, inp, p, ph.t, prog);
  const card = ph.intro > 0 ? { a: ph.intro, closing: false } : ph.outro > 0 ? { a: ph.outro, closing: true } : null;
  if (card) {
    ctx.globalAlpha = card.a;
    drawCard(ctx, p.W, p.H, inp.meta, card.closing);
    ctx.globalAlpha = 1;
  }
}

/** A preview canvas of one frame (for the export dialog). */
export function previewFrame(inp: VideoInput, v: number): HTMLCanvasElement {
  const p = prepare(inp);
  const tl = makeTimeline(inp.a, inp.b);
  const c = document.createElement("canvas");
  c.width = p.W; c.height = p.H;
  drawFrame(c.getContext("2d")!, inp, p, tl, v);
  return c;
}

export function videoSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder === "function"
    && typeof CanvasRenderingContext2D.prototype.roundRect === "function";
}

/** Render and encode the whole video. Throws an AbortError when `signal` aborts. */
export async function exportScoreVideo(inp: VideoInput, onProgress: (done: number) => void, signal?: AbortSignal):
  Promise<{ blob: Blob; videoCodec: string; seconds: number }> {
  const mb = await import("mediabunny");
  const p = prepare(inp);
  const tl = makeTimeline(inp.a, inp.b);
  const SR = 48000;

  // Decode the take once; Web Audio resamples it to SR.
  const raw = await (await fetch(inp.mediaUrl)).arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, SR).decodeAudioData(raw);
  const ch = Math.min(2, decoded.numberOfChannels);
  const src = Array.from({ length: ch }, (_, i) => decoded.getChannelData(i));

  const bitrate = inp.layout === "landscape" ? 2_500_000 : 2_200_000;
  const videoCodec = await mb.getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1"], { width: p.W, height: p.H, bitrate });
  if (!videoCodec) throw new Error("NO_VIDEO_CODEC");
  if (!(await mb.canEncodeAudio("aac", { numberOfChannels: ch, sampleRate: SR }))) {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
  }

  const canvas = document.createElement("canvas");
  canvas.width = p.W; canvas.height = p.H;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const video = new mb.CanvasSource(canvas, { codec: videoCodec, bitrate, keyFrameInterval: 2 });
  const audio = new mb.AudioBufferSource({ codec: "aac", bitrate: 160_000 });
  output.addVideoTrack(video, { frameRate: FPS });
  output.addAudioTrack(audio);
  await output.start();

  const totalSamples = Math.ceil(tl.total * SR);
  const CHUNK = SR / 2;
  let audioPos = 0;
  const pushAudioUntil = async (sec: number) => {
    while (audioPos < totalSamples && audioPos < sec * SR) {
      const len = Math.min(CHUNK, totalSamples - audioPos);
      const buf = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: SR });
      for (let c = 0; c < ch; c++) {
        const out = buf.getChannelData(c);
        for (let i = 0; i < len; i++) {
          const v = (audioPos + i) / SR;
          const g = audioGain(v, tl);
          if (g > 0) out[i] = g * (src[c][Math.round((tl.a + v - tl.intro) * SR)] ?? 0);
        }
      }
      await audio.add(buf);
      audioPos += len;
    }
  };

  try {
    const frames = Math.ceil(tl.total * FPS);
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      const v = f / FPS;
      await pushAudioUntil(v + 1);
      drawFrame(ctx, inp, p, tl, v);
      await video.add(v, 1 / FPS);
      if (f % 15 === 0) onProgress(f / frames);
    }
    await pushAudioUntil(tl.total + 1);
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  }
  onProgress(1);
  const buf = target.buffer;
  if (!buf) throw new Error("EMPTY_OUTPUT");
  return { blob: new Blob([buf], { type: "video/mp4" }), videoCodec, seconds: tl.total };
}
