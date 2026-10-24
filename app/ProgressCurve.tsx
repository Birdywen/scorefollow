"use client";
/** Pitch / rhythm score of every analyzed take of the current piece, oldest to newest (signed-in users). */
import { useEffect, useState } from "react";
import styles from "./progress-curve.module.css";
import { fetchHistory, type HistoryPoint } from "../lib/cloud-sync";

const W = 320, H = 150, L = 26, R = 10, T = 8, B = 22;

function path(points: HistoryPoint[], key: "pitch" | "rhythm", x: (i: number) => number, y: (v: number) => number): string {
  let d = "", pen = false;
  points.forEach((p, i) => {
    const v = p[key];
    if (v == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export default function ProgressCurve({ lang, base, scoreKey, refreshKey }: { lang: "zh" | "en"; base: string; scoreKey: string; refreshKey: string }) {
  const zh = lang === "zh";
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || !scoreKey) return;
    let cancelled = false;
    setFailed(false);
    fetchHistory(base, scoreKey).then((p) => { if (!cancelled) setPoints(p); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, base, scoreKey, refreshKey]);

  const n = points?.length ?? 0;
  const x = (i: number) => (n <= 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  const day = (t: number) => new Date(t).toLocaleDateString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric" });
  const last = points?.[n - 1], first = points?.[0];
  const delta = (k: "pitch" | "rhythm") => (first?.[k] != null && last?.[k] != null && n > 1 ? Math.round(last[k]! - first[k]!) : null);
  const sign = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `${v}` : "±0");

  return <details className={styles.fold} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
    <summary>📈 {zh ? "进步曲线" : "Progress"}</summary>
    {!scoreKey ? <p className={styles.note}>{zh ? "先载入乐谱，才能按曲子查看历次分数。" : "Load a score to see its history."}</p>
      : failed ? <p className={styles.note} role="alert">{zh ? "读取历史失败，稍后再试。" : "Could not load the history; try again later."}</p>
      : points == null ? <p className={styles.note}>{zh ? "加载中…" : "Loading…"}</p>
      : n < 2 ? <p className={styles.note}>{zh ? "这首曲子至少分析 2 次才能画出曲线（已同步的分析：" : "Analyze this piece at least twice to draw a curve (synced analyses: "}{n}{zh ? "）。" : ")."}</p>
      : <>
        <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={zh ? `音准与节奏分数，共 ${n} 次，最近一次音准 ${last?.pitch ?? "—"}、节奏 ${last?.rhythm ?? "—"}` : `Pitch and rhythm scores over ${n} analyses; latest pitch ${last?.pitch ?? "—"}, rhythm ${last?.rhythm ?? "—"}`}>
          {[0, 50, 100].map((v) => <g key={v}><line className={styles.axis} x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text className={styles.tick} x={L - 4} y={y(v) + 3} textAnchor="end">{v}</text></g>)}
          <path className={styles.pitch} d={path(points, "pitch", x, y)} />
          <path className={styles.rhythm} d={path(points, "rhythm", x, y)} />
          {points.map((p, i) => <g key={p.id}>
            {p.pitch != null && <circle className={styles.dotPitch} cx={x(i)} cy={y(p.pitch)} r={3}><title>{`${day(p.t)} ${zh ? "音准" : "Pitch"} ${Math.round(p.pitch)}`}</title></circle>}
            {p.rhythm != null && <circle className={styles.dotRhythm} cx={x(i)} cy={y(p.rhythm)} r={3}><title>{`${day(p.t)} ${zh ? "节奏" : "Rhythm"} ${Math.round(p.rhythm)}`}</title></circle>}
          </g>)}
          <text className={styles.tick} x={x(0)} y={H - 6} textAnchor="start">{day(points[0].t)}</text>
          <text className={styles.tick} x={x(n - 1)} y={H - 6} textAnchor="end">{day(points[n - 1].t)}</text>
        </svg>
        <div className={styles.legend}>
          <span><b style={{ color: "#2563eb" }}>━</b> {zh ? "音准" : "Pitch"} {last?.pitch != null ? Math.round(last.pitch) : "—"}{delta("pitch") != null && ` (${zh ? "较首次 " : "vs first "}${sign(delta("pitch")!)})`}</span>
          <span><b style={{ color: "#d97706" }}>╌</b> {zh ? "节奏" : "Rhythm"} {last?.rhythm != null ? Math.round(last.rhythm) : "—"}{delta("rhythm") != null && ` (${zh ? "较首次 " : "vs first "}${sign(delta("rhythm")!)})`}</span>
        </div>
      </>}
  </details>;
}
