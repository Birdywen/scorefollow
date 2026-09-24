"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./performance.module.css";
import {
  attachRecordingStart, createSession, deleteTakeBlob, loadTakeBlob, measureAndBeatAt,
  saveTakeBlob, validateTakeSync, type PracticeSession,
} from "@/lib/practice-sync";

type Note = {
  id: string; measure: number; pitchMidi: number; expectedSec: number;
  performedSec: number | null; pitchErrorCents: number | null;
  timingErrorMs: number | null; confidence: number; status: string;
};
type Result = {
  version: string; notes: Note[]; limitations: string[];
  summary: { pitchScore: number | null; rhythmScore: number | null;
    timingOffsetMs: number | null; timingSpreadMs: number | null;
    noteCount: number; measureCount?: number; startMeasure?: number; endMeasure?: number;
    voicedNotes: number; timedNotes: number; confidence: string;
    syncMode?: string; recordedFirstBeatSec?: number | null; estimatedLatencyMs?: number | null; coveredSec?: number };
};
type Take = {
  id: string; name: string; createdAt: number; durationSec: number;
  startMeasure: number; bpm: number; beatsPerMeasure: number; countInBeats: number;
  firstBeatAudioSec: number | null; sessionId: string;
  blob: Blob | null; url: string;
  jobId?: string; jobStatus?: string; result?: Result; error?: string;
};
type OmrResult = { musicXml: string; compatible: boolean; reason?: string | null; noteCount: number; measureCount: number; restoredFirstRest: boolean };
type OmrJob = { id: string; status: string; progress?: number; error?: string; result?: OmrResult };

const LOCAL_API = "http://127.0.0.1:8765";
const TAKES_KEY = "sf-takes-meta-v1";
const MAX_TAKES = 3;

function apiBase(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || (location.protocol === "https:" && url.protocol !== "https:"))
    throw new Error("HTTPS 页面需要 HTTPS 分析服务 / HTTPS page requires an HTTPS API");
  return url.href.replace(/\/+$/, "");
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return btoa(chunks.join(""));
}

async function toWav(file: Blob): Promise<string> {
  if (file.size > 40_000_000) throw new Error("录音文件超过 40 MB / Audio file exceeds 40 MB");
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration < 0.4 || decoded.duration > 90) throw new Error("录音须为 0.4–90 秒 / Audio must be 0.4–90 s");
    const rate = 22050;
    const frames = Math.floor(decoded.duration * rate);
    const bytes = new Uint8Array(44 + frames * 2);
    const view = new DataView(bytes.buffer);
    const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, frames * 2, true);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    for (let i = 0; i < frames; i++) {
      const index = i * decoded.sampleRate / rate;
      const lo = Math.floor(index), hi = Math.min(lo + 1, decoded.length - 1), frac = index - lo;
      let sample = 0;
      for (const channel of channels) sample += channel[lo] * (1 - frac) + channel[hi] * frac;
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      view.setInt16(44 + 2 * i, Math.round(sample * 32767), true);
    }
    return encodeBase64(bytes);
  } finally {
    await context.close();
  }
}

function takeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `t-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export default function PerformancePanel({ lang, pdfMeasures, pdfName, pdfBytes, onJump, onClose }: {
  lang: "zh" | "en"; pdfMeasures: number; pdfName: string; pdfBytes: () => ArrayBuffer | null;
  onJump: (measure: number) => void; onClose: () => void;
}) {
  const [api, setApi] = useState(() => {
    if (typeof window === "undefined") return "";
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const saved = localStorage.getItem("sf-analysis-api");
    const oldLocal = saved && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/i.test(saved);
    const oldOrigin = saved && (saved.replace(/\/+$/, "") === location.origin || saved.replace(/\/+$/, "") === `${location.protocol}//${location.hostname}:8765`);
    if (saved && (local || (!oldLocal && !oldOrigin))) return saved;
    return local ? LOCAL_API : `${location.origin}/scorefollow/analysis`;
  });
  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [omrPdf, setOmrPdf] = useState<File | null>(null);
  const [removedFirstRest, setRemovedFirstRest] = useState(false);
  const [removedBeats, setRemovedBeats] = useState(4);
  const [omrJob, setOmrJob] = useState<OmrJob | null>(null);
  const [omrBusy, setOmrBusy] = useState(false);
  const [instrument, setInstrument] = useState("violin");
  const [bpm, setBpm] = useState(80);
  const [startMeasure, setStartMeasure] = useState(1);
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(4);
  const [countInBeats, setCountInBeats] = useState(4);
  const [takes, setTakes] = useState<Take[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [tick, setTick] = useState<{ measure: number; beat: number; elapsedSec: number } | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [busyTakeId, setBusyTakeId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastJumpMeasure = useRef(0);
  const player = useRef<HTMLAudioElement>(null);
  const alive = useRef(true);
  const takesRef = useRef<Take[]>([]);
  takesRef.current = takes;
  const zh = lang === "zh";
  const omrActive = omrBusy || Boolean(omrJob && !["completed", "failed"].includes(omrJob.status));
  const selected = takes.find((t) => t.id === selectedId) ?? null;
  const result = selected?.result;
  const recording = session !== null;

  useEffect(() => { alive.current = true; return () => {
    alive.current = false;
    if (tickTimer.current) clearInterval(tickTimer.current);
    if (recorder.current?.state === "recording") { try { recorder.current.stop(); } catch { /* noop */ } }
    stream.current?.getTracks().forEach((t) => t.stop());
    takesRef.current.forEach((t) => { if (t.url) URL.revokeObjectURL(t.url); });
  }; }, []);

  // Restore takes metadata + blobs.
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem(TAKES_KEY);
        if (!raw) return;
        const meta = JSON.parse(raw) as Omit<Take, "blob" | "url" | "result">[];
        const restored: Take[] = [];
        for (const m of meta.slice(0, MAX_TAKES)) {
          const blob = await loadTakeBlob(m.id).catch(() => null);
          restored.push({ ...m, blob, url: blob ? URL.createObjectURL(blob) : "" });
        }
        if (alive.current && restored.length) {
          setTakes(restored);
          setSelectedId(restored[0].id);
          setBpm(restored[0].bpm);
          setStartMeasure(restored[0].startMeasure);
          setBeatsPerMeasure(restored[0].beatsPerMeasure);
          setCountInBeats(restored[0].countInBeats);
        }
      } catch { /* empty */ }
    })();
  }, []);

  // Persist take metadata (never blobs).
  useEffect(() => {
    try {
      const meta = takes.map(({ blob, url, result, ...rest }) => rest);
      localStorage.setItem(TAKES_KEY, JSON.stringify(meta));
    } catch { /* quota */ }
  }, [takes]);

  // Live metro tick -> PDF cursor while recording.
  useEffect(() => {
    const onTick = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { measure: number } | undefined;
      if (!d || !session) return;
      if (d.measure !== lastJumpMeasure.current) {
        lastJumpMeasure.current = d.measure;
        onJump(d.measure);
      }
    };
    window.addEventListener("synpdf:practice-tick", onTick);
    return () => window.removeEventListener("synpdf:practice-tick", onTick);
  }, [session, onJump]);

  async function refreshDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput"));
    } catch { /* ignore */ }
  }
  useEffect(() => { void refreshDevices(); }, []);

  function updateTake(id: string, patch: Partial<Take>) {
    setTakes((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function addTakeBlob(blob: Blob, sync: { startMeasure: number; bpm: number; beatsPerMeasure: number; countInBeats: number; firstBeatAudioSec: number | null; sessionId: string }, name: string) {
    const durationSec = Math.round(((await durationOf(blob)) || 0) * 10) / 10;
    const id = takeId();
    const url = URL.createObjectURL(blob);
    const take: Take = { id, name, createdAt: Date.now(), durationSec, url, blob, ...sync };
    try { await saveTakeBlob(id, blob); } catch { /* IDB unavailable: keep memory only */ }
    if (!alive.current) return;
    setTakes((prev) => {
      if (prev.length < MAX_TAKES) return [...prev, take];
      // Full: replace the currently selected take so no silent eviction.
      const target = prev.find((t) => t.id === selectedId) ?? prev[0];
      if (target.url) URL.revokeObjectURL(target.url);
      void deleteTakeBlob(target.id).catch(() => undefined);
      return prev.map((t) => (t.id === target.id ? take : t));
    });
    setSelectedId(id);
    setBpm(sync.bpm); setStartMeasure(sync.startMeasure);
    setBeatsPerMeasure(sync.beatsPerMeasure); setCountInBeats(sync.countInBeats);
  }

  function durationOf(blob: Blob): Promise<number> {
    return new Promise((resolve) => {
      const el = document.createElement("audio");
      const url = URL.createObjectURL(blob);
      el.preload = "metadata";
      el.onloadedmetadata = () => { const d = el.duration; URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
      el.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
      el.src = url;
    });
  }

  async function startSyncRecording() {
    if (recording || !xmlFile) { setError(zh ? "请先完成 OMR 或导入 MusicXML，再开始同步录音" : "Complete OMR or import MusicXML before synced recording"); return; }
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 200) { setError("BPM: 30–200"); return; }
    if (!Number.isInteger(startMeasure) || startMeasure < 1) { setError(zh ? "请选择有效的开始小节" : "Select a valid starting measure"); return; }
    if (![2, 3, 4, 6].includes(beatsPerMeasure)) { setError(zh ? "拍号暂支持 2/3/4/6 拍" : "Meter supports 2/3/4/6 beats"); return; }
    if (!Number.isInteger(countInBeats) || countInBeats < 0 || countInBeats > 8) { setError(zh ? "预备拍请输入 0–8" : "Count-in must be 0–8"); return; }
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error(zh ? "浏览器不支持录音；请用上传录音（HTTP 页面可能禁用麦克风）" : "Recording unavailable; upload audio instead (mic may be blocked on HTTP)");
      setError("");
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
      if (!alive.current) { mic.getTracks().forEach((t) => t.stop()); return; }
      stream.current = mic;
      chunks.current = [];
      const rec = new MediaRecorder(mic);
      rec.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      const base = createSession({ startMeasure, bpm, beatsPerMeasure, countInBeats });
      const startedAt = performance.now();
      rec.start(200);
      const sess = attachRecordingStart(base, startedAt);
      recorder.current = rec;
      setSession({ ...sess, state: "recording" });
      lastJumpMeasure.current = 0;
      rec.onstop = () => {
        mic.getTracks().forEach((t) => t.stop()); stream.current = null;
        if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; }
        const metro = (window as unknown as { __sgaMetroPractice?: { stop: () => void } }).__sgaMetroPractice;
        try { metro?.stop(); } catch { /* ignore */ }
        const blob = new Blob(chunks.current, { type: rec.mimeType });
        if (alive.current) {
          setSession(null); setTick(null);
          if (blob.size) {
            const n = takesRef.current.length;
            void addTakeBlob(blob, {
              startMeasure: sess.startMeasure, bpm: sess.bpm, beatsPerMeasure: sess.beatsPerMeasure,
              countInBeats: sess.countInBeats, firstBeatAudioSec: sess.firstBeatAudioSec, sessionId: sess.id,
            }, zh ? `第 ${Math.min(n + 1, MAX_TAKES)} 遍` : `Take ${Math.min(n + 1, MAX_TAKES)}`);
          }
        }
      };
      // Shared clock: metro renders clicks/highlight on sess.firstBeatAt.
      const metro = (window as unknown as { __sgaMetroPractice?: { start: (d: unknown) => boolean } }).__sgaMetroPractice;
      if (metro) {
        metro.start({ startMeasure: sess.startMeasure, bpm: sess.bpm, beatsPerMeasure: sess.beatsPerMeasure, countInBeats: sess.countInBeats, firstBeatAt: sess.firstBeatAt, sessionId: sess.id });
      }
      onJump(startMeasure);
      tickTimer.current = setInterval(() => {
        if (!alive.current) return;
        const info = measureAndBeatAt(sess, performance.now());
        setTick(info);
      }, 120);
    } catch (exc) { setError(exc instanceof Error ? exc.message : String(exc)); }
  }

  function stopSyncRecording() {
    if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; }
    const metro = (window as unknown as { __sgaMetroPractice?: { stop: () => void } }).__sgaMetroPractice;
    try { metro?.stop(); } catch { /* ignore */ }
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  async function analyzeTake(take: Take) {
    if (!take.blob || !xmlFile || !api) { setError(zh ? "请提供分析地址、MusicXML 与录音" : "Provide the API URL, MusicXML and audio"); return; }
    const syncError = take.firstBeatAudioSec != null ? validateTakeSync(take.firstBeatAudioSec) : null;
    if (syncError) { setError(syncError); return; }
    if (xmlFile.size > 1_000_000) { setError("MusicXML > 1 MB"); return; }
    try {
      const base = apiBase(api);
      setBusyTakeId(take.id); setError("");
      updateTake(take.id, { jobStatus: "preparing", error: undefined });
      localStorage.setItem("sf-analysis-api", base);
      const xml = await xmlFile.text();
      const body = {
        scoreXml: xml, audioWavBase64: await toWav(take.blob),
        bpm: take.bpm, instrument, startMeasure: take.startMeasure,
        ...(take.firstBeatAudioSec != null ? { syncMode: "metronome", firstBeatAudioSec: take.firstBeatAudioSec } : {}),
      };
      const response = await fetch(`${base}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      updateTake(take.id, { jobId: data.id, jobStatus: data.status });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!alive.current) return;
        const poll = await fetch(`${base}/jobs/${data.id}`);
        const job = await poll.json();
        if (!poll.ok) throw new Error(job.error || `HTTP ${poll.status}`);
        updateTake(take.id, { jobStatus: job.status, error: job.error });
        if (job.status === "completed" && job.result) { updateTake(take.id, { result: job.result as Result }); break; }
        if (job.status === "failed") break;
      }
    } catch (exc) { if (alive.current) { setError(exc instanceof Error ? exc.message : String(exc)); updateTake(take.id, { jobStatus: "failed" }); } }
    finally { if (alive.current) setBusyTakeId(null); }
  }

  async function recognizePdf() {
    if (!api.trim()) {
      setError(zh ? "请先填写上方的分析服务地址；若浏览器就在这台服务器上，可填 http://127.0.0.1:8765" : "Enter the analysis API URL above. On the server itself, use http://127.0.0.1:8765");
      return;
    }
    if (removedFirstRest && !omrPdf) {
      setError(zh ? "请另选已经手工删除首小节整休止的 PDF" : "Select a separately prepared PDF with the opening rest measure removed");
      return;
    }
    if (removedFirstRest && (!Number.isInteger(removedBeats) || removedBeats < 1 || removedBeats > 16)) {
      setError(zh ? "请输入已删除整休止的小节长度（1–16 个四分音符拍）" : "Enter 1–16 quarter-note beats for the removed measure");
      return;
    }
    try {
      const base = apiBase(api);
      setOmrBusy(true); setOmrJob(null); setXmlFile(null); setError("");
      localStorage.setItem("sf-analysis-api", base);
      const bytes = omrPdf ? await omrPdf.arrayBuffer() : pdfBytes();
      if (!bytes || bytes.byteLength > 15_000_000 || bytes.byteLength < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
        throw new Error(zh ? "请先加载不超过 15 MB 的 PDF" : "Load a PDF smaller than 15 MB first");
      const response = await fetch(`${base}/omr/jobs`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfBase64: encodeBase64(new Uint8Array(bytes)), filename: omrPdf?.name || pdfName || "score.pdf",
          ...(removedFirstRest ? { prependRestBeats: removedBeats } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (alive.current) setOmrJob(data);
    } catch (exc) { if (alive.current) setError(exc instanceof Error ? exc.message : String(exc)); }
    finally { if (alive.current) setOmrBusy(false); }
  }

  useEffect(() => {
    if (!omrJob?.id || ["completed", "failed"].includes(omrJob.status)) return;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${apiBase(api)}/omr/jobs/${omrJob.id}`, { signal: controller.signal });
        const data: OmrJob = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (!alive.current) return;
        setOmrJob(data);
        if (data.status === "completed" && data.result) {
          setXmlFile(new File([data.result.musicXml], (pdfName || "score").replace(/\.pdf$/i, "") + ".musicxml", { type: "application/xml" }));
        }
      } catch (exc) { if (!controller.signal.aborted && alive.current) setError(exc instanceof Error ? exc.message : String(exc)); }
    }, 1500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [api, omrJob?.id, omrJob?.status, pdfName]);

  function downloadMusicXml() {
    const xml = omrJob?.result?.musicXml;
    if (!xml) return;
    const url = URL.createObjectURL(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }));
    const link = document.createElement("a");
    link.href = url; link.download = (pdfName || "score").replace(/\.pdf$/i, "") + ".musicxml";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const scoreMeasures = result?.summary.measureCount ?? result?.notes.reduce((max, note) => Math.max(max, note.measure), 0) ?? 0;
  const canJump = pdfMeasures > 0 && pdfMeasures === scoreMeasures;
  const issues = result?.notes.filter((note) => note.status !== "correct") ?? [];
  function replay(note: Note) {
    // performedSec is a recording timestamp, so seeking is exact for synced takes.
    if (player.current) {
      player.current.currentTime = Math.max(0, (note.performedSec ?? note.expectedSec) - 0.5);
      void player.current.play();
    }
    if (canJump) onJump(note.measure);
  }
  function onTakePlaybackTime(sec: number, take: Take) {
    if (take.firstBeatAudioSec == null) return;
    const scoreSec = sec - take.firstBeatAudioSec;
    if (scoreSec < 0) return;
    const m = take.startMeasure + Math.floor(scoreSec / ((60 / take.bpm) * take.beatsPerMeasure));
    if (m !== lastJumpMeasure.current) { lastJumpMeasure.current = m; onJump(m); }
  }

  return <aside className={styles.panel} aria-label={zh ? "演奏分析" : "Performance analysis"}>
    <div className={styles.head}><strong>{zh ? "演奏分析" : "Performance analysis"}</strong><button onClick={onClose} aria-label={zh ? "关闭" : "Close"}>×</button></div>
    <p className={styles.hint}>{zh ? "节拍器同步录音 · 最多 3 遍 · 只录麦克风" : "Metronome-synced takes · max 3 · mic only"}</p>
    <label className={styles.field}>{zh ? "分析服务地址" : "Analysis API URL"}
      <input type="url" placeholder="https://analysis.example.com" value={api} disabled={omrActive || recording || busyTakeId != null} onChange={(e) => setApi(e.target.value)} /></label>
    {!api.trim() && <p className={styles.hint}>{zh ? "请输入分析服务地址；本站可使用同源 /scorefollow/analysis。" : "Enter the analysis API URL; this site uses /scorefollow/analysis."}</p>}
    <section className={styles.omr} aria-label={zh ? "从 PDF 生成 MusicXML" : "PDF to MusicXML"}>
      <h2>{zh ? "从 PDF 生成 MusicXML" : "PDF to MusicXML"}</h2>
      <p className={styles.hint}>{pdfName ? (zh ? `当前谱面：${pdfName}` : `Loaded score: ${pdfName}`) : (zh ? "可先载入 PDF 谱，或在下面另选 PDF" : "Load a score PDF or choose one below")}</p>
      <label className={styles.field}>{zh ? "另选用于识别的 PDF（可选）" : "PDF for recognition (optional)"}
        <input type="file" accept=".pdf,application/pdf" onChange={(e) => { setOmrPdf(e.target.files?.[0] ?? null); setOmrJob(null); setXmlFile(null); }} /></label>
      <label className={styles.check}><input type="checkbox" checked={removedFirstRest} onChange={(e) => { setRemovedFirstRest(e.target.checked); setOmrJob(null); setXmlFile(null); }} />
        {zh ? "另选 PDF 已手工删除开头的整休止小节；识别后补回" : "Separate PDF has its opening all-rest measure removed; restore it in MusicXML"}</label>
      {removedFirstRest && <label className={styles.field}>{zh ? "删除的小节长度（四分音符拍）" : "Removed measure length (quarter-note beats)"}
        <input type="number" min={1} max={16} step={1} value={removedBeats} onChange={(e) => { setRemovedBeats(Number(e.target.value)); setOmrJob(null); setXmlFile(null); }} /></label>}
      <button className={styles.omrButton} disabled={omrActive || recording || busyTakeId != null || (!omrPdf && !pdfName)} onClick={() => void recognizePdf()}>
        {omrBusy ? (zh ? "准备 PDF…" : "Preparing PDF…") : (zh ? "识别 PDF" : "Recognize PDF")}</button>
      {omrJob && <p role="status" className={styles.hint}>OMR {omrJob.status}{omrJob.progress != null ? ` · ${omrJob.progress}%` : ""}</p>}
      {omrJob?.error && <p className={styles.error} role="alert">{omrJob.error}</p>}
      {omrJob?.result && <div className={styles.omrResult}>
        <p className={styles.hint}>{zh ? `已得到 ${omrJob.result.noteCount} 个可分析音符 · ${omrJob.result.measureCount} 小节` : `${omrJob.result.noteCount} analyzable notes · ${omrJob.result.measureCount} measures`}</p>
        {omrJob.result.compatible && <p className={styles.hint}>{zh ? "已自动作为演奏分析的目标谱；选择起始小节并录音即可。" : "Automatically selected as the target score. Choose a starting measure and record."}</p>}
        {!omrJob.result.compatible && <p className={styles.error}>{zh ? "识别已完成，但当前单声部分析器暂不支持此 MusicXML：" : "Recognition completed, but this MusicXML is not supported by the monophonic analyzer: "}{omrJob.result.reason}</p>}
        <button className={styles.omrButton} onClick={downloadMusicXml}>{zh ? "下载 MusicXML（可选）" : "Download MusicXML (optional)"}</button>
      </div>}
    </section>
    <label className={styles.field}>{zh ? "乐器" : "Instrument"}
      <select value={instrument} onChange={(e) => setInstrument(e.target.value)}>
        <option value="violin">{zh ? "小提琴" : "Violin"}</option><option value="viola">{zh ? "中提琴" : "Viola"}</option>
        <option value="cello">{zh ? "大提琴" : "Cello"}</option>
      </select></label>
    <label className={styles.field}>BPM <input type="number" min={30} max={200} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} /></label>
    <label className={styles.field}>{zh ? "录音从第几小节开始" : "Start measure"}
      <input type="number" min={1} max={omrJob?.result?.measureCount || pdfMeasures || undefined} step={1} value={startMeasure}
        onChange={(e) => setStartMeasure(Number(e.target.value))} /></label>
    <label className={styles.field}>{zh ? "每小节拍数（节拍器/同步用）" : "Beats per measure"}
      <select value={beatsPerMeasure} onChange={(e) => { setBeatsPerMeasure(Number(e.target.value)); setCountInBeats(Number(e.target.value)); }}>
        <option value={2}>2</option><option value={3}>3</option><option value={4}>4</option><option value={6}>6</option>
      </select></label>
    <label className={styles.field}>{zh ? "预备拍（节拍器，不录入分析起点）" : "Count-in beats"}
      <input type="number" min={0} max={8} step={1} value={countInBeats} onChange={(e) => setCountInBeats(Number(e.target.value))} /></label>
    <label className={styles.field}>{zh ? "或手动导入 MusicXML (.xml/.musicxml)" : "Or import MusicXML (.xml/.musicxml)"}
      <input type="file" accept=".xml,.musicxml" onChange={(e) => { setXmlFile(e.target.files?.[0] ?? null); setOmrJob(null); }} /></label>
    {xmlFile && <span className={styles.hint}>{xmlFile.name}</span>}

    <section className={styles.omr} aria-label={zh ? "同步录音" : "Synced recording"}>
      <h2>{zh ? "同步录音（节拍器 + 麦克风干声）" : "Synced recording (click + dry mic)"}</h2>
      <p className={styles.hint}>{zh ? "节拍器只从本机播放、不混入录音文件；录音只采集麦克风。建议戴耳机，预备拍不会计入分析。" : "Clicks play locally and are never mixed into the file; only the mic is recorded. Use headphones; count-in is excluded."}</p>
      <label className={styles.field}>{zh ? "录音设备" : "Microphone"}
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">{zh ? "默认麦克风" : "Default microphone"}</option>
          {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 12)}</option>)}
        </select></label>
      <div className={styles.actions}>
        {!recording
          ? <button onClick={() => { void startSyncRecording(); void refreshDevices(); }} disabled={omrActive || busyTakeId != null || !xmlFile}>{zh ? "● 同步录音" : "● Start synced take"}</button>
          : <button onClick={stopSyncRecording}>{zh ? "■ 停止并保存" : "■ Stop & keep"}</button>}
        <label className={styles.upload}>{zh ? "上传录音为一遍" : "Upload as take"}<input type="file" accept="audio/*,.wav,.m4a,.mp3,.webm" hidden
          onChange={(e) => { const file = e.target.files?.[0]; if (file) void addTakeBlob(file, { startMeasure, bpm, beatsPerMeasure, countInBeats, firstBeatAudioSec: null, sessionId: "upload" }, file.name); e.target.value = ""; }} /></label>
      </div>
      {recording && session && <p role="status" className={styles.hint}>
        {tick && tick.elapsedSec >= 0
          ? (zh ? `正式录音中 · 第 ${tick.measure} 小节第 ${tick.beat} 拍 · ${tick.elapsedSec.toFixed(1)}s` : `Recording · m${tick.measure} b${tick.beat} · ${tick.elapsedSec.toFixed(1)}s`)
          : (zh ? `预备拍中 · ${countInBeats} 拍后从第 ${session.startMeasure} 小节开始` : `Count-in · starting at m${session.startMeasure}`)}
      </p>}
      {takes.length > 0 && <div className={styles.takes}>
        {takes.map((take, i) => (
          <div key={take.id} className={styles.take}>
            <label><input type="radio" name="take" checked={take.id === selectedId} onChange={() => {
              setSelectedId(take.id); setBpm(take.bpm); setStartMeasure(take.startMeasure);
              setBeatsPerMeasure(take.beatsPerMeasure); setCountInBeats(take.countInBeats);
            }} /> <b>{zh ? `第 ${i + 1} 遍` : `Take ${i + 1}`}</b> · {take.name} · {take.durationSec}s · m{take.startMeasure} · {take.bpm} BPM
              {take.firstBeatAudioSec != null ? ` · sync ${take.firstBeatAudioSec.toFixed(2)}s` : ` · ${zh ? "未同步" : "unsynced"}`}
            </label>
            <div className={styles.takeRow}>
              <button className={styles.omrButton} disabled={busyTakeId != null || recording || !xmlFile || omrJob?.result?.compatible === false} onClick={() => void analyzeTake(take)}>
                {busyTakeId === take.id ? (zh ? "分析中…" : "Analyzing…") : (zh ? "分析这一遍" : "Analyze")}</button>
              <button className={styles.omrButton} onClick={() => {
                setTakes((prev) => prev.filter((t) => t.id !== take.id));
                if (take.url) URL.revokeObjectURL(take.url);
                void deleteTakeBlob(take.id).catch(() => undefined);
                if (selectedId === take.id) setSelectedId(null);
              }}>{zh ? "删除" : "Delete"}</button>
              {take.jobStatus && <span className={styles.hint}>{take.jobStatus}</span>}
              {take.result && <span className={styles.hint}>{zh ? "音准" : "Pitch"} {take.result.summary.pitchScore ?? "—"} · {zh ? "节奏" : "Rhythm"} {take.result.summary.rhythmScore ?? "—"}</span>}
            </div>
            {take.error && <p className={styles.error}>{take.error}</p>}
          </div>
        ))}
      </div>}
      {selected?.blob && <div className={styles.preview}><span>{selected.name}</span><audio ref={player} controls src={selected.url}
        onTimeUpdate={(e) => onTakePlaybackTime(e.currentTarget.currentTime, selected)} /></div>}
    </section>

    {(error) && <p role="alert" className={styles.error}>{error}</p>}
    {result && <section className={styles.report} aria-label={zh ? "分析报告" : "Analysis report"}>
      <h2>{zh ? "演奏报告" : "Performance report"}</h2>
      <div className={styles.scores}><div><b>{result.summary.pitchScore ?? "—"}</b>{zh ? "音准" : "Pitch"}</div>
        <div><b>{result.summary.rhythmScore ?? "—"}</b>{zh ? "节奏稳定" : "Rhythm"}</div></div>
      <p className={styles.hint}>{zh ? "可判音符" : "Voiced"} {result.summary.voicedNotes}/{result.summary.noteCount} ·
        {zh ? "可判起音" : "Timed"} {result.summary.timedNotes}/{Math.max(0, result.summary.noteCount - 1)} ·
        {zh ? "波动" : "Spread"} {result.summary.timingSpreadMs ?? "—"} ms</p>
      {result.summary.syncMode === "metronome" && <p className={styles.hint}>
        {zh ? `节拍器同步 · 第一拍 ${result.summary.recordedFirstBeatSec}s · 延迟微调 ${result.summary.estimatedLatencyMs} ms` : `Metronome sync · first beat ${result.summary.recordedFirstBeatSec}s · latency ${result.summary.estimatedLatencyMs} ms`}</p>}
      {result.summary.startMeasure && <p className={styles.hint}>{zh ? `本次分析：第 ${result.summary.startMeasure}–${result.summary.endMeasure} 小节（后续未录到的小节不计分）` : `Analyzed measures ${result.summary.startMeasure}–${result.summary.endMeasure}; later measures were not scored.`}</p>}
      {pdfMeasures > 0 && !canJump && <p className={styles.error}>{zh ? `谱面有 ${pdfMeasures} 小节、MusicXML 有 ${scoreMeasures} 小节；请核对后再映射到 PDF。` : `PDF has ${pdfMeasures} measures; MusicXML has ${scoreMeasures}. Verify alignment before mapping.`}</p>}
      <h3>{zh ? "复习片段" : "Review moments"} ({issues.length})</h3>
      {issues.length === 0 && <p className={styles.hint}>{zh ? "没有明确的问题；请检查可判比例。" : "No definite issues; check coverage above."}</p>}
      <ol className={styles.issues}>{issues.slice(0, 40).map((note) => <li key={note.id}>
        <button onClick={() => replay(note)} title={zh ? "从该音符前 0.5s 回听" : "Replay from 0.5s before this note"}>
          <b>{zh ? "小节" : "Bar"} {note.measure}</b> · {note.pitchErrorCents == null ? (zh ? "音高不确定" : "Pitch uncertain") : `${note.pitchErrorCents > 0 ? "+" : ""}${note.pitchErrorCents} ¢`}
          {note.timingErrorMs != null && ` · ${note.timingErrorMs > 0 ? "+" : ""}${note.timingErrorMs} ms`}
        </button></li>)}</ol>
      {result.limitations.map((text) => <p className={styles.hint} key={text}>{text}</p>)}
    </section>}
  </aside>;
}
