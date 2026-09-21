/**
 * synpdf-wijzer.ts — 光标跟随(Wijzer)TypeScript 移植
 *
 * 衍生自 Wim Vree 的 synpdf.js rev.194 Wijzer 类, GPL-2.0-or-later。
 * 原版依赖 jQuery DOM 与媒体播放器; 这里只保留纯几何/时间映射,
 * 渲染由 React 覆盖层负责, 时钟由 page 的 rAF/媒体元素驱动。
 */
import type { PageAnalysis } from "./synpdf-core";

export interface MeasureRect { x: number; y: number; w: number; h: number; }
export interface TimeEntry { t: number; mix: number; }
export interface CursorRect { x: number; y: number; w: number; h: number; measure: number; }

const TOFF = 0.01;

/** PageAnalysis → 小节矩形(等价原版 knip → deMaten) */
export function buildMeasures(a: PageAnalysis): MeasureRect[] {
  const out: MeasureRect[] = [];
  for (const s of a.systems) {
    const y = s.cs[0];
    const h = s.cs[s.cs.length - 1] - y;
    const bars = (a.bars[a.systems.indexOf(s)] ?? []) as number[];
    for (let i = 0; i + 1 < bars.length; i++) {
      out.push({ x: bars[i], y, w: bars[i + 1] - bars[i], h });
    }
  }
  return out;
}

export class Wijzer {
  measures: MeasureRect[] = [];
  times: TimeEntry[] = [];
  cursor: CursorRect | null = null;
  loopStart = 0;
  loopEnd = 0;
  loopOn = false;

  reset(a: PageAnalysis): void {
    this.measures = buildMeasures(a);
    this.times = [];
    this.cursor = null;
  }

  /** 时间→光标(等价原版 time2x, 含小节内插值) */
  time2x(t: number): CursorRect | null {
    const T = this.times;
    if (!T.length || !this.measures.length) return null;
    let ix = -1;
    for (let i = T.length - 1; i >= 0; i--) {
      if (!(T[i].t > t)) { ix = i; break; }
    }
    if (ix < 0) ix = 0;
    const cur = T[ix];
    const m = this.measures[cur.mix];
    if (!m) return null;
    let frac = 0;
    const nxt = T[ix + 1];
    if (nxt && nxt.t > cur.t && nxt.mix === cur.mix) {
      frac = (t - cur.t) / (nxt.t - cur.t);
      frac = Math.max(0, Math.min(1, frac));
    }
    this.cursor = {
      x: m.x + m.w * frac,
      y: m.y,
      w: Math.max(2, m.w * 0.06),
      h: m.h,
      measure: cur.mix,
    };
    return this.cursor;
  }

  /** 点击→时间(等价原版 x2time, 返回秒 + 小节号) */
  x2time(x: number, y: number): { t: number; measure: number } | null {
    for (let d = 0; d < this.measures.length; d++) {
      const e = this.measures[d];
      if (y > e.y + e.h || x > e.x + e.w) continue;
      if (x < e.x) return null;
      for (let b = 0; b < this.times.length; b++) {
        if (d === this.times[b].mix) {
          const t0 = this.times[b].t;
          const t1 = b + 1 < this.times.length ? this.times[b + 1].t : t0 + 2;
          return { t: t0 + (t1 - t0) * ((x - e.x) / e.w) + TOFF, measure: d };
        }
      }
      return { t: TOFF, measure: d };
    }
    return null;
  }

  /** 上/下一小节(等价 goMsre), 返回目标时间 */
  goMsre(dir: 1 | -1, now: number): number {
    if (!this.times.length) return now;
    let ix = 0;
    for (let i = 0; i < this.times.length; i++) {
      if (this.times[i].t <= now) ix = i;
    }
    ix += dir;
    if (ix < 0) ix = this.times.length - 1;
    if (ix >= this.times.length) ix = 0;
    return this.times[ix].t + TOFF;
  }

  /** TAP 建图: 在当前播放时刻打一个小节起点 */
  tap(t: number): TimeEntry {
    const e = { t: Math.round(1e3 * t) / 1e3, mix: this.times.length };
    if (e.mix >= this.measures.length) e.mix = this.measures.length - 1;
    this.times.push(e);
    return e;
  }

  /** 载入 timing JSON(等价 preload 的 times_arr) */
  loadTimes(times: TimeEntry[]): void {
    this.times = times.map((e) => ({ t: 1 * e.t, mix: 1 * e.mix }));
  }

  /** A-B 循环(秒) */
  setLoop(a: number, b: number): void {
    this.loopStart = a;
    this.loopEnd = b;
    this.loopOn = b > a;
  }

  /** 循环钳制: 返回钳制后的播放时刻 */
  clampLoop(t: number): number {
    if (!this.loopOn) return t;
    if (t > this.loopEnd) return this.loopStart + TOFF;
    if (t < this.loopStart) return this.loopStart + TOFF;
    return t;
  }
}
