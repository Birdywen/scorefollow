/** "Follow with this take": measure starts and click targets from the measured onsets.
 * A measure starts where its downbeat note was actually played (fallback: the fitted
 * interval start); every reliably matched note becomes a click target at its played time,
 * placed inside the measure by its written position (frac 0..1). */

export type FollowNote = {
  measure: number; expectedSec: number; performedSec: number | null;
  matchStatus?: string; timingStatus?: string;
};
export type FollowInterval = { measure: number; startSec: number; endSec: number };
export type FollowOnset = { measure: number; frac: number; sec: number };

const DOWNBEAT_FRAC = 0.03;

export function followAnchors(intervals: FollowInterval[], notes: FollowNote[], offsetSec = 0):
  { starts: { measure: number; startSec: number }[]; onsets: FollowOnset[] } {
  // Time order, one entry per played pass: with repeats unfolded a measure appears more than once.
  const ivs = [...intervals].filter((i) => i.endSec > i.startSec).sort((a, b) => a.startSec - b.startSec);
  const played: FollowOnset[][] = ivs.map(() => []);
  for (const n of notes) {
    if (n.performedSec == null || !Number.isFinite(n.performedSec) || !Number.isFinite(n.expectedSec)) continue;
    if (n.matchStatus === "uncertain" || n.timingStatus === "uncertain") continue;
    // expectedSec is on the un-shifted grid; intervals carry the applied sync offset.
    const e = n.expectedSec + offsetSec;
    // The pass of this measure whose span holds the written time (50 ms rounding slack).
    let k = -1, best = 0.05;
    ivs.forEach((iv, i) => {
      if (iv.measure !== n.measure) return;
      const d = e < iv.startSec ? iv.startSec - e : e >= iv.endSec ? e - iv.endSec + 1e-9 : 0;
      if (d < best) { best = d; k = i; }
    });
    if (k < 0) continue;
    const iv = ivs[k];
    const frac = Math.max(0, Math.min(0.999, (e - iv.startSec) / (iv.endSec - iv.startSec)));
    played[k].push({ measure: n.measure, frac, sec: n.performedSec });
  }
  const starts: { measure: number; startSec: number }[] = [];
  const kept: number[] = [];
  ivs.forEach((iv, k) => {
    const prev = starts.length ? starts[starts.length - 1].startSec : -Infinity;
    const down = played[k].filter((o) => o.frac < DOWNBEAT_FRAC).sort((a, b) => a.sec - b.sec)[0];
    const start = down && down.sec > prev ? down.sec : iv.startSec;
    if (start > prev) { starts.push({ measure: iv.measure, startSec: start }); kept.push(k); }
  });
  const onsets: FollowOnset[] = [];
  starts.forEach((s, j) => {
    const k = kept[j];
    const end = j + 1 < starts.length ? starts[j + 1].startSec : ivs[k].endSec;
    // Only onsets inside this pass's span, so a click never lands the shade elsewhere.
    for (const o of played[k]) if (o.sec >= s.startSec && o.sec < end) onsets.push(o);
  });
  return { starts, onsets };
}
