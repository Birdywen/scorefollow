"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

// Chromatic tuner: mic -> autocorrelation pitch -> note + cents.
// Same detector family as analysis_service track(): time-domain autocorr
// with parabolic interpolation, RMS gate, A4 = 440 Hz fixed.
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MIN_HZ = 55;   // below cello C1-ish floor, reject rumble
const MAX_HZ = 1400; // above violin E7-ish ceiling, reject hiss
const IN_TUNE_CENTS = 6;

export function freqToReading(freq: number): { note: string; cents: number; hz: number } {
  const m = 69 + 12 * Math.log2(freq / 440);
  const r = Math.round(m);
  return { note: `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`, cents: Math.round((m - r) * 100), hz: freq };
}

export function detectPitch(buf: Float32Array, sampleRate: number): number | null {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  if (Math.sqrt(sum / buf.length) < 0.01) return null; // silence gate
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxLag = Math.min(buf.length >> 1, Math.ceil(sampleRate / MIN_HZ));
  let bestLag = -1, bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < buf.length; i++) corr += buf[i] * buf[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  if (bestLag < 0) return null;
  // Parabolic interpolation around the peak for sub-sample lag.
  const c = (lag: number) => {
    let v = 0;
    for (let i = 0; i + lag < buf.length; i++) v += buf[i] * buf[i + lag];
    return v;
  };
  const y0 = c(bestLag - 1), y1 = bestCorr, y2 = c(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (y0 - y2) / (2 * denom) : 0;
  const lag = Math.abs(shift) < 1 ? bestLag + shift : bestLag;
  return sampleRate / lag;
}

export default function TunerPanel({ lang, onClose }: { lang: "zh" | "en"; onClose: () => void }) {
  const zh = lang === "zh";
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [reading, setReading] = useState<{ note: string; cents: number; hz: number } | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const smoothRef = useRef<number[]>([]);

  useEffect(() => () => { void stop(); }, []);

  async function start() {
    try {
      setError("");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(zh ? "浏览器不支持麦克风" : "Microphone not supported");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      streamRef.current = stream;
      ctxRef.current = ctx;
      setRunning(true);
      const loop = () => {
        rafRef.current = requestAnimationFrame(loop);
        const now = performance.now();
        if (now - lastRef.current < 100) return; // 10 fps is plenty for a needle
        lastRef.current = now;
        analyser.getFloatTimeDomainData(buf);
        const f = detectPitch(buf, ctx.sampleRate);
        if (f == null) { setReading(null); return; }
        const hist = smoothRef.current;
        hist.push(f);
        if (hist.length > 3) hist.shift();
        const med = [...hist].sort((a, b) => a - b)[hist.length >> 1];
        setReading(freqToReading(med));
      };
      loop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void stop();
    }
  }

  async function stop() {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    smoothRef.current = [];
    if (ctxRef.current) { try { await ctxRef.current.close(); } catch { /* noop */ } ctxRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    setRunning(false);
  }

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
