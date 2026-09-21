"use client";

/**
 * scorefollow — synpdf rev.194 Next.js 全量 TypeScript 移植 (Phase 2.1)
 * PDF 渲染(pdfjs-dist) + 像素级小节检测(lib) + 光标跟随(Wijzer)
 * + count-in / A-B 循环 / 变速 / TAP 建图 / advanced 识别参数面板。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzePage,
  clearPageCache,
  opt,
  setSkipn,
  setSysprf,
  type PageAnalysis,
} from "@/lib/synpdf-core";
import { Wijzer } from "@/lib/synpdf-wijzer";

export default function ScoreFollowPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const pdfDocRef = useRef<any>(null);
  const pageProxyRef = useRef<any>(null);
  const wijzerRef = useRef<Wijzer>(new Wijzer());
  const rafRef = useRef(0);
  const clockRef = useRef({ t0: 0, base: 0, running: false });

  const [status, setStatus] = useState("scorefollow ready — upload a PDF score");
  const [cursorInfo, setCursorInfo] = useState("");
  const [advOpen, setAdvOpen] = useState(true);
  const [, forceAdv] = useState(0);
  const [showOverlay, setShowOverlay] = useState(true);
  const [analysis, setAnalysis] = useState<PageAnalysis | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [mediaURL, setMediaURL] = useState("");
  const [mediaKind, setMediaKind] = useState<"audio" | "video">("audio");
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [loopA, setLoopA] = useState(0);
  const [loopB, setLoopB] = useState(0);
  const [tapCount, setTapCount] = useState(0);
  const [synbox, setSynbox] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // pdf.js worker(同构安全: 只在客户端配)
  useEffect(() => {
    (async () => {
      const pdfjs: any = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    })();
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const renderPage = useCallback(
    async (pdf: any, n: number) => {
      if (!pdf || !canvasRef.current) return;
      const proxy = await pdf.getPage(n);
      pageProxyRef.current = proxy;
      const v0 = proxy.getViewport({ scale: 1 });
      const scale = (opt.pagewd || 1000) / v0.width;
      const vp = proxy.getViewport({ scale });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await proxy.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      const a = analyzePage(canvas, n, opt.seln);
      wijzerRef.current.reset(a);
      setAnalysis(a);
      setCursor(null);
      setStatus(
        `page ${n}: ${a.systems.length} systems, ` +
          `${a.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0)} measures, ` +
          `spatium ${a.spatium.toFixed(1)}px`,
      );
    },
    [],
  );

  const onPdfFile = useCallback(
    async (f: File) => {
      setStatus(`loading ${f.name} ...`);
      const pdfjs: any = await import("pdfjs-dist");
      const buf = await f.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      pdfDocRef.current = pdf;
      setNumPages(pdf.numPages);
      setPageNum(1);
      await renderPage(pdf, 1);
    },
    [renderPage],
  );

  const applyAdv = useCallback(
    (k: string, v: number) => {
      if (!Number.isFinite(v)) return;
      if (k === "skipn") { setSkipn(v); opt.skipn = v; }
      else if (k === "sysprf") { setSysprf(v); }
      else (opt as unknown as Record<string, number>)[k] = v;
      clearPageCache();
      forceAdv((n) => n + 1);
      setStatus(`advanced: ${k}=${v} - reanalyzed`);
      if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum);
    },
    [pageNum, renderPage],
  );

  const now = useCallback((): number => {
    const m = mediaRef.current as any;
    if (m && m.currentTime != null && mediaURL) return m.currentTime;
    const c = clockRef.current;
    if (!c.running) return c.base;
    return c.base + ((performance.now() - c.t0) / 1000) * speed;
  }, [mediaURL, speed]);

  const tick = useCallback(() => {
    const w = wijzerRef.current;
    let t = now();
    if (w.loopOn) {
      if (t > w.loopEnd || t < w.loopStart) {
        t = w.loopStart + 0.01;
        const m = mediaRef.current as any;
        if (m && mediaURL) m.currentTime = t;
        else clockRef.current = { t0: performance.now(), base: t, running: true };
      }
    }
    const c = w.time2x(t);
    if (c) {
      setCursor({ x: c.x, y: c.y, w: c.w, h: c.h });
      setCursorInfo(`m${c.measure + 1} t=${t.toFixed(2)}s`);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [now, mediaURL]);

  const doPlay = useCallback(() => {
    const m = mediaRef.current as any;
    if (m && mediaURL) { m.playbackRate = speed; void m.play(); }
    else {
      const c = clockRef.current;
      c.t0 = performance.now();
      c.running = true;
    }
    setPlaying(true);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [mediaURL, speed, tick]);

  const doPause = useCallback(() => {
    const m = mediaRef.current as any;
    if (m && mediaURL) m.pause();
    else {
      const c = clockRef.current;
      c.base = now();
      c.running = false;
    }
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, [mediaURL, now]);

  const doCountIn = useCallback(() => {
    const beats = parseInt(String(opt.bpmsr).split("-")[0], 10) || 4;
    let i = 0;
    setStatus(`count-in: ${beats} beats ...`);
    const iv = setInterval(() => {
      i++;
      setStatus(`count-in ${i}/${beats}`);
      if (i >= beats) { clearInterval(iv); doPlay(); }
    }, 600);
  }, [doPlay]);

  const doTap = useCallback(() => {
    const e = wijzerRef.current.tap(now());
    setTapCount(wijzerRef.current.times.length);
    setStatus(`tap m${e.mix + 1} @ ${e.t.toFixed(2)}s`);
  }, [now]);

  const adjustLast = useCallback((d: number) => {
    const T = wijzerRef.current.times;
    if (!T.length) return;
    const last = T[T.length - 1];
    last.t = Math.round(1e3 * (last.t + d)) / 1e3;
    setStatus(`m${last.mix + 1} ${d > 0 ? "+" : ""}${d.toFixed(2)}s → ${last.t.toFixed(2)}s`);
  }, []);

  const backupOne = useCallback(() => {
    const T = wijzerRef.current.times;
    if (!T.length) return;
    const e = T.pop()!;
    setTapCount(T.length);
    setStatus(`backup: erased m${e.mix + 1}, ${T.length} taps left`);
  }, []);

  // preload 等价物: timing JSON 存取 (原版 saveTiming/evalPreload)
  const saveTiming = useCallback(() => {
    const w = wijzerRef.current;
    const payload = {
      app: "scorefollow",
      version: "2.1",
      opt: { ...opt },
      times_arr: w.times,
      measures: w.measures,
      loop: { start: w.loopStart, end: w.loopEnd },
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "scorefollow-timing.json";
    a.click();
    setStatus(`saved ${w.times.length} sync points`);
  }, []);

  const loadTiming = useCallback((f: File) => {
    f.text().then((txt) => {
      const p = JSON.parse(txt);
      if (p.opt) {
        for (const [k, v] of Object.entries(p.opt)) {
          if (k === "skipn") { setSkipn(1 * (v as number)); opt.skipn = 1 * (v as number); }
          else if (k === "sysprf") setSysprf(1 * (v as number));
          else (opt as unknown as Record<string, number>)[k] = 1 * (v as number);
        }
      }
      if (p.times_arr) wijzerRef.current.loadTimes(p.times_arr);
      setTapCount(wijzerRef.current.times.length);
      clearPageCache();
      forceAdv((n) => n + 1);
      if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum);
      setStatus(`loaded ${wijzerRef.current.times.length} sync points`);
    }).catch(() => setStatus("timing file parse failed"));
  }, [pageNum, renderPage]);

  const onScoreClick = useCallback(
    (ev: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const sx = canvas.width / r.width;
      const x = (ev.clientX - r.left) * sx;
      const y = (ev.clientY - r.top) * sx;
      const hit = wijzerRef.current.x2time(x, y);
      if (!hit) return;
      const m = mediaRef.current as any;
      if (m && mediaURL) m.currentTime = hit.t;
      else clockRef.current = { t0: performance.now(), base: hit.t, running: clockRef.current.running };
      setCursorInfo(`seek m${hit.measure + 1} t=${hit.t.toFixed(2)}s`);
    },
    [mediaURL],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === " ") { e.preventDefault(); playing ? doPause() : doPlay(); }
      else if (e.key === "ArrowRight") {
        const t = wijzerRef.current.goMsre(1, now());
        const m = mediaRef.current as any;
        if (m && mediaURL) m.currentTime = t;
      } else if (e.key === "ArrowLeft") {
        const t = wijzerRef.current.goMsre(-1, now());
        const m = mediaRef.current as any;
        if (m && mediaURL) m.currentTime = t;
      } else if (e.key === "+" || e.key === "=") setSpeed((s) => Math.min(2, Math.round((s + 0.05) * 100) / 100));
      else if (e.key === "-") setSpeed((s) => Math.max(0.5, Math.round((s - 0.05) * 100) / 100));
      else if (synbox && (e.key === "b" || e.key === "B")) { e.preventDefault(); doTap(); }
      else if (synbox && e.key === "Backspace") { e.preventDefault(); backupOne(); }
      else if (synbox && e.key === ",") adjustLast(e.ctrlKey ? -0.1 : -0.05);
      else if (synbox && e.key === ".") adjustLast(e.ctrlKey ? 0.1 : 0.05);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, doPlay, doPause, now, mediaURL, synbox, doTap, backupOne, adjustLast]);

  useEffect(() => {
    const m = mediaRef.current as any;
    if (m && mediaURL) m.playbackRate = speed;
    if (!mediaURL) clockRef.current.running = playing;
  }, [speed, mediaURL, playing]);

  const barsTotal = analysis
    ? analysis.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0)
    : 0;

  return (
    <main style={{ padding: 16, fontFamily: "sans-serif", background: "#101418", color: "#dfe7f3", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20 }}>scorefollow <span style={{ fontSize: 12, color: "#9fb0c8" }}>synpdf-rev194 full TS port · phase 2.1</span></h1>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
        <label className="pill">PDF score <input type="file" accept=".pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPdfFile(f); }} /></label>
        <label className="pill">media <input type="file" accept="audio/*,video/*" onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return;
          setMediaURL(URL.createObjectURL(f));
          setMediaKind(f.type.startsWith("video") ? "video" : "audio");
        }} /></label>
        <button onClick={() => playing ? doPause() : doPlay()}>{playing ? "⏸ pause" : "▶ play"}</button>
        <button onClick={doCountIn}>count-in</button>
        <button onClick={doTap}>TAP {tapCount > 0 ? `(${tapCount})` : ""}</button>
        <label className="pill">speed <input type="range" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} /> {speed.toFixed(2)}</label>
        <label className="pill">loop <input type="number" min={0} step={0.5} value={loopA} onChange={(e) => { const v = Number(e.target.value); setLoopA(v); wijzerRef.current.setLoop(v, loopB); }} style={{ width: 64 }} />
          – <input type="number" min={0} step={0.5} value={loopB} onChange={(e) => { const v = Number(e.target.value); setLoopB(v); wijzerRef.current.setLoop(loopA, v); }} style={{ width: 64 }} /></label>
        <label className="pill">page <input type="number" min={1} max={Math.max(1, numPages)} value={pageNum} onChange={(e) => {
          const n = Math.min(Math.max(1, Number(e.target.value) || 1), numPages || 1);
          setPageNum(n); if (pdfDocRef.current) void renderPage(pdfDocRef.current, n);
        }} style={{ width: 56 }} /> / {numPages}</label>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
        <label className="pill"><input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} /> analysis overlay</label>
        <label className="pill"><input type="checkbox" checked={advOpen} onChange={(e) => setAdvOpen(e.target.checked)} /> advanced</label>
        <label className="pill"><input type="checkbox" checked={synbox} onChange={(e) => setSynbox(e.target.checked)} /> enable sync</label>
        <button onClick={saveTiming}>save timing</button>
        <label className="pill">load timing <input type="file" accept=".json" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadTiming(f); }} /></label>
        <span style={{ fontSize: 12, color: "#9fb0c8" }}>{status}</span>
        <span style={{ fontSize: 12, color: "#7fe0a8" }}>{cursorInfo}</span>
      </div>

      {advOpen && (
        <div className="advpanel">
          <label>zwgrens <input type="range" min={0.3} max={1.5} step={0.05} value={opt.zwgrens} onChange={(e) => applyAdv("zwgrens", Number(e.target.value))} /> {opt.zwgrens}</label>
          <label>drmpl <input type="range" min={0.1} max={1} step={0.05} value={opt.drmpl} onChange={(e) => applyAdv("drmpl", Number(e.target.value))} /> {opt.drmpl}</label>
          <label>drmpl2 <input type="range" min={0.5} max={5} step={0.1} value={opt.drmpl2} onChange={(e) => applyAdv("drmpl2", Number(e.target.value))} /> {opt.drmpl2}</label>
          <label>mtdrmpl <input type="range" min={0.3} max={1.2} step={0.05} value={opt.mtdrmpl} onChange={(e) => applyAdv("mtdrmpl", Number(e.target.value))} /> {opt.mtdrmpl}</label>
          <label>voorna <input type="range" min={0.5} max={1} step={0.05} value={opt.voorna} onChange={(e) => applyAdv("voorna", Number(e.target.value))} /> {opt.voorna}</label>
          <label>dx <input type="range" min={1} max={10} step={1} value={opt.dx} onChange={(e) => applyAdv("dx", Number(e.target.value))} /> {opt.dx}</label>
          <label><input type="checkbox" checked={opt.sysprf ? true : false} onChange={(e) => applyAdv("sysprf", e.target.checked ? 1 : 0)} /> sysprf</label>
          <label><input type="checkbox" checked={opt.onestf ? true : false} onChange={(e) => applyAdv("onestf", e.target.checked ? 1 : 0)} /> onestf</label>
          <label><input type="checkbox" checked={opt.eerst ? true : false} onChange={(e) => applyAdv("eerst", e.target.checked ? 1 : 0)} /> eerst</label>
          <label>skipn <input type="number" min={0} max={5} value={opt.skipn} onChange={(e) => applyAdv("skipn", Number(e.target.value))} /></label>
          <label>seln <input type="number" min={0} max={9} value={opt.seln} onChange={(e) => applyAdv("seln", Number(e.target.value))} /></label>
          <label>cropx <input type="number" min={0} value={opt.cropx} onChange={(e) => applyAdv("cropx", Number(e.target.value))} /></label>
          <label>pagewd <input type="number" min={600} max={3000} step={50} value={opt.pagewd} onChange={(e) => applyAdv("pagewd", Number(e.target.value) || 1000)} /></label>
          <label>fixwd <input type="number" min={0} step={100} value={opt.fixwd} onChange={(e) => applyAdv("fixwd", Number(e.target.value) || 0)} /></label>
        </div>
      )}

      {mediaURL && mediaKind === "video" && (
        <video ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls style={{ maxWidth: "100%", margin: "8px 0" }} />
      )}
      {mediaURL && mediaKind === "audio" && (
        <audio ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls style={{ width: "100%", margin: "8px 0" }} />
      )}

      <div id="notation" style={{ position: "relative", display: "inline-block", background: "#fff" }} onClick={onScoreClick}>
        <canvas ref={canvasRef} style={{ display: "block", maxWidth: "100%" }} />
        {showOverlay && analysis && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} viewBox={`0 0 ${analysis.pageW} ${analysis.pageH}`}>
            {analysis.systems.map((s, i) => (
              <rect key={`sys${i}`} x={s.xs.x1} y={s.cs[0]} width={s.xs.x2 - s.xs.x1} height={s.cs[s.cs.length - 1] - s.cs[0]}
                fill="none" stroke="rgba(0,180,0,0.55)" strokeWidth={2} />
            ))}
            {(analysis.bars.flatMap((b, si) => {
              const s = analysis.systems[si];
              if (!s) return [];
              return b.map((x, bi) => (
                <line key={`bar${si}-${bi}`} x1={x} y1={s.cs[0]} x2={x} y2={s.cs[s.cs.length - 1]} stroke="rgba(255,0,0,0.55)" strokeWidth={2} />
              ));
            }))}
          </svg>
        )}
        {cursor && (
          <div className="demaat" style={{
            position: "absolute", background: "rgba(0,0,255,0.2)",
            left: `${(cursor.x / (analysis?.pageW || 1)) * 100}%`,
            top: `${(cursor.y / (analysis?.pageH || 1)) * 100}%`,
            width: `${(cursor.w / (analysis?.pageW || 1)) * 100}%`,
            height: `${(cursor.h / (analysis?.pageH || 1)) * 100}%`,
            pointerEvents: "none",
          }} />
        )}
      </div>

      <div style={{ fontSize: 12, color: "#9fb0c8", marginTop: 8 }}>
        {analysis ? `${analysis.systems.length} systems · ${barsTotal} measures · spatium ${analysis.spatium.toFixed(1)}px · ${tapCount} taps` : "no analysis yet"} ·
        keys: space play · ←/→ bar · +/− speed{synbox ? " · B tap · ⌫ backup · ,/. adjust" : ""}
      </div>

      <style>{`
        .pill { background: #1b202b; border: 1px solid #2c3342; border-radius: 999px; padding: 4px 12px; font-size: 13px; color: #9fb0c8; }
        .advpanel { background: #161b26; border: 1px solid #2c3342; border-radius: 10px; padding: 10px 14px; margin-top: 8px; display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; font-size: 12.5px; color: #9fb0c8; }
        .advpanel label { display: inline-flex; gap: 6px; align-items: center; }
        .advpanel input[type=number] { width: 64px; background: #1b202b; color: #dfe7f3; border: 1px solid #2c3342; border-radius: 6px; padding: 2px 6px; }
        button { background: #1b202b; color: #dfe7f3; border: 1px solid #2c3342; border-radius: 8px; padding: 4px 12px; cursor: pointer; }
      `}</style>
    </main>
  );
}
