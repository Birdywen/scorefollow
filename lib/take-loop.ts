/**
 * take-loop.ts — loop a bar range of a followed take.
 * Bars are 0-based measure indexes (wijzer mix); times are the take's measure starts in play order,
 * so a bar that is repeated has one entry per pass.
 */
import type { TimeEntry } from "./synpdf-wijzer";

export type LoopWindow = { start: number; end: number };

/** Seconds kept before the first bar so its first note is not clipped. */
export const LOOP_PRE_SEC = 0.15;

/**
 * Time window that plays bars from..to once. With repeats, picks the pass that contains `near`
 * (the playhead), else the next pass after it, else the first. `endSec` caps the last bar when
 * it has no following start (end of the take).
 */
export function barLoopWindow(times: TimeEntry[], from: number, to: number, near = 0, endSec = Infinity): LoopWindow | null {
  if (from > to) [from, to] = [to, from];
  const T = [...times].sort((a, b) => a.t - b.t);
  const passes: LoopWindow[] = [];
  for (let i = 0; i < T.length; i++) {
    if (T[i].mix !== from) continue;
    let k = -1;
    for (let j = i; j < T.length; j++) if (T[j].mix === to) { k = j; break; }
    if (k < 0) continue;
    let end: number;
    if (k + 1 < T.length) end = T[k + 1].t;
    else {
      const prev = k > 0 ? T[k].t - T[k - 1].t : 2;
      end = Math.min(endSec, T[k].t + Math.max(0.5, prev));
    }
    end = Math.min(end, endSec);
    const start = Math.max(0, T[i].t - LOOP_PRE_SEC);
    if (end > start + 0.2) passes.push({ start, end });
  }
  if (!passes.length) return null;
  return passes.find((p) => near >= p.start && near < p.end)
    ?? passes.find((p) => p.start >= near)
    ?? passes[0];
}
