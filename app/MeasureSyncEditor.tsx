"use client";

import { useEffect, useState } from "react";

export type MeasureMarker = { measure: number; audioSec: number };
export type SyncedAudio = { url: string; name: string; markers: MeasureMarker[]; measureCount: number };

export function validateMarkers(markers: MeasureMarker[], duration: number, measures: number): string | null {
  if (!Number.isFinite(duration) || duration <= 0) return "Wait for audio metadata / 请等待音频加载";
  if (markers.length < 2) return "Mark a measure start and its end / 请标记小节起点及终点";
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i], prev = markers[i - 1];
    if (!Number.isInteger(m.measure) || m.measure < 1 || m.measure > measures + 1 ||
      !Number.isFinite(m.audioSec) || m.audioSec < 0 || m.audioSec > duration ||
      (prev && (m.measure !== prev.measure + 1 || m.audioSec <= prev.audioSec)))
      return "Use consecutive measures and increasing times inside this recording / 小节须连续，时间须递增且在录音内";
  }
  return null;
}

export default function MeasureSyncEditor({ markers, startMeasure, confirmed, disabled, zh, getAudio, onChange, onConfirm, onJump, onPreview }: {
  markers: MeasureMarker[]; startMeasure: number; confirmed: boolean; disabled: boolean; zh: boolean;
  getAudio: () => HTMLAudioElement | null;
  onChange: (markers: MeasureMarker[], startMeasure: number) => void;
  onConfirm: () => void; onJump: (measure: number) => void;
  onPreview: (start: number, end: number) => void;
}) {
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("");
  const next = markers.length ? markers[markers.length - 1].measure + 1 : startMeasure;
  function mark() {
    const audio = getAudio();
    if (!audio || !Number.isFinite(audio.currentTime)) return;
    const sec = Math.round(audio.currentTime * 1000) / 1000;
    if (markers.length && sec <= markers[markers.length - 1].audioSec) {
      setMessage(zh ? "请先删除后面的标记，再重新标记。" : "Undo later markers before marking an earlier time."); return;
    }
    setMessage("");
    onChange([...markers, { measure: next, audioSec: sec }], startMeasure);
    onJump(next);
  }
  useEffect(() => {
    if (!active || disabled) return;
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
      const k = event.key.toLowerCase();
      if (!["b", "backspace", "p"].includes(k)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (k === "b") mark();
      else if (k === "backspace") onChange(markers.slice(0, -1), startMeasure);
      else { const audio = getAudio(); if (audio) { if (audio.paused) void audio.play().catch(() => setMessage("Playback failed")); else audio.pause(); } }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  return <section aria-label={zh ? "小节同步" : "Measure sync"} style={{ marginTop: 12 }}>
    <h3>{zh ? "先同步小节，再分析" : "Sync measures before analysis"}</h3>
    <p>{zh ? "播放这一遍，在每小节第一拍按 B。最后再标记一次结束边界。仅分析最后一个标记之前的完整小节。P 播放/暂停；退格撤销。" : "Play this take and press B on each measure’s first beat. Add one final end boundary. Only complete intervals before the last marker are analyzed. P plays/pauses; Backspace undoes."}</p>
    <fieldset disabled={disabled} style={{ border: 0, padding: 0 }}>
      <label>{zh ? "第一个小节" : "First measure"} <input aria-label="Sync first measure" type="number" min={1} step={1} value={startMeasure} disabled={markers.length > 0}
        onChange={(e) => onChange([], Number(e.target.value))} /></label>
      <button onClick={() => setActive(!active)}>{active ? (zh ? "停止 B 同步" : "Stop B sync") : (zh ? "开始 B 同步" : "Start B sync")}</button>
      <button onClick={mark}>{zh ? `标记第 ${next} 小节边界 (B)` : `Mark boundary ${next} (B)`}</button>
      <button disabled={!markers.length} onClick={() => onChange(markers.slice(0, -1), startMeasure)}>{zh ? "撤销标记" : "Undo marker"}</button>
      <button disabled={!markers.length} onClick={() => onChange([], startMeasure)}>{zh ? "清除标记" : "Clear markers"}</button>
      <div style={{ maxHeight: 220, overflow: "auto" }}>
        {markers.map((marker, i) => <div key={marker.measure}>
          <label>m{marker.measure}{i === markers.length - 1 ? (zh ? "（结束边界）" : " (end boundary)") : ""} <input aria-label={`Measure ${marker.measure} seconds`} type="number" min={0} step={.01} value={marker.audioSec}
            onChange={(e) => onChange(markers.map((m, j) => j === i ? { ...m, audioSec: Number(e.target.value) } : m), startMeasure)} /></label>
          <button onClick={() => { const audio = getAudio(); if (audio) { audio.pause(); audio.currentTime = marker.audioSec; } onJump(marker.measure); }}>{zh ? "定位" : "Seek"}</button>
          {i < markers.length - 1 && <button onClick={() => onPreview(marker.audioSec, markers[i + 1].audioSec)}>{zh ? `回听小节 ${marker.measure}` : `Preview measure ${marker.measure}`}</button>}
        </div>)}
      </div>
      <button disabled={markers.length < 2} onClick={() => { setActive(false); onConfirm(); }}>{zh ? "确认同步并用于分析" : "Confirm sync for analysis"}</button>
    </fieldset>
    <p role="status">{confirmed ? (zh ? `已确认：分析 ${markers[0]?.measure}–${(markers.at(-1)?.measure ?? 1) - 1} 小节` : `Confirmed: analyze measures ${markers[0]?.measure}–${(markers.at(-1)?.measure ?? 1) - 1}`) : (zh ? "标记尚未确认；现有标记需确认后才能分析。" : "Markers must be confirmed before analysis.")}</p>
    {message && <p role="alert">{message}</p>}
  </section>;
}
