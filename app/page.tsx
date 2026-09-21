"use client";

/**
 * scorefollow — synpdf rev.194 Next.js 全量 TypeScript 移植 (Phase 2.1)
 * PDF 渲染(pdfjs-dist) + 像素级小节检测(lib) + 光标跟随(Wijzer)
 * + count-in / A-B 循环 / 变速 / TAP 建图 / advanced 识别参数面板
 * + 人工小节线校正层(manualBarsByPage) / 覆盖层开关 / timing 校验。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzePage,
  clearPageCache,
  opt,
  setSkipn,
  setSysprf,
  applyAnalysisProfile,
  buildTimingPayload,
  validateTimingPayload,
  ALGO_VERSION,
  type AnalysisProfileName,
  type PageAnalysis,
} from "@/lib/synpdf-core";
import { Wijzer, buildMeasures } from "@/lib/synpdf-wijzer";
import styles from "./page.module.css";

const DEFAULT_ADV: Record<string, number> = {
  zwgrens: 0.7, drmpl: 0.4, drmpl2: 2, mtdrmpl: 0.8, voorna: 0.9, dx: 3,
  sysprf: 0, onestf: 0, eerst: 0, skipn: 0, seln: 0, cropx: 0,
  pagewd: 1000, fixwd: 1000,
};

function cloneBars(bars: number[][]): number[][] {
  return bars.map((b) => b.slice());
}

export default function ScoreFollowPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const notationRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const pdfDocRef = useRef<any>(null);
  const pageProxyRef = useRef<any>(null);
  const wijzerRef = useRef<Wijzer>(new Wijzer());
  const rafRef = useRef(0);
  const clockRef = useRef({ t0: 0, base: 0, running: false });
  const autoRef = useRef<Record<number, PageAnalysis>>({});
  const manualRef = useRef<Record<number, number[][]>>({});
  const undoRef = useRef<Record<number, number[][]>[]>([]);
  const redoRef = useRef<Record<number, number[][]>[]>([]);
  const dragRef = useRef<{ si: number; bi: number; active: boolean }>({ si: -1, bi: -1, active: false });

  const [status, setStatus] = useState("scorefollow ready — upload a PDF score");
  const [cursorInfo, setCursorInfo] = useState("");
  const [advOpen, setAdvOpen] = useState(true);
  const [, forceAdv] = useState(0);
  const [analysis, setAnalysis] = useState<PageAnalysis | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pdfName, setPdfName] = useState("");
  const [mediaURL, setMediaURL] = useState("");
  const [mediaKind, setMediaKind] = useState<"audio" | "video">("audio");
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [loopA, setLoopA] = useState(0);
  const [loopB, setLoopB] = useState(0);
  const [tapCount, setTapCount] = useState(0);
  const [synbox, setSynbox] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // 覆盖层四开关: 系统框 / 小节线 / 光标 / 低置信度
  const [showSystems, setShowSystems] = useState(true);
  const [showBars, setShowBars] = useState(true);
  const [showCursor, setShowCursor] = useState(true);
  const [showLowConf, setShowLowConf] = useState(true);
  // 人工校正
  const [manualBarsByPage, setManualBarsByPage] = useState<Record<number, number[][]>>({});
  const [correctMode, setCorrectMode] = useState(false);
  const [selectedBar, setSelectedBar] = useState<{ si: number; bi: number } | null>(null);
  const [profileName, setProfileName] = useState<AnalysisProfileName>("balanced");

  useEffect(() => {
    manualRef.current = manualBarsByPage;
  }, [manualBarsByPage]);

  // pdf.js worker(同构安全: 只在客户端配)
  useEffect(() => {
    (async () => {
      const pdfjs: any = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    })();
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const describeAnalysis = useCallback((a: PageAnalysis, manual: boolean) => {
    const meas = a.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0);
    const conf = a.confidence.length
      ? `${Math.min(...a.confidence).toFixed(2)}–${Math.max(...a.confidence).toFixed(2)}`
      : "—";
    return (
      `page ${a.pageNumber}: ${a.systems.length} systems, ${meas} measures, ` +
      `spatium ${a.spatium.toFixed(1)}px, conf ${conf}, ${a.elapsedMs}ms, algo v${a.algoVersion}` +
      (manual ? " · manual" : "")
    );
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
      autoRef.current[n] = a;
      const manual = manualRef.current[n];
      const eff: PageAnalysis = manual ? { ...a, bars: cloneBars(manual) } : a;
      const savedTimes = wijzerRef.current.times.slice();
      wijzerRef.current.reset(eff);
      const { kept, dropped } = wijzerRef.current.retainTimes(savedTimes);
      setTapCount(wijzerRef.current.times.length);
      setAnalysis(eff);
      setSelectedBar(null);
      // 蓝 shade: 分析完即覆盖第一小节(免 TAP 先行), 跟随后由 tick 接管
      const m0 = wijzerRef.current.measures[0];
      if (m0) {
        setCursor(opt.lncsr === 1
          ? { x: m0.x, y: m0.y, w: Math.max(2, m0.w * 0.06), h: m0.h }
          : { x: m0.x, y: m0.y, w: m0.w, h: m0.h });
        setCursorInfo("m1");
      } else {
        setCursor(null);
        setCursorInfo("");
      }
      setStatus(describeAnalysis(eff, !!manual) + (dropped ? ` · timing截断 ${kept}保留/${dropped}越界` : ""));
    },
    [describeAnalysis],
  );

  const onPdfFile = useCallback(
    async (f: File) => {
      setStatus(`loading ${f.name} ...`);
      const pdfjs: any = await import("pdfjs-dist");
      const buf = await f.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      pdfDocRef.current = pdf;
      setPdfName(f.name);
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

  const applyProfile = useCallback(
    (name: AnalysisProfileName) => {
      applyAnalysisProfile(name);
      setProfileName(name);
      forceAdv((n) => n + 1);
      setStatus(`profile: ${name} - reanalyzed`);
      if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum);
    },
    [pageNum, renderPage],
  );

  const resetAdvDefaults = useCallback(() => {
    for (const [k, v] of Object.entries(DEFAULT_ADV)) {
      if (k === "skipn") { setSkipn(v); opt.skipn = v; }
      else if (k === "sysprf") setSysprf(v);
      else (opt as unknown as Record<string, number>)[k] = v;
    }
    clearPageCache();
    forceAdv((n) => n + 1);
    setStatus("advanced: 已恢复默认值 - reanalyzed");
    if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum);
  }, [pageNum, renderPage]);

  // ---- 人工校正层 ----
  const pushUndo = useCallback(() => {
    const snap: Record<number, number[][]> = {};
    for (const [k, v] of Object.entries(manualRef.current)) snap[Number(k)] = cloneBars(v);
    undoRef.current.push(snap);
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
  }, []);

  const commitBars = useCallback(
    (nextBars: number[][], label: string) => {
      if (!analysis) return;
      pushUndo();
      const nextManual = { ...manualRef.current, [pageNum]: cloneBars(nextBars) };
      manualRef.current = nextManual;
      setManualBarsByPage(nextManual);
      wijzerRef.current.measures = buildMeasures({ ...analysis, bars: nextBars });
      const before = wijzerRef.current.times.length;
      wijzerRef.current.times = wijzerRef.current.times.filter((t) => t.mix < wijzerRef.current.measures.length);
      setTapCount(wijzerRef.current.times.length);
      const dropped = before - wijzerRef.current.times.length;
      const eff: PageAnalysis = { ...analysis, bars: cloneBars(nextBars) };
      setAnalysis(eff);
      setStatus(`${label} · ${eff.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0)} measures` + (dropped ? ` · timing截断${dropped}个` : ""));
    },
    [analysis, pageNum, pushUndo],
  );

  const resetPageCorrections = useCallback(() => {
    const auto = autoRef.current[pageNum];
    if (!auto) { setStatus("无自动识别结果可恢复"); return; }
    pushUndo();
    const next = { ...manualRef.current };
    delete next[pageNum];
    manualRef.current = next;
    setManualBarsByPage(next);
    const saved = wijzerRef.current.times.slice();
    wijzerRef.current.reset(auto);
    const { dropped } = wijzerRef.current.retainTimes(saved);
    setTapCount(wijzerRef.current.times.length);
    setAnalysis(auto);
    setSelectedBar(null);
    setStatus(`已恢复自动识别 p${pageNum}` + (dropped ? ` · timing截断${dropped}个` : ""));
  }, [pageNum, pushUndo]);

  const copyCorrectionsToAll = useCallback(() => {
    if (!analysis || !numPages) return;
    const cur = manualRef.current[pageNum] ?? analysis.bars;
    pushUndo();
    const next: Record<number, number[][]> = {};
    for (let n = 1; n <= numPages; n++) next[n] = cloneBars(cur);
    manualRef.current = next;
    setManualBarsByPage(next);
    setStatus(`已将 p${pageNum} 校正复制到 ${numPages} 页(几何可能不同, 请逐页复核)`);
  }, [analysis, numPages, pageNum, pushUndo]);

  const doUndo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) { setStatus("没有可撤销的校正"); return; }
    const snap: Record<number, number[][]> = {};
    for (const [k, v] of Object.entries(manualRef.current)) snap[Number(k)] = cloneBars(v);
    redoRef.current.push(snap);
    manualRef.current = prev;
    setManualBarsByPage({ ...prev });
    const auto = autoRef.current[pageNum];
    const effBars = prev[pageNum] ?? auto?.bars;
    if (auto && effBars) {
      const eff = { ...auto, bars: cloneBars(effBars) };
      wijzerRef.current.measures = buildMeasures(eff);
      wijzerRef.current.times = wijzerRef.current.times.filter((t) => t.mix < wijzerRef.current.measures.length);
      setTapCount(wijzerRef.current.times.length);
      setAnalysis(eff);
    }
    setStatus("已撤销上一步校正");
  }, [pageNum]);

  const doRedo = useCallback(() => {
    const nxt = redoRef.current.pop();
    if (!nxt) { setStatus("没有可重做的校正"); return; }
    const snap: Record<number, number[][]> = {};
    for (const [k, v] of Object.entries(manualRef.current)) snap[Number(k)] = cloneBars(v);
    undoRef.current.push(snap);
    manualRef.current = nxt;
    setManualBarsByPage({ ...nxt });
    const auto = autoRef.current[pageNum];
    const effBars = nxt[pageNum] ?? auto?.bars;
    if (auto && effBars) {
      const eff = { ...auto, bars: cloneBars(effBars) };
      wijzerRef.current.measures = buildMeasures(eff);
      wijzerRef.current.times = wijzerRef.current.times.filter((t) => t.mix < wijzerRef.current.measures.length);
      setTapCount(wijzerRef.current.times.length);
      setAnalysis(eff);
    }
    setStatus("已重做校正");
  }, [pageNum]);

  const canvasCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: ((clientX - r.left) * canvas.width) / r.width,
      y: ((clientY - r.top) * canvas.height) / r.height,
      rect: r,
    };
  }, []);

  const findNearestBar = useCallback(
    (x: number, y: number): { si: number; bi: number; dist: number } | null => {
      if (!analysis) return null;
      const threshold = Math.max(6, analysis.spatium * 1.2);
      let best: { si: number; bi: number; dist: number } | null = null;
      let bestDist = Infinity;
      for (let si = 0; si < analysis.systems.length; si++) {
        const s = analysis.systems[si];
        const y1 = s.cs[0];
        const y2 = s.cs[s.cs.length - 1];
        if (y < y1 - analysis.spatium || y > y2 + analysis.spatium) continue;
        const row = analysis.bars[si] ?? [];
        for (let bi = 0; bi < row.length; bi++) {
          const dist = Math.abs(row[bi] - x);
          if (dist <= threshold && dist < bestDist) {
            bestDist = dist;
            best = { si, bi, dist };
          }
        }
      }
      return best;
    },
    [analysis],
  );

  const deleteSelectedBar = useCallback(() => {
    if (!analysis || !selectedBar) return;
    const { si, bi } = selectedBar;
    const bars = cloneBars(analysis.bars);
    if (!bars[si] || bi < 0 || bi >= bars[si].length) return;
    if (bi === 0 || bi === bars[si].length - 1) {
      setStatus("系统左右边界不可删除(仅作小节端点)");
      return;
    }
    const removed = bars[si].splice(bi, 1)[0];
    setSelectedBar(null);
    commitBars(bars, `删除 p${pageNum} s${si + 1} x=${Math.round(removed)}`);
  }, [analysis, commitBars, pageNum, selectedBar]);

  const onScoreClick = useCallback(
    (ev: React.MouseEvent) => {
      const p = canvasCoords(ev.clientX, ev.clientY);
      if (!p) return;
      if (correctMode) {
        const hit = findNearestBar(p.x, p.y);
        setSelectedBar(hit ? { si: hit.si, bi: hit.bi } : null);
        if (hit) setStatus(`选中 p${pageNum} s${hit.si + 1} bar#${hit.bi + 1} x=${Math.round(analysis?.bars[hit.si]?.[hit.bi] ?? 0)} · 可拖动/ Delete 删除`);
        return;
      }
      const hit = wijzerRef.current.x2time(p.x, p.y);
      if (!hit) return;
      const m = mediaRef.current as any;
      if (m && mediaURL) m.currentTime = hit.t;
      else clockRef.current = { t0: performance.now(), base: hit.t, running: clockRef.current.running };
      setCursorInfo(`seek m${hit.measure + 1} t=${hit.t.toFixed(2)}s`);
    },
    [analysis, canvasCoords, correctMode, findNearestBar, mediaURL, pageNum],
  );

  const onScoreDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (!correctMode || !analysis) return;
      const p = canvasCoords(ev.clientX, ev.clientY);
      if (!p) return;
      let targetSi = -1;
      analysis.systems.forEach((s, si) => {
        const y1 = s.cs[0];
        const y2 = s.cs[s.cs.length - 1];
        if (p.y >= y1 - analysis.spatium && p.y <= y2 + analysis.spatium) targetSi = si;
      });
      if (targetSi < 0) { setStatus("双击位置不在任何系统内, 未新增"); return; }
      const bars = cloneBars(analysis.bars);
      bars[targetSi] = [...(bars[targetSi] ?? []), Math.round(p.x)].sort((a, b) => a - b);
      const bi = bars[targetSi].indexOf(Math.round(p.x));
      setSelectedBar({ si: targetSi, bi });
      commitBars(bars, `新增 p${pageNum} s${targetSi + 1} x=${Math.round(p.x)}`);
    },
    [analysis, canvasCoords, commitBars, correctMode, pageNum],
  );

  const onBarPointerDown = useCallback(
    (si: number, bi: number) => (ev: React.PointerEvent) => {
      if (!correctMode) return;
      ev.stopPropagation();
      (ev.target as Element).setPointerCapture?.(ev.pointerId);
      pushUndo();
      dragRef.current = { si, bi, active: true };
      setSelectedBar({ si, bi });
    },
    [correctMode, pushUndo],
  );

  const onNotationPointerMove = useCallback(
    (ev: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active || !analysis) return;
      const p = canvasCoords(ev.clientX, ev.clientY);
      if (!p) return;
      const bars = cloneBars(analysis.bars);
      const row = bars[drag.si];
      if (!row) return;
      const sys = analysis.systems[drag.si];
      const lo = (sys?.xs.x1 ?? 0) + 2;
      const hi = (sys?.xs.x2 ?? analysis.pageW) - 2;
      row[drag.bi] = Math.round(Math.max(lo, Math.min(hi, p.x)));
      // 拖动时保持行内有序(端点除外, 避免交叉)
      if (drag.bi > 0 && row[drag.bi] < row[drag.bi - 1] + 1) row[drag.bi] = row[drag.bi - 1] + 1;
      if (drag.bi < row.length - 1 && row[drag.bi] > row[drag.bi + 1] - 1) row[drag.bi] = row[drag.bi + 1] - 1;
      const nextManual = { ...manualRef.current, [pageNum]: bars };
      manualRef.current = nextManual;
      setManualBarsByPage(nextManual);
      wijzerRef.current.measures = buildMeasures({ ...analysis, bars });
      setAnalysis({ ...analysis, bars });
    },
    [analysis, canvasCoords, pageNum],
  );

  const onNotationPointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag.active) return;
    drag.active = false;
    redoRef.current = [];
    if (analysis) {
      const x = analysis.bars[drag.si]?.[drag.bi];
      setStatus(`校正 p${pageNum} s${drag.si + 1} → x=${Math.round(x ?? 0)}`);
    }
  }, [analysis, pageNum]);

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
    const c = w.time2x(t, opt.lncsr === 1);
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

  // timing JSON 存取(含 schema/算法版本/页尺寸/人工校正校验)
  const saveTiming = useCallback(() => {
    const w = wijzerRef.current;
    const payload = buildTimingPayload({
      pdfName: pdfName || undefined,
      numPages: numPages || undefined,
      pageW: analysis?.pageW,
      pageH: analysis?.pageH,
      measureCount: w.measures.length,
      times: w.times,
      manualBarsByPage: manualRef.current,
      loop: { start: w.loopStart, end: w.loopEnd },
    });
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "scorefollow-timing.json";
    a.click();
    setStatus(`saved ${w.times.length} sync points · algo v${ALGO_VERSION}`);
  }, [analysis, numPages, pdfName]);

  const loadTiming = useCallback((f: File) => {
    f.text().then((txt) => {
      let p: unknown;
      try { p = JSON.parse(txt); } catch { setStatus("timing file parse failed"); return; }
      const v = validateTimingPayload(p);
      if (!v.ok || !v.data) { setStatus(`timing 校验失败: ${v.reason}`); return; }
      const d = v.data;
      const warnings: string[] = [];
      if (d.algoVersion !== ALGO_VERSION) warnings.push(`algo v${d.algoVersion}→v${ALGO_VERSION}`);
      if (d.pageW && analysis && (d.pageW !== analysis.pageW || d.pageH !== analysis.pageH)) {
        warnings.push(`页尺寸 ${d.pageW}x${d.pageH}≠当前${analysis.pageW}x${analysis.pageH}`);
      }
      if (d.pdfName && pdfName && d.pdfName !== pdfName) warnings.push(`谱面 ${d.pdfName}≠${pdfName}`);
      if (d.opt) {
        for (const [k, val] of Object.entries(d.opt)) {
          const num = 1 * (val as number);
          if (!Number.isFinite(num)) continue;
          if (k === "skipn") { setSkipn(num); opt.skipn = num; }
          else if (k === "sysprf") setSysprf(num);
          else (opt as unknown as Record<string, number>)[k] = num;
        }
      }
      if (d.manualBarsByPage) {
        const next: Record<number, number[][]> = {};
        for (const [k, val] of Object.entries(d.manualBarsByPage)) {
          if (Array.isArray(val)) next[Number(k)] = (val as number[][]).map((r) => r.slice());
        }
        manualRef.current = next;
        setManualBarsByPage(next);
      }
      wijzerRef.current.loadTimes(d.times_arr);
      if (d.loop) wijzerRef.current.setLoop(d.loop.start, d.loop.end);
      setTapCount(wijzerRef.current.times.length);
      clearPageCache();
      forceAdv((n) => n + 1);
      if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum);
      setStatus(`loaded ${wijzerRef.current.times.length} sync points` + (warnings.length ? ` · 注意: ${warnings.join("; ")}` : ""));
    }).catch(() => setStatus("timing file parse failed"));
  }, [analysis, pageNum, pdfName, renderPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
      if (correctMode && (e.key === "Delete" || e.key === "Del")) { e.preventDefault(); deleteSelectedBar(); return; }
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
  }, [playing, doPlay, doPause, now, mediaURL, synbox, doTap, backupOne, adjustLast, correctMode, deleteSelectedBar, doUndo, doRedo]);

  useEffect(() => {
    const m = mediaRef.current as any;
    if (m && mediaURL) m.playbackRate = speed;
    if (!mediaURL) clockRef.current.running = playing;
  }, [speed, mediaURL, playing]);

  // demo 模式: ?demo=1 自动载入内置谱 (免上传即测)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("demo")) return;
    let dead = false;
    (async () => {
      try {
        const r = await fetch("/demo-score.pdf");
        const b = await r.blob();
        if (dead) return;
        await onPdfFile(new File([b], "demo-score.pdf", { type: "application/pdf" }));
        if (!dead) setStatus((s) => s + " · demo 谱已载入");
      } catch {
        if (!dead) setStatus("demo 谱载入失败");
      }
    })();
    return () => { dead = true; };
  }, [onPdfFile]);

  const barsTotal = analysis
    ? analysis.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0)
    : 0;
  const confRange = analysis?.confidence.length
    ? `${Math.min(...analysis.confidence).toFixed(2)}–${Math.max(...analysis.confidence).toFixed(2)}`
    : "—";
  const lowConfSystems = analysis
    ? analysis.systems.filter((_, i) => (analysis.confidence[i] ?? 1) < 0.6).length
    : 0;
  const isManual = analysis ? manualRef.current[pageNum] != null : false;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div><h1>scorefollow</h1><p>PDF score follower{pdfName ? ` · ${pdfName}` : ""}</p></div>
        <span className={styles.badge}>synpdf rev.194 · TS · algo v{ALGO_VERSION}</span>
      </header>

      <section className={styles.toolbar} aria-label="文件与播放">
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
      </section>

      <section className={styles.subtoolbar} aria-label="分析与同步">
        <label className="pill"><input type="checkbox" checked={showSystems} onChange={(e) => setShowSystems(e.target.checked)} /> systems</label>
        <label className="pill"><input type="checkbox" checked={showBars} onChange={(e) => setShowBars(e.target.checked)} /> barlines</label>
        <label className="pill"><input type="checkbox" checked={showCursor} onChange={(e) => setShowCursor(e.target.checked)} /> cursor</label>
        <label className="pill"><input type="checkbox" checked={showLowConf} onChange={(e) => setShowLowConf(e.target.checked)} /> low-conf</label>
        <label className="pill"><input type="checkbox" checked={advOpen} onChange={(e) => setAdvOpen(e.target.checked)} /> advanced</label>
        <label className="pill"><input type="checkbox" checked={synbox} onChange={(e) => setSynbox(e.target.checked)} /> enable sync</label>
        <label className="pill"><input type="checkbox" checked={opt.lncsr === 1} onChange={(e) => applyAdv("lncsr", e.target.checked ? 1 : 0)} /> line cursor</label>
        <label className="pill"><input type="checkbox" checked={correctMode} onChange={(e) => { setCorrectMode(e.target.checked); setSelectedBar(null); }} /> correct bars</label>
        <button onClick={saveTiming}>save timing</button>
        <label className="pill">load timing <input type="file" accept=".json" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadTiming(f); }} /></label>
        <span style={{ fontSize: 12, color: "#9fb0c8" }}>{status}</span>
        <span style={{ fontSize: 12, color: "#7fe0a8" }}>{cursorInfo}</span>
      </section>

      {correctMode && (
        <section className={styles.correctbar} aria-label="小节线校正">
          <span>校正 p{pageNum}{isManual ? " · manual" : " · auto"}：单击选中/拖动小节线，双击空白新增，Delete 删除</span>
          <button onClick={doUndo}>undo</button>
          <button onClick={doRedo}>redo</button>
          <button onClick={deleteSelectedBar} disabled={!selectedBar}>delete selected</button>
          <button onClick={resetPageCorrections}>恢复自动识别</button>
          <button onClick={copyCorrectionsToAll} disabled={!numPages}>复制到全部页</button>
          {selectedBar && <span>选中 s{selectedBar.si + 1} #{selectedBar.bi + 1}</span>}
        </section>
      )}

      {advOpen && (
        <div className={styles.advpanel}>
          <fieldset>
            <legend>识别 profile</legend>
            {(["fast", "balanced", "scan"] as AnalysisProfileName[]).map((name) => (
              <label key={name}><input type="radio" name="profile" checked={profileName === name} onChange={() => applyProfile(name)} /> {name}</label>
            ))}
            <button onClick={resetAdvDefaults}>恢复默认值</button>
          </fieldset>
          <fieldset>
            <legend>识别</legend>
            <label>zwgrens <input type="range" min={0.3} max={1.5} step={0.05} value={opt.zwgrens} onChange={(e) => applyAdv("zwgrens", Number(e.target.value))} /> {opt.zwgrens}</label>
            <label>drmpl <input type="range" min={0.1} max={1} step={0.05} value={opt.drmpl} onChange={(e) => applyAdv("drmpl", Number(e.target.value))} /> {opt.drmpl}</label>
            <label>drmpl2 <input type="range" min={0.5} max={5} step={0.1} value={opt.drmpl2} onChange={(e) => applyAdv("drmpl2", Number(e.target.value))} /> {opt.drmpl2}</label>
            <label>mtdrmpl <input type="range" min={0.3} max={1.2} step={0.05} value={opt.mtdrmpl} onChange={(e) => applyAdv("mtdrmpl", Number(e.target.value))} /> {opt.mtdrmpl}</label>
            <label>voorna <input type="range" min={0.5} max={1} step={0.05} value={opt.voorna} onChange={(e) => applyAdv("voorna", Number(e.target.value))} /> {opt.voorna}</label>
            <label>dx <input type="range" min={1} max={10} step={1} value={opt.dx} onChange={(e) => applyAdv("dx", Number(e.target.value))} /> {opt.dx}</label>
          </fieldset>
          <fieldset>
            <legend>系统</legend>
            <label><input type="checkbox" checked={opt.sysprf ? true : false} onChange={(e) => applyAdv("sysprf", e.target.checked ? 1 : 0)} /> sysprf</label>
            <label><input type="checkbox" checked={opt.onestf ? true : false} onChange={(e) => applyAdv("onestf", e.target.checked ? 1 : 0)} /> onestf</label>
            <label><input type="checkbox" checked={opt.eerst ? true : false} onChange={(e) => applyAdv("eerst", e.target.checked ? 1 : 0)} /> eerst</label>
            <label>skipn <input type="number" min={0} max={5} value={opt.skipn} onChange={(e) => applyAdv("skipn", Number(e.target.value))} /></label>
            <label>seln <input type="number" min={0} max={9} value={opt.seln} onChange={(e) => applyAdv("seln", Number(e.target.value))} /></label>
            <label>cropx <input type="number" min={0} value={opt.cropx} onChange={(e) => applyAdv("cropx", Number(e.target.value))} /></label>
          </fieldset>
          <fieldset>
            <legend>调试</legend>
            <label>pagewd <input type="number" min={600} max={3000} step={50} value={opt.pagewd} onChange={(e) => applyAdv("pagewd", Number(e.target.value) || 1000)} /></label>
            <label>fixwd <input type="number" min={0} step={100} value={opt.fixwd} onChange={(e) => applyAdv("fixwd", Number(e.target.value) || 0)} /></label>
          </fieldset>
        </div>
      )}

      {mediaURL && mediaKind === "video" && (
        <video ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls style={{ maxWidth: "100%", margin: "8px 0" }} />
      )}
      {mediaURL && mediaKind === "audio" && (
        <audio ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls style={{ width: "100%", margin: "8px 0" }} />
      )}

      <div
        id="notation"
        ref={notationRef}
        className={styles.notation}
        onClick={onScoreClick}
        onDoubleClick={onScoreDoubleClick}
        onPointerMove={onNotationPointerMove}
        onPointerUp={onNotationPointerUp}
      >
        <canvas ref={canvasRef} style={{ display: "block", maxWidth: "100%" }} />
        {analysis && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: correctMode ? "auto" : "none" }} viewBox={`0 0 ${analysis.pageW} ${analysis.pageH}`}>
            {showSystems && analysis.systems.map((s, i) => {
              const low = (analysis.confidence[i] ?? 1) < 0.6;
              return (
                <rect
                  key={`sys${i}`}
                  x={s.xs.x1} y={s.cs[0]} width={s.xs.x2 - s.xs.x1} height={s.cs[s.cs.length - 1] - s.cs[0]}
                  fill={low && showLowConf ? "rgba(255,180,0,0.14)" : "rgba(0,200,0,0.10)"}
                  stroke={low && showLowConf ? "rgba(200,140,0,0.8)" : "rgba(0,180,0,0.55)"}
                  strokeWidth={2}
                  strokeDasharray={low && showLowConf ? "8 4" : undefined}
                />
              );
            })}
            {showBars && (analysis.bars.flatMap((b, si) => {
              const s = analysis.systems[si];
              if (!s) return [];
              return b.map((x, bi) => {
                const selected = selectedBar?.si === si && selectedBar?.bi === bi;
                return (
                  <line
                    key={`bar${si}-${bi}`}
                    x1={x} y1={s.cs[0]} x2={x} y2={s.cs[s.cs.length - 1]}
                    stroke={selected ? "rgba(0,120,255,0.95)" : "rgba(255,0,0,0.55)"}
                    strokeWidth={selected ? 5 : 2}
                    style={correctMode ? { cursor: "ew-resize", pointerEvents: "stroke" } : undefined}
                    onPointerDown={correctMode ? onBarPointerDown(si, bi) : undefined}
                  />
                );
              });
            }))}
          </svg>
        )}
        {showCursor && cursor && (
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

      <div className={styles.footer}>
        {analysis ? `${analysis.systems.length} systems · ${barsTotal} measures · spatium ${analysis.spatium.toFixed(1)}px · conf ${confRange} · ${analysis.elapsedMs}ms${lowConfSystems ? ` · ${lowConfSystems}低置信度` : ""}${isManual ? " · manual" : ""} · ${tapCount} taps` : "no analysis yet"} ·
        keys: space play · ←/→ bar · +/− speed{synbox ? " · B tap · ⌫ backup · ,/. adjust" : ""}{correctMode ? " · correct: click/drag · dbl-click add · Delete del · Ctrl+Z/Y" : ""}
      </div>

    </main>
  );
}
