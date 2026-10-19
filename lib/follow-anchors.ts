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
  const ivs = [...intervals].filter((i) => i.endSec > i.startSec).sort((a, b) => a.measure - b.measure);
  const byMeasure = new Map<number, FollowInterval>(ivs.map((i) => [i.measure, i]));
  const played = new Map<number, FollowOnset[]>();
  for (const n of notes) {
    if (n.performedSec == null || !Number.isFinite(n.performedSec) || !Number.isFinite(n.expectedSec)) continue;
    if (n.matchStatus === "uncertain" || n.timingStatus === "uncertain") continue;
    const iv = byMeasure.get(n.measure);
    if (!iv) continue;
    // expectedSec is on the un-shifted grid; intervals carry the applied sync offset.
    const lo = iv.startSec - offsetSec, hi = iv.endSec - offsetSec;
    const frac = Math.max(0, Math.min(0.999, (n.expectedSec - lo) / (hi - lo)));
    const list = played.get(n.measure) ?? [];
    list.push({ measure: n.measure, frac, sec: n.performedSec });
    played.set(n.measure, list);
  }
  const starts: { measure: number; startSec: number }[] = [];
  for (const iv of ivs) {
    const prev = starts.length ? starts[starts.length - 1].startSec : -Infinity;
    const down = (played.get(iv.measure) ?? []).filter((o) => o.frac < DOWNBEAT_FRAC).sort((a, b) => a.sec - b.sec)[0];
    const start = down && down.sec > prev ? down.sec : iv.startSec;
    if (start > prev) starts.push({ measure: iv.measure, startSec: start });
  }
  const onsets: FollowOnset[] = [];
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].startSec : byMeasure.get(s.measure)!.endSec;
    // Only onsets inside this measure's span, so a click never lands the shade elsewhere.
    for (const o of played.get(s.measure) ?? []) if (o.sec >= s.startSec && o.sec < end) onsets.push(o);
  });
  return { starts, onsets };
}
