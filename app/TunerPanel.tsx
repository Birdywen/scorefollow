"use client";
import { IN_TUNE_CENTS, useTuner } from "./hooks/useTuner";
import styles from "./page.module.css";

// 音高检测算法已抽取至 app/hooks/useTuner.ts（detectPitch / freqToReading，原样保留）。
// 兼容旧导入：此前两者从本文件导出。
export { detectPitch, freqToReading, IN_TUNE_CENTS, MAX_HZ, MIN_HZ } from "./hooks/useTuner";

export default function TunerPanel({ lang, onClose }: { lang: "zh" | "en"; onClose: () => void }) {
  const zh = lang === "zh";
  const { state, reading, error, start, stop } = useTuner({
    onError: () => {},
  });

  const running = state === "running" || state === "requesting" || state === "stopping";

  const cents = reading?.cents ?? 0;
  const inTune = reading != null && Math.abs(cents) <= IN_TUNE_CENTS;
  const needlePct = Math.max(0, Math.min(100, 50 + cents)); // -50..+50 cents across the bar

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <section className={styles.exportDialog} role="dialog" aria-modal="true" aria-label={zh ? "调音器" : "Tuner"} onClick={(e) => e.stopPropagation()}>
        <div className={styles.exportHead}>
          <div><h2>🎚 {zh ? "调音器" : "Tuner"}</h2>
            <p>{zh ? "拨弦或拉弓，对准绿色。A4 = 440 Hz" : "Play a string; aim for green. A4 = 440 Hz"}</p></div>
          <button className={styles.practiceBtn} onClick={onClose} aria-label={zh ? "关闭" : "Close"}>×</button>
        </div>
        <div style={{ textAlign: "center", padding: "12px 0" }}>
          <div style={{ fontSize: 64, fontWeight: 700, color: reading == null ? "#888" : inTune ? "#16a34a" : "#111" }}>
            {reading?.note ?? "—"}
          </div>
          <div style={{ fontSize: 14, color: "#666" }}>
            {reading ? `${reading.hz.toFixed(1)} Hz · ${cents >= 0 ? "+" : ""}${cents} ¢` : zh ? "等待声音…" : "Listening…"}
          </div>
          <div style={{ position: "relative", height: 10, margin: "14px 8px 4px", background: "#e5e7eb", borderRadius: 5 }}>
            <div style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 2, background: "#16a34a" }} />
            {reading && <div style={{ position: "absolute", left: `calc(${needlePct}% - 5px)`, top: -5, width: 10, height: 20, borderRadius: 5, background: inTune ? "#16a34a" : "#dc2626" }} />}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#888", padding: "0 8px" }}>
            <span>-50¢ {zh ? "低" : "flat"}</span><span>+50¢ {zh ? "高" : "sharp"}</span>
          </div>
        </div>
        {error && <p style={{ color: "#dc2626" }}>{error}</p>}
        <div className={styles.exportActions} style={{ justifyContent: "flex-start" }}>
          {running
            ? <button className={styles.practiceBtn} onClick={() => void stop()}>{zh ? "■ 停止" : "■ Stop"}</button>
            : <button className={styles.practicePlay} onClick={() => void start()}>{zh ? "🎤 开始调音" : "🎤 Start"}</button>}
        </div>
      </section>
    </div>
  );
}
