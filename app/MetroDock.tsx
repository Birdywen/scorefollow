"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./metro-dock.module.css";

type Metro = { play: () => boolean; stop: () => boolean; isPlaying: () => boolean;
  applyConfig: (config: Record<string, unknown>) => void };
const engine = () => (window as unknown as { __sgaMetroControl?: Metro }).__sgaMetroControl;
const sounds = ["wood", "clave", "beep", "digital", "snare"];

export default function MetroDock({ lang, hidden }: { lang: "zh" | "en"; hidden: boolean }) {
  const zh = lang === "zh";
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [state, setState] = useState({ ready: false, playing: false, bpm: 66, countIn: 0, sound: "wood" });
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const launch = useRef<HTMLButtonElement>(null);
  const idle = useRef(0);
  const keyboard = useRef(false);
  const lastTap = useRef(0);
  const touch = () => { idle.current = Date.now(); };

  useEffect(() => {
    document.documentElement.dataset.sfMetroDock = "true";
    const sync = () => {
      const api = engine();
      const live = (window as unknown as { __sgaMetro?: Partial<typeof state> }).__sgaMetro;
      setState((previous) => {
        const next = { ready: !!api, playing: !!api?.isPlaying(), bpm: Number(live?.bpm ?? 66),
          countIn: Number(live?.countIn ?? 0), sound: live?.sound ?? "wood" };
        return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
      });
    };
    sync();
    const timer = window.setInterval(sync, 500);
    return () => { clearInterval(timer); delete document.documentElement.dataset.sfMetroDock;
      delete document.documentElement.dataset.sfMetroPanel; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.sfMetroPanel = advanced && !hidden ? "open" : "closed";
  }, [advanced, hidden]);

  useEffect(() => {
    if (!open || hidden) return;
    touch();
    const close = () => {
      if (root.current?.contains(document.activeElement)) launch.current?.focus();
      setOpen(false);
    };
    const timer = window.setInterval(() => {
      if (Date.now() - idle.current >= 4000 && !(keyboard.current && root.current?.contains(document.activeElement))) close();
    }, 500);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => { clearInterval(timer); document.removeEventListener("pointerdown", outside); };
  }, [open, hidden]);

  const configure = (config: { bpm?: number; countIn?: number; sound?: string }) => {
    engine()?.applyConfig(config);
    setState((previous) => ({ ...previous, ...config }));
    touch();
  };
  const play = () => {
    const now = Date.now();
    if (now - lastTap.current < 500) return;
    lastTap.current = now;
    const api = engine();
    if (!api) return;
    if (api.isPlaying()) api.stop();
    else if (!api.play()) setNotice(zh ? "请先载入并识别谱面" : "Load and recognize a score first");
    else { setNotice(""); setOpen(false); }
    touch();
  };

  return <div ref={root} className={styles.dock} hidden={hidden} data-open={open}
    onPointerDown={() => { keyboard.current = false; touch(); }} onPointerMove={touch}
    onKeyDown={(event) => {
      keyboard.current = true; touch();
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); setAdvanced(false); launch.current?.focus(); }
    }}>
    {open && <div id="sf-metro-radial" className={styles.disc} role="group" aria-label={zh ? "节拍器快捷圆盘" : "Metronome quick controls"}>
      <div className={styles.readout}><strong>{state.bpm}</strong><span>BPM</span></div>
      <button className={styles.play} disabled={!state.ready} onClick={play} aria-label={state.playing ? (zh ? "停止节拍器" : "Stop metronome") : (zh ? "播放节拍器" : "Play metronome")}>{state.playing ? "■" : "▶"}</button>
      <button className={styles.slower} disabled={!state.ready || state.bpm <= 20} onClick={() => configure({ bpm: Math.max(20, state.bpm - 2) })} aria-label={zh ? "减速 2 BPM" : "Slower by 2 BPM"}>−<small>2 BPM</small></button>
      <button className={styles.faster} disabled={!state.ready || state.bpm >= 300} onClick={() => configure({ bpm: Math.min(300, state.bpm + 2) })} aria-label={zh ? "加速 2 BPM" : "Faster by 2 BPM"}>+<small>2 BPM</small></button>
      <button className={styles.count} disabled={!state.ready} aria-pressed={state.countIn > 0} onClick={() => configure({ countIn: state.countIn ? 0 : 4 })}>{state.countIn || "—"}<small>{zh ? "预备拍" : "Count-in"}</small></button>
      <button className={styles.sound} disabled={!state.ready} onClick={() => configure({ sound: sounds[(sounds.indexOf(state.sound) + 1) % sounds.length] })}>♫<small>{zh ? ["木鱼", "响木", "滴声", "数字", "军鼓"][sounds.indexOf(state.sound)] ?? "音色" : state.sound}</small></button>
      <span className={styles.idleHint}>{zh ? "闲置 4 秒收起" : "Hides after 4s idle"}</span>
    </div>}
    {open && <p role="status" className={styles.notice}>{!state.ready ? (zh ? "载入谱面后启用节拍器" : "Load a score to enable controls") : notice}</p>}
    <div className={styles.launchRow}>
      {(open || advanced) && <button className={styles.more} aria-pressed={advanced} onClick={() => { if (advanced) setOpen(false); setAdvanced(!advanced); touch(); }}>{advanced ? (zh ? "收起设置" : "Hide settings") : (zh ? "完整设置" : "Full settings")}</button>}
      <button ref={launch} className={styles.launch} aria-expanded={open} aria-controls="sf-metro-radial" aria-label={zh ? "节拍器圆盘" : "Metronome dial"}
        data-playing={state.playing} onClick={() => { setOpen(!open); touch(); }}><span aria-hidden="true">◴</span>{open ? (zh ? "收起" : "Close") : `${state.bpm} BPM`}</button>
    </div>
  </div>;
}
