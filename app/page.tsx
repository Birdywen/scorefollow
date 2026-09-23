"use client";

/**
 * scorefollow — synpdf rev.194 Next.js 全量 TypeScript 移植 (Phase 2.1)
 * PDF 渲染(pdfjs-dist) + 像素级小节检测(lib) + 光标跟随(Wijzer)
 * + count-in / A-B 循环 / 变速 / TAP 建图 / advanced 识别参数面板
 * + 人工小节线校正层(manualBarsByPage) / 覆盖层开关 / timing 校验。
 */
import { useCallback, useEffect, useRef, useState } from "react";

// 静态部署 basePath（next.config.ts 保持同步）
const BASE = "/scorefollow";
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
// stepper 合法范围(与原版 synpdf.html 输入框 min/max 一致)
const ADV_RANGES: Record<string, [number, number]> = {
  zwgrens: [0.3, 1.5], drmpl: [0.1, 1], drmpl2: [0.5, 5],
  mtdrmpl: [0.3, 1.2], voorna: [0.5, 1], dx: [1, 10],
};
const ADV_STEPS: Record<string, number> = {
  zwgrens: 0.05, drmpl: 0.05, drmpl2: 0.1, mtdrmpl: 0.05, voorna: 0.05, dx: 1,
};

function cloneBars(bars: number[][]): number[][] {
  return bars.map((b) => b.slice());
}

export default function ScoreFollowPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const notationRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const pagesHostRef = useRef<HTMLDivElement>(null);
  const pageOffsetsRef = useRef<{ page: number; y: number; h: number; w: number }[]>([]);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const pdfDocRef = useRef<any>(null);
  const pdfNameRef = useRef("");
  const pageNumRef = useRef(1);
  const pdfBytesRef = useRef<ArrayBuffer | null>(null);
  const pageProxyRef = useRef<any>(null);
  const wijzerRef = useRef<Wijzer>(new Wijzer());
  const rafRef = useRef(0);
  const clockRef = useRef({ t0: 0, base: 0, running: false });
  const autoRef = useRef<Record<number, PageAnalysis>>({});
  const manualRef = useRef<Record<number, number[][]>>({});
  const undoRef = useRef<Record<number, number[][]>[]>([]);
  const redoRef = useRef<Record<number, number[][]>[]>([]);
  const dragRef = useRef<{ si: number; bi: number; active: boolean }>({ si: -1, bi: -1, active: false });
  const curMixRef = useRef(0);
  // 批注(原版 annots): {x,y:画布像素, w:创建时页宽, c:cropx, t:文本, d:删除标记} + p:页(超集字段, 原版忽略)
  interface Annot { x: number; y: number; w: number; c: number; t: string; d: number; p?: number }
  const annotsRef = useRef<Record<number, Annot[]>>({});
  const [annotsByPage, setAnnotsByPage] = useState<Record<number, Annot[]>>({});
  const annotDragRef = useRef<{ idx: number; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);

  const [status, setStatus] = useState("scorefollow ready — upload a PDF score");
  const [cursorInfo, setCursorInfo] = useState("");
  const [advOpen, setAdvOpen] = useState(true);
  const [advNonce, forceAdv] = useState(0);
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
  // 干净视图: 一键隐藏全部覆盖层(含 line cursor), 供 metronome 播放时用, 再按恢复
  const [cleanView, setCleanView] = useState(false);
  const cleanSavedRef = useRef<{ sys: boolean; bars: boolean; cur: boolean; low: boolean; lncsr: number } | null>(null);
  // 人工校正
  const [manualBarsByPage, setManualBarsByPage] = useState<Record<number, number[][]>>({});
  const [correctMode, setCorrectMode] = useState(false);
  const [selectedBar, setSelectedBar] = useState<{ si: number; bi: number } | null>(null);
  // pie 菜单锚点(视口坐标), 选中由 selectedBar 承载
  const [pie, setPie] = useState<{ x: number; y: number } | null>(null);
  const [profileName, setProfileName] = useState<AnalysisProfileName>("balanced");
  const [embedMetro, setEmbedMetro] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
  const [darkTheme, setDarkTheme] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chromeOpen, setChromeOpen] = useState(true);
  const [mediaName, setMediaName] = useState("");
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  const toggleFullScreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { setStatus("fullscreen unavailable"); }
  }, []);

  useEffect(() => {
    const sync = () => setFullScreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    manualRef.current = manualBarsByPage;
  }, [manualBarsByPage]);

  // pdf.js worker(同构安全: 只在客户端配)
  useEffect(() => {
    (async () => {
      const pdfjs: any = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}/pdf.worker.min.mjs`;
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

  const renderingRef = useRef(false);
  // 全量渲染代次: slider 连续触发时旧一轮中途放弃, 避免双份 canvas/错位 offsets
  const renderGenRef = useRef(0);
  const advRenderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 全页 metric 原子构建(保存/桥接共用): [pageW, p1, p2, ...], 缺失页 null, 人工校正优先
  const buildMetricArr = useCallback((): unknown[] => {
    const first = autoRef.current[1];
    const pageW = first?.pageW ?? opt.pagewd ?? 1000;
    const out: unknown[] = [pageW];
    const nps = Math.max(0, ...Object.keys(autoRef.current).map(Number));
    for (let n = 1; n <= nps; n++) {
      const a = autoRef.current[n];
      if (!a) { out.push(null); continue; }
      const k = pageW / a.pageW;
      const bars = manualRef.current[n] ?? a.bars;
      out.push({
        cxs: a.systems.map((s) => ({
          cs: s.cs.map((y) => Math.round(y * k * 1000) / 1000),
          xs: { x1: Math.round(s.xs.x1 * k * 1000) / 1000, x2: Math.round(s.xs.x2 * k * 1000) / 1000 },
        })),
        bxs: bars.map((row) => row.map((x) => Math.round(x * k * 1000) / 1000)),
      });
    }
    return out;
  }, []);

  // metro 桥接事件: 全页 metric_arr(与原版 deMetriek 同形, 连续谱面)
  const emitMetricRendered = useCallback(() => {
    try {
      const ma = buildMetricArr();
      window.dispatchEvent(new CustomEvent("synpdf:metric-rendered", { detail: { metricArr: ma } }));
    } catch { /* metro 未加载时忽略 */ }
  }, [buildMetricArr]);

  // 渲染+分析单页(后台页用离屏 canvas, 不碰可见状态)
  const renderAndAnalyze = useCallback(
    async (pdf: any, n: number, canvas: HTMLCanvasElement, docId?: string) => {
      renderingRef.current = true;
      try {
        const proxy = await pdf.getPage(n);
        const v0 = proxy.getViewport({ scale: 1 });
        const scale = (opt.pagewd || 1000) / v0.width;
        const vp = proxy.getViewport({ scale });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await proxy.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        const a = analyzePage(canvas, n, opt.seln, docId ?? pdfNameRef.current);
        if (a.systems.length === 0) {
          autoRef.current[n] = null as any;
          return { a: null, proxy };
        }
        autoRef.current[n] = a;
        return { a, proxy };
      } finally {
        renderingRef.current = false;
      }
    },
    [],
  );

  const mergeFromPages = useCallback((): PageAnalysis | null => {
    const first = autoRef.current[1];
    if (!first) return null;
    const systems: PageAnalysis["systems"] = [];
    const bars: number[][] = [];
    const confidence: number[] = [];
    let totalH = 0;
    for (const off of pageOffsetsRef.current) {
      const a = autoRef.current[off.page];
      if (!a) continue;
      const pageBars = manualRef.current[off.page] ?? a.bars;
      a.systems.forEach((s, i) => {
        systems.push({ cs: s.cs.map((y) => y + off.y), xs: { x1: s.xs.x1, x2: s.xs.x2 } });
        bars.push((pageBars[i] ?? []).slice());
        confidence.push(a.confidence[i] ?? 1);
      });
      totalH = Math.max(totalH, off.y + off.h);
    }
    return { ...first, systems, bars, confidence, pageH: totalH, pageNumber: 1, diagnostics: [] };
  }, []);

  // 原版 readPdfdoc: 所有页竖拼进 #notation, knip 用 y 偏移合成全局小节
  const renderAllPages = useCallback(
    async (pdf: any, docId?: string) => {
      const gen = ++renderGenRef.current;
      const host = pagesHostRef.current;
      if (!pdf || !host) return;
      host.innerHTML = "";
      const offsets: { page: number; y: number; h: number; w: number }[] = [];
      let y = 0;
      const nPages = pdf.numPages as number;
      setNumPages(nPages);
      for (let n = 1; n <= nPages; n++) {
        if (gen !== renderGenRef.current) return; // 被更新一轮取代
        setStatus(`rendering page: ${n}/${nPages}`);
        const canvas = document.createElement("canvas");
        canvas.style.display = "block";
        canvas.style.width = "100%";
        canvas.dataset.page = String(n);
        try {
          await renderAndAnalyze(pdf, n, canvas, docId);
        } catch (err) {
          autoRef.current[n] = null as any;
          setStatus(`page ${n} analysis skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (gen !== renderGenRef.current) return; // 丢弃过期结果
        host.appendChild(canvas);
        offsets.push({ page: n, y, h: canvas.height, w: canvas.width });
        y += canvas.height;
      }
      if (gen !== renderGenRef.current) return;
      pageOffsetsRef.current = offsets;
      const merged = mergeFromPages();
      if (!merged) return;
      const savedTimes = wijzerRef.current.times.slice();
      wijzerRef.current.reset(merged);
      const { kept, dropped } = wijzerRef.current.retainTimes(savedTimes);
      wijzerRef.current.fillDummyTimes();
      setTapCount(wijzerRef.current.times.length);
      setAnalysis(merged);
      setSelectedBar(null);
      const m0 = wijzerRef.current.measures[0];
      if (m0) {
        curMixRef.current = 0;
        setCursor(opt.lncsr === 1
          ? { x: m0.x, y: m0.y, w: Math.max(2, m0.w * 0.06), h: m0.h }
          : { x: m0.x, y: m0.y, w: m0.w, h: m0.h });
        setCursorInfo("m1");
      } else {
        setCursor(null);
        setCursorInfo("");
      }
      const meas = merged.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0);
      setStatus(`score: ${nPages} pages, ${merged.systems.length} systems, ${meas} measures, spatium ${merged.spatium.toFixed(1)}px, algo v${merged.algoVersion}` +
        (dropped ? ` · timing截断 ${kept}保留/${dropped}越界` : ""));
      emitMetricRendered();
    },
    [describeAnalysis, emitMetricRendered, mergeFromPages, renderAndAnalyze],
  );

  const renderPage = useCallback(
    async (pdf: any, _n?: number, docId?: string) => {
      await renderAllPages(pdf, docId);
    },
    [renderAllPages],
  );

  // advance 调参防抖: slider 拖动只在停手 350ms 后重渲染一次
  const scheduleAdvRender = useCallback(
    (pdf: any) => {
      if (advRenderTimer.current) clearTimeout(advRenderTimer.current);
      advRenderTimer.current = setTimeout(() => {
        advRenderTimer.current = null;
        if (pdfDocRef.current) void renderPage(pdf ?? pdfDocRef.current);
      }, 350);
    },
    [renderPage],
  );

  // metro 桥接(Smart-Metro/metro-engine.js 契约): 当前页 metric + 渲染状态 + 重算事件
  useEffect(() => {
    (window as unknown as Record<string, unknown>).SynPDFRuntime = Object.assign(
      (window as unknown as Record<string, unknown>).SynPDFRuntime ?? {},
      {
        version: "scorefollow-v16",
        getMetricArr: () => JSON.parse(JSON.stringify(buildMetricArr())),
        getMeasureCount: () => wijzerRef.current.measures.length,
        isRendering: () => renderingRef.current,
      },
    );
  }, [buildMetricArr]);

  // 节拍器: 原版通过 annot 注入, 练习页直接挂脚本, metric 走 SynPDFRuntime
  useEffect(() => {
    if (!embedMetro) return;
    if (document.querySelector('script[data-sf-metro]')) {
      emitMetricRendered();
      return;
    }
    const s = document.createElement("script");
    // vendor 改动即 bump 此版本, 强制破浏览器缓存(旧引擎静默会导致无声/键位错乱)
    s.src = `${BASE}/metro-engine.js?v=20260923-jump`;
    s.async = true;
    s.dataset.sfMetro = "1";
    s.onload = () => emitMetricRendered();
    document.head.appendChild(s);
  }, [embedMetro, emitMetricRendered]);

  // 新谱面: 必须清掉上一份谱的全部状态(缓存/人工校正/timing/undo),
  // 否则同页同尺寸会命中旧缓存、旧小节线盖到新谱上。
  const onPdfFile = useCallback(
    async (f: File) => {
      setStatus(`loading ${f.name} ...`);
      try {
        const pdfjs: any = await import("pdfjs-dist");
        const buf = await f.arrayBuffer();
        pdfBytesRef.current = buf.slice(0);
        const pdf = await pdfjs.getDocument({ data: buf, wasmUrl: `${BASE}/wasm/` }).promise;
        pdfDocRef.current = pdf;
        clearPageCache();
        autoRef.current = {};
        manualRef.current = {};
        setManualBarsByPage({});
        annotsRef.current = {};
        setAnnotsByPage({});
        undoRef.current = [];
        redoRef.current = [];
        wijzerRef.current.loadTimes([]);
        wijzerRef.current.setLoop(0, 0);
        setTapCount(0);
        setSelectedBar(null);
        pdfNameRef.current = f.name;
        setPdfName(f.name);
        setNumPages(pdf.numPages);
        pageNumRef.current = 1;
        setPageNum(1);
        await renderPage(pdf, 1, f.name);
      } catch (err) {
        setStatus(`载入失败 ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [renderPage],
  );

  const applyAdv = useCallback(
    (k: string, v: number) => {
      if (!Number.isFinite(v)) return;
      // number 输入钳制到合法范围, 避免 typing 中间态污染识别
      const range = ADV_RANGES[k];
      if (range) v = Math.min(range[1], Math.max(range[0], v));
      if (k === "dx") v = Math.round(v);
      if (k === "skipn") { setSkipn(v); opt.skipn = v; }
      else if (k === "sysprf") { setSysprf(v); }
      else (opt as unknown as Record<string, number>)[k] = v;
      clearPageCache();
      forceAdv((n) => n + 1);
      setStatus(`advanced: ${k}=${v} - reanalyzed`);
      if (pdfDocRef.current) scheduleAdvRender(pdfDocRef.current);
    },
    [scheduleAdvRender],
  );

  const applyProfile = useCallback(
    (name: AnalysisProfileName) => {
      applyAnalysisProfile(name);
      setProfileName(name);
      forceAdv((n) => n + 1);
      setStatus(`profile: ${name} - reanalyzed`);
      if (pdfDocRef.current) scheduleAdvRender(pdfDocRef.current);
    },
    [scheduleAdvRender],
  );

  // V: 干净视图开关. 开=存当前状态后全隐(含 line cursor, 走 applyAdv 会触发一次重分析);
  // 关=恢复之前的状态, 没动过的开关保持原值, 只调一次 applyAdv
  const toggleCleanView = useCallback(() => {
    if (!cleanView) {
      cleanSavedRef.current = {
        sys: showSystems, bars: showBars, cur: showCursor, low: showLowConf,
        lncsr: (opt as unknown as Record<string, number>).lncsr ?? 1,
      };
      setShowSystems(false); setShowBars(false); setShowCursor(false); setShowLowConf(false);
      if (((opt as unknown as Record<string, number>).lncsr ?? 1) === 1) applyAdv("lncsr", 0);
      setCleanView(true);
      setStatus("clean view: 覆盖层已隐藏 (V 恢复)");
    } else {
      const s = cleanSavedRef.current;
      if (s) {
        setShowSystems(s.sys); setShowBars(s.bars); setShowCursor(s.cur); setShowLowConf(s.low);
        if (s.lncsr === 1 && ((opt as unknown as Record<string, number>).lncsr ?? 0) === 0) applyAdv("lncsr", 1);
      } else { setShowSystems(true); setShowBars(true); setShowCursor(true); setShowLowConf(true); }
      setCleanView(false);
      setStatus("clean view: 已恢复覆盖层");
    }
  }, [cleanView, showSystems, showBars, showCursor, showLowConf, applyAdv]);

  const resetAdvDefaults = useCallback(() => {
    for (const [k, v] of Object.entries(DEFAULT_ADV)) {
      if (k === "skipn") { setSkipn(v); opt.skipn = v; }
      else if (k === "sysprf") setSysprf(v);
      else (opt as unknown as Record<string, number>)[k] = v;
    }
    clearPageCache();
    forceAdv((n) => n + 1);
    setStatus("advanced: 已恢复默认值 - reanalyzed");
    if (pdfDocRef.current) scheduleAdvRender(pdfDocRef.current);
  }, [scheduleAdvRender]);

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
      let i = 0;
      const nextManual: Record<number, number[][]> = { ...manualRef.current };
      for (const off of pageOffsetsRef.current) {
        const a = autoRef.current[off.page];
        if (!a) continue;
        const nsys = a.systems.length;
        nextManual[off.page] = cloneBars(nextBars.slice(i, i + nsys));
        i += nsys;
      }
      manualRef.current = nextManual;
      setManualBarsByPage(nextManual);
      wijzerRef.current.measures = buildMeasures({ ...analysis, bars: nextBars });
      wijzerRef.current.fillDummyTimes();
      const before = wijzerRef.current.times.length;
      wijzerRef.current.times = wijzerRef.current.times.filter((t) => t.mix < wijzerRef.current.measures.length);
      wijzerRef.current.fillDummyTimes();
      setTapCount(wijzerRef.current.times.length);
      const dropped = before - wijzerRef.current.times.length;
      const eff: PageAnalysis = { ...analysis, bars: cloneBars(nextBars) };
      setAnalysis(eff);
      setStatus(`${label} · ${eff.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0)} measures` + (dropped ? ` · timing截断${dropped}个` : ""));
      emitMetricRendered();
    },
    [analysis, pushUndo, emitMetricRendered],
  );

  const resetPageCorrections = useCallback(() => {
    if (!autoRef.current[1]) { setStatus("无自动识别结果可恢复"); return; }
    pushUndo();
    manualRef.current = {};
    setManualBarsByPage({});
    const merged = mergeFromPages();
    if (!merged) return;
    const saved = wijzerRef.current.times.slice();
    wijzerRef.current.reset(merged);
    const { dropped } = wijzerRef.current.retainTimes(saved);
    wijzerRef.current.fillDummyTimes();
    setTapCount(wijzerRef.current.times.length);
    setAnalysis(merged);
    setSelectedBar(null);
    setStatus(`已恢复自动识别` + (dropped ? ` · timing截断${dropped}个` : ""));
    emitMetricRendered();
  }, [pushUndo, mergeFromPages, emitMetricRendered]);

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
    const stack = stackRef.current;
    if (!stack || !analysis) return null;
    const r = stack.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: ((clientX - r.left) * analysis.pageW) / r.width,
      y: ((clientY - r.top) * analysis.pageH) / r.height,
      rect: r,
    };
  }, [analysis]);

  // 光标定位到小节(原版点击阴影/x2time 语义): 画蓝 shade + 可选 seek
  const placeCursor = useCallback((mix: number, seekT?: number) => {
    const ms = wijzerRef.current.measures;
    if (!ms.length) return;
    const idx = ((Math.round(mix) % ms.length) + ms.length) % ms.length;
    const m = ms[idx];
    curMixRef.current = idx;
    setCursor({ x: m.x, y: m.y, w: m.w, h: m.h });
    const notn = notationRef.current;
    const stack = stackRef.current;
    if (notn && stack && analysis) {
      const scale = stack.clientWidth / Math.max(1, analysis.pageW);
      const yCss = m.y * scale;
      const target = Math.round(yCss - notn.clientHeight * 0.3);
      const mx = notn.scrollHeight - notn.clientHeight;
      notn.scrollTop = Math.max(0, Math.min(mx, target));
    }
    if (seekT != null && Number.isFinite(seekT)) {
      const md = mediaRef.current as any;
      if (md && mediaURL) md.currentTime = seekT;
      else clockRef.current = { t0: performance.now(), base: seekT, running: clockRef.current.running };
    }
    setCursorInfo(`m${idx + 1}${seekT != null ? ` t=${seekT.toFixed(2)}s` : ""}`);
  }, [mediaURL, analysis]);

  // 上/下排切换(原版 goUpDown 小节模式): 同 x 中心跳到相邻系统行
  const stepSystem = useCallback((dir: 1 | -1) => {
    const w = wijzerRef.current;
    const ms = w.measures;
    if (!ms.length) return;
    const rows: number[] = [];
    for (const m of ms) {
      const key = m.y + m.h;
      if (!rows.includes(key)) rows.push(key);
    }
    rows.sort((a, b) => a - b);
    const cur = ms[curMixRef.current] ?? ms[0];
    const cx = cur.x + cur.w / 2;
    let e = 0;
    while (e < rows.length && rows[e] < cur.y) e++;
    const targetRow = dir < 0
      ? rows[e === 0 ? rows.length - 1 : e - 1]
      : rows[e >= rows.length - 1 ? 0 : e + 1];
    const hit = w.x2time(cx, targetRow - 5);
    if (!hit) return;
    placeCursor(hit.measure, hit.t);
  }, [placeCursor]);

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

  const splitSelectedMeasure = useCallback(() => {
    if (!analysis || !selectedBar) return;
    const { si, bi } = selectedBar;
    const row = analysis.bars[si];
    if (!row || bi < 0 || bi >= row.length - 1) return;
    const left = row[bi];
    const right = row[bi + 1];
    const mid = Math.round((left + right) / 2);
    if (mid <= left || mid >= right) return;
    const bars = cloneBars(analysis.bars);
    bars[si].splice(bi + 1, 0, mid);
    setSelectedBar({ si, bi: bi + 1 });
    commitBars(bars, `split p${pageNum} s${si + 1} m${bi + 1}`);
  }, [analysis, commitBars, pageNum, selectedBar]);

  const mergeSelectedMeasure = useCallback((side: "left" | "right") => {
    if (!analysis || !selectedBar) return;
    const { si, bi } = selectedBar;
    const row = analysis.bars[si];
    if (!row || bi <= 0 || bi >= row.length - 1) return;
    const removeIndex = side === "left" ? bi : bi + 1;
    if (removeIndex <= 0 || removeIndex >= row.length - 1) return;
    const bars = cloneBars(analysis.bars);
    bars[si].splice(removeIndex, 1);
    setSelectedBar({ si, bi: Math.max(1, Math.min(bi, bars[si].length - 2)) });
    commitBars(bars, `merge ${side} p${pageNum} s${si + 1}`);
  }, [analysis, commitBars, pageNum, selectedBar]);

  // pie 菜单动作包装: split/merge 保持打开以便连续修正, 其余关闭
  const pieAction = (fn: () => void, keepOpen: boolean) => () => {
    fn();
    if (!keepOpen) setPie(null);
  };

  // 小节面命中: 返回该小节左线 {si, bi}(split/merge/delete 语义天然对齐)
  const findMeasureAt = useCallback(
    (x: number, y: number): { si: number; bi: number } | null => {
      if (!analysis) return null;
      for (let si = 0; si < analysis.systems.length; si++) {
        const s = analysis.systems[si];
        const y1 = s.cs[0];
        const y2 = s.cs[s.cs.length - 1];
        if (y < y1 - analysis.spatium || y > y2 + analysis.spatium) continue;
        const row = analysis.bars[si] ?? [];
        if (row.length < 2) continue;
        let bi = 0;
        for (let i = 0; i < row.length - 1; i++) {
          if (x >= row[i]) bi = i; else break;
        }
        if (x < row[0]) bi = 0;
        if (bi > row.length - 2) bi = row.length - 2;
        return { si, bi };
      }
      return null;
    },
    [analysis],
  );

  const onScoreClick = useCallback(
    (ev: React.MouseEvent) => {
      const p = canvasCoords(ev.clientX, ev.clientY);
      if (!p) return;
      if (correctMode) {
        // 1) 点线: 精确选中该线; 2) 点面: 选中该小节左线; 3) 点空: 关闭
        // pie 锚点放在点击左上 45°(d=150), 不遮挡当前小节操作
        const pieAnchor = (cx: number, cy: number) => {
          const d = 150;
          return {
            x: Math.min(Math.max(128, cx - d), window.innerWidth - 128),
            y: Math.min(Math.max(140, cy - d), window.innerHeight - 140),
          };
        };
        const hit = findNearestBar(p.x, p.y);
        if (hit) {
          setSelectedBar({ si: hit.si, bi: hit.bi });
          setPie(pieAnchor(ev.clientX, ev.clientY));
          setStatus(`选中 p${pageNum} s${hit.si + 1} bar#${hit.bi + 1} x=${Math.round(analysis?.bars[hit.si]?.[hit.bi] ?? 0)} · 可拖动/ Delete 删除`);
          return;
        }
        const m = findMeasureAt(p.x, p.y);
        if (m) {
          setSelectedBar(m);
          setPie(pieAnchor(ev.clientX, ev.clientY));
          setStatus(`选中 p${pageNum} s${m.si + 1} 第${m.bi + 1}小节 · split 拆分 / merge 向左或右合并`);
          return;
        }
        setSelectedBar(null);
        setPie(null);
        return;
      }
      const hit = wijzerRef.current.x2time(p.x, p.y);
      if (!hit) return;
      placeCursor(hit.measure, hit.t);
      // 节拍器播放中: 同步把 metro 播放头跳过去(不停), 未播放时忽略
      window.dispatchEvent(new CustomEvent("synpdf:metro-jump", { detail: { measure: hit.measure + 1, onlyIfPlaying: true } }));
    },
    [analysis, canvasCoords, correctMode, findMeasureAt, findNearestBar, pageNum, placeCursor],
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
      setPie(null);
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

  // ---- 批注(原版 annots 语义): annot 模式下右键新建, 拖动移动, 单击编辑, 右键删除 ----
  const commitAnnots = useCallback((next: Annot[]) => {
    const all = { ...annotsRef.current, [pageNum]: next };
    annotsRef.current = all;
    setAnnotsByPage(all);
  }, [pageNum]);

  const onNotationContextMenu = useCallback((ev: React.MouseEvent) => {
    if (opt.annot !== 1 || !analysis) return;
    ev.preventDefault();
    const p = canvasCoords(ev.clientX, ev.clientY);
    if (!p) return;
    const cur = annotsRef.current[pageNum] ?? [];
    commitAnnots([...cur, {
      x: Math.round(p.x), y: Math.round(p.y) - 10,
      w: analysis.pageW, c: 1 * opt.cropx, t: "click to edit this text", d: 0,
    }]);
    setStatus(`批注 p${pageNum} #${cur.length + 1} 已新建`);
  }, [analysis, canvasCoords, commitAnnots, pageNum]);

  const onAnnotPointerDown = useCallback((idx: number) => (ev: React.PointerEvent) => {
    if (opt.annot !== 1) return;
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const cur = annotsRef.current[pageNum] ?? [];
    const a = cur[idx];
    if (!a) return;
    annotDragRef.current = { idx, startX: ev.clientX, startY: ev.clientY, origX: a.x, origY: a.y, moved: false };
  }, [pageNum]);

  const onAnnotPointerMove = useCallback((ev: React.PointerEvent) => {
    const drag = annotDragRef.current;
    if (!drag || !analysis) return;
    ev.stopPropagation();
    const rect = notationRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = analysis.pageW / rect.width;
    const sy = analysis.pageH / rect.height;
    const nx = Math.round(drag.origX + (ev.clientX - drag.startX) * sx);
    const ny = Math.round(drag.origY + (ev.clientY - drag.startY) * sy);
    if (Math.abs(ev.clientX - drag.startX) + Math.abs(ev.clientY - drag.startY) > 4) drag.moved = true;
    const cur = (annotsRef.current[pageNum] ?? []).slice();
    if (!cur[drag.idx]) return;
    cur[drag.idx] = { ...cur[drag.idx], x: nx, y: ny };
    const all = { ...annotsRef.current, [pageNum]: cur };
    annotsRef.current = all;
    setAnnotsByPage(all);
  }, [analysis, pageNum]);

  const onAnnotPointerUp = useCallback((idx: number) => (ev: React.PointerEvent) => {
    const drag = annotDragRef.current;
    annotDragRef.current = null;
    if (!drag || drag.moved) return;
    ev.stopPropagation();
    const cur = (annotsRef.current[pageNum] ?? []).slice();
    const a = cur[idx];
    if (!a) return;
    const v = window.prompt("Edit the annotation", a.t);
    if (v == null) return;
    cur[idx] = { ...a, t: v.length ? v : "right click on annotation deletes!" };
    const all = { ...annotsRef.current, [pageNum]: cur };
    annotsRef.current = all;
    setAnnotsByPage(all);
    setStatus(`批注 p${pageNum} #${idx + 1} 已更新`);
  }, [pageNum]);

  const onAnnotContextMenu = useCallback((idx: number) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!window.confirm("Do you really want to delete this annotation?")) return;
    const cur = (annotsRef.current[pageNum] ?? []).slice();
    cur.splice(idx, 1);
    commitAnnots(cur);
    setStatus(`批注 p${pageNum} #${idx + 1} 已删除`);
  }, [commitAnnots, pageNum]);

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
      curMixRef.current = c.measure;
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

  // 二进制转原版 pdf_data 分块 base64(["...",\n"..."])
  const bin2txt = useCallback((buf: ArrayBuffer): string => {
    const u = new Uint8Array(buf);
    let s = "";
    const CH = 32768;
    for (let i = 0; i < u.length; i += CH) {
      s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + CH)));
    }
    const b64 = btoa(s);
    const parts: string[] = [];
    for (let i = 0; i < b64.length; i += 150) parts.push(b64.substr(i, 150));
    return '["' + parts.join('",\n"') + '"]';
  }, []);

  // preload.js 导出(原版 synpdf.html 兼容: 全页 metric + pdf_data + 全局 timing + 逐页 adv)
  const savePreload = useCallback(async () => {
    const pdf = pdfDocRef.current;
    if (!pdf || !numPages) { setStatus("先载入谱面再保存 preload"); return; }
    const w = wijzerRef.current;
    // 全页分析(缺失页后台补算, 人工校正优先)
    const off = document.createElement("canvas");
    for (let n = 1; n <= numPages; n++) {
      if (!autoRef.current[n]) {
        setStatus(`saving preload: 分析 p${n}/${numPages} ...`);
        await renderAndAnalyze(pdf, n, off);
      }
    }
    const metric = buildMetricArr() as unknown[];
    const numKeys = ["drmpl", "drmpl2", "skipn", "seln", "eerst", "sysprf", "onestf",
      "zwgrens", "voorna", "mtdrmpl", "dx", "fixwd"] as const;
    const adv: Record<string, Record<string, number>> = {};
    for (let n = 1; n <= numPages; n++) {
      const row: Record<string, number> = {};
      for (const k of numKeys) row[k] = 1 * ((opt as unknown as Record<string, number>)[k] ?? 0);
      adv[String(n)] = row;
    }
    const optSnap: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(opt)) {
      if (typeof v === "number" || typeof v === "string") optSnap[k] = v;
    }
    const base = (pdfName || "score").replace(/\.pdf$/i, "");
    const L: string[] = [];
    L.push("//########################################");
    L.push("//# This page contains score data, timing data and the media file path. Save it as a javascipt file in");
    L.push("//# the same folder as synpdf.html. Synpdf preloads score and media when it is opened with the");
    L.push("//# file name as parameter in the url, for example: http://your.domain.org/synpdf.html?file_name.js");
    L.push("//# Also works locally with file:///path/to/synpdf.html?file_name.js");
    L.push(`//# **** exported by scorefollow algo v${ALGO_VERSION} · ${numPages} pages metric + pdf_data + timing ****`);
    L.push("//########################################");
    L.push(`pdf_file = ${JSON.stringify(base + ".pdf")};`);
    if (pdfBytesRef.current && (opt as unknown as Record<string, number>).wpdf !== 0) {
      L.push(`pdf_data = ${bin2txt(pdfBytesRef.current)};`);
    }
    L.push(`media_file = "";`);
    L.push(`msc_tracks = "";`);
    L.push(`offset_js = 0.00;`);
    L.push(`opt = ${JSON.stringify(optSnap)};`);
    const annotAll: { x: number; y: number; w: number; c: number; t: string; d: number; p?: number }[] = [];
    for (const [pn, arr] of Object.entries(annotsRef.current)) {
      for (const a of arr) annotAll.push({ x: a.x, y: a.y, w: a.w, c: a.c, t: a.t, d: 0, p: Number(pn) });
    }
    // 节拍器嵌入: loader 藏进 annot(原版 eval 即自启动, 与 Smart-Metro/metro-engine.js 同机制)
    const isEngineAnnot = (t: string) =>
      t.includes("__sgaBoot") || t.includes("metro-engine.js") || t.includes("sga_config");
    if (embedMetro) {
      const engineURL = window.location.origin + `${BASE}/metro-engine.js`;
      const loader = '<scr' + 'ipt>window.sga_config={};(function(){if(window.__sgaBoot)return;window.__sgaBoot=1;' +
        'var s=document.createElement("script");s.src="' + engineURL + '";s.async=true;' +
        '(document.head||document.documentElement).appendChild(s);})();</scr' + 'ipt>';
      const pageW = Number(metric[0]) || 1000;
      const ei = annotAll.findIndex((a) => isEngineAnnot(a.t) || a.t === "");
      const eng = { x: Math.round(pageW * 0.38), y: 100, w: pageW, c: 0, t: loader, d: 0 };
      if (ei >= 0) annotAll[ei] = eng;
      else annotAll.push(eng);
    }
    if (annotAll.length) L.push(`annots = ${JSON.stringify(annotAll)};`);
    L.push(`times_arr = ${JSON.stringify(w.times.map((e) => ({ t: 1 * e.t, mix: 1 * e.mix })))};`);
    L.push(`metric_arr = ${JSON.stringify(metric)};`);
    L.push(`adv_settings = ${JSON.stringify(adv)};`);
    const blob = new Blob([L.join("\n") + "\n"], { type: "text/javascript" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = base + ".js";
    a.click();
    if (pdfDocRef.current) await renderPage(pdfDocRef.current, pageNum);
    setStatus(`saved preload ${base}.js · ${numPages} pages · ${w.times.length} sync points` +
      (pdfBytesRef.current ? " · 含PDF" : " · 无PDF(直接打开的?demo)"));
  }, [analysis, numPages, pageNum, pdfName, renderAndAnalyze, bin2txt, embedMetro, buildMetricArr]);

  // preload.js 载入(原版兼容): pdf_data 内嵌PDF + 全页 metric 配对 + times + 逐页 adv
  const loadPreload = useCallback(async (f: File) => {
    const txt = await f.text();
    if (!txt.includes("//# This page")) { setStatus("not a preload file(缺 //# This page 标记)"); return; }
    const matchBalanced = (open: string, close: string, from: number): string | null => {
      let depth = 0; let instr = false; let start = -1;
      for (let k = from; k < txt.length; k++) {
        const ch = txt[k];
        if (instr) { if (ch === '"') instr = false; continue; }
        if (ch === '"') { instr = true; continue; }
        if (ch === open) { if (depth === 0) start = k; depth++; continue; }
        if (ch === close) {
          depth--;
          if (depth === 0 && start >= 0) return txt.slice(start, k + 1);
        }
      }
      return null;
    };
    const getArr = (name: string): unknown | null => {
      const i = txt.indexOf(name + " = ");
      if (i < 0) return null;
      const s = matchBalanced("[", "]", txt.indexOf("[", i));
      if (!s) return null;
      try { return JSON.parse(s); } catch { return null; }
    };
    const getObj = (name: string): Record<string, unknown> | null => {
      const i = txt.indexOf(name + " = ");
      if (i < 0) return null;
      const s = matchBalanced("{", "}", txt.indexOf("{", i));
      if (!s) return null;
      try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
    };
    const getStr = (name: string): string => {
      const m = txt.match(new RegExp(name + ' = "([^"]*)";'));
      return m ? m[1] : "";
    };
    // 1) PDF(内嵌优先, 否则按 pdf_file 名提示)
    let pdfBytes: ArrayBuffer | null = null;
    const pdfData = getArr("pdf_data");
    if (Array.isArray(pdfData)) {
      const b64 = (pdfData as string[]).join("");
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      pdfBytes = u.buffer;
    }
    if (!pdfBytes) {
      const want = getStr("pdf_file");
      setStatus(`preload 无内嵌PDF${want ? `, 请先载入 ${want}` : ""} 后再导入(只恢复 timing/小节线)`);
    }
    // 2) metric / times / opt / adv 解析
    const metric = getArr("metric_arr");
    const times = getArr("times_arr");
    const advAll = getObj("adv_settings");
    const optAll = getObj("opt");
    const applyNums = (o: Record<string, unknown> | null) => {
      if (!o) return;
      for (const [k, val] of Object.entries(o)) {
        const num = 1 * (val as number);
        if (!Number.isFinite(num)) continue;
        if (k === "skipn") { setSkipn(num); opt.skipn = num; }
        else if (k === "sysprf") setSysprf(num);
        else (opt as unknown as Record<string, number>)[k] = num;
      }
    };
    applyNums(optAll);
    clearPageCache();
    autoRef.current = {};
    annotsRef.current = {};
    setAnnotsByPage({});
    undoRef.current = [];
    redoRef.current = [];
    setSelectedBar(null);
    // 3) 载入 PDF
    const pdfjs: any = await import("pdfjs-dist");
    let pdf = pdfDocRef.current;
    if (pdfBytes) {
      pdfBytesRef.current = pdfBytes.slice(0);
      pdf = await pdfjs.getDocument({ data: pdfBytes, wasmUrl: `${BASE}/wasm/` }).promise;
      pdfDocRef.current = pdf;
      const want = getStr("pdf_file");
      pdfNameRef.current = want || f.name.replace(/\.js$/i, ".pdf");
      setPdfName(pdfNameRef.current);
      setNumPages(pdf.numPages);
    } else if (!pdf) { setStatus("无PDF可载入"); return; }
    // 4) 逐页分析(逐页 adv 生效) + metric 配对为人工校正
    const metricPages: unknown[] = Array.isArray(metric) ? (metric as unknown[]) : [];
    const metricWd = Number(metricPages[0]) || 0;
    const off = document.createElement("canvas");
    const nextManual: Record<number, number[][]> = {};
    for (let n = 1; n <= (pdf.numPages as number); n++) {
      const advN = (advAll?.[String(n)] ?? advAll?.[n]) as Record<string, unknown> | undefined;
      if (advN) { applyNums(advN); clearPageCache(); }
      setStatus(`loading preload: 分析 p${n}/${pdf.numPages} ...`);
      const { a } = await renderAndAnalyze(pdf, n, off);
      if (!a) continue;
      const mp = metricPages[n] as { cxs?: { cs: number[] }[]; bxs?: number[][] } | undefined;
      if (!mp || !Array.isArray(mp.bxs) || !metricWd) continue;
      const k = a.pageW / metricWd;
      // 系统按 y 交叠配对(>0.5), 配对成功行采用载入小节线
      const used = new Set<number>();
      const rows: number[][] = a.bars.map((r) => r.slice());
      (mp.cxs ?? []).forEach((g, gi) => {
        if (!g || !Array.isArray(g.cs) || !g.cs.length) return;
        const g1 = g.cs[0] * k; const g2 = g.cs[g.cs.length - 1] * k;
        let best = -1; let bestOv = 0;
        a.systems.forEach((o, oi) => {
          if (used.has(oi)) return;
          const o1 = o.cs[0]; const o2 = o.cs[o.cs.length - 1];
          const ov = Math.max(0, Math.min(g2, o2) - Math.max(g1, o1)) / Math.max(1, g2 - g1);
          if (ov > bestOv) { bestOv = ov; best = oi; }
        });
        if (best < 0 || bestOv <= 0.5) return;
        used.add(best);
        const want = (mp.bxs ?? [])[gi];
        if (Array.isArray(want)) rows[best] = want.map((x) => Math.round(1 * x * k * 100) / 100);
      });
      nextManual[n] = rows;
    }
    manualRef.current = nextManual;
    setManualBarsByPage(nextManual);
    const annotArr = getArr("annots");
    if (Array.isArray(annotArr)) {
      const grouped: Record<number, Annot[]> = {};
      for (const a of annotArr as { x?: number; y?: number; w?: number; c?: number; t?: string; d?: number; p?: number }[]) {
        if (!a || typeof a.x !== "number" || typeof a.y !== "number") continue;
        if (1 * (a.d ?? 0) !== 0) continue;
        const pn = Math.max(1, Math.floor(1 * (a.p ?? 1)) || 1);
        (grouped[pn] ??= []).push({
          x: Math.round(1 * a.x), y: Math.round(1 * a.y),
          w: Math.round(1 * (a.w ?? 0)) || 0, c: Math.round(1 * (a.c ?? 0)) || 0,
          t: String(a.t ?? ""), d: 0, p: pn,
        });
      }
      annotsRef.current = grouped;
      setAnnotsByPage(grouped);
    }
    if (Array.isArray(times)) {
      wijzerRef.current.loadTimes(times as { t: number; mix: number }[]);
      setTapCount(wijzerRef.current.times.length);
    }
    forceAdv((n) => n + 1);
    pageNumRef.current = 1;
    setPageNum(1);
    await renderPage(pdf, 1);
    const adopted = Object.keys(nextManual).length;
    setStatus(`loaded preload ${f.name} · ${adopted} 页小节线已采用 · ${wijzerRef.current.times.length} sync points` +
      (pdfBytes ? " · PDF内嵌" : ""));
  }, [renderPage]);

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
      if (e.key.toLowerCase() === "t") { e.preventDefault(); setChromeOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "f") { e.preventDefault(); setMenuOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "h") { e.preventDefault(); setHelpOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "l") { e.preventDefault(); applyAdv("lncsr", opt.lncsr === 1 ? 0 : 1); return; }
      if (e.key.toLowerCase() === "m") { e.preventDefault(); setAdvOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "v") { e.preventDefault(); toggleCleanView(); return; }
      if (e.key === "Escape") { setHelpOpen(false); setMenuOpen(false); setAdvOpen(false); setPie(null); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
      if (e.key.toLowerCase() === "c") { e.preventDefault(); if (correctMode) { setSelectedBar(null); setPie(null); } setCorrectMode(!correctMode); return; }
      if (correctMode && (e.key === "Delete" || e.key === "Del" || e.key === "Backspace")) { e.preventDefault(); deleteSelectedBar(); setPie(null); return; }
      if (correctMode && selectedBar && (e.key === "s" || e.key === "S")) { e.preventDefault(); splitSelectedMeasure(); return; }
      if (correctMode && selectedBar && (e.key === "a" || e.key === "A")) { e.preventDefault(); mergeSelectedMeasure("left"); return; }
      if (correctMode && selectedBar && (e.key === "d" || e.key === "D")) { e.preventDefault(); mergeSelectedMeasure("right"); return; }
      if (e.key === " ") { e.preventDefault(); playing ? doPause() : doPlay(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const w = wijzerRef.current;
        if (w.times.length) {
          const t = w.goMsre(dir, now());
          let mix = curMixRef.current;
          for (let i = w.times.length - 1; i >= 0; i--) {
            if (!(w.times[i].t > t + 1e-6)) { mix = w.times[i].mix; break; }
          }
          placeCursor(mix, t);
        } else {
          placeCursor(curMixRef.current + dir);
        }
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        stepSystem(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const n = Math.min(Math.max(1, pageNum + (e.key === "PageDown" ? 1 : -1)), numPages || 1);
        pageNumRef.current = n;
        setPageNum(n);
        const off = pageOffsetsRef.current.find((o) => o.page === n);
        const notn = notationRef.current;
        const stack = stackRef.current;
        if (off && notn && stack && analysis) {
          const scale = stack.clientWidth / Math.max(1, analysis.pageW);
          notn.scrollTop = off.y * scale;
        }
      } else if (e.key === "+" || e.key === "=") setSpeed((s) => Math.min(2, Math.round((s + 0.05) * 100) / 100));
      else if (e.key === "-") setSpeed((s) => Math.max(0.5, Math.round((s - 0.05) * 100) / 100));
      else if (synbox && (e.key === "b" || e.key === "B")) { e.preventDefault(); doTap(); }
      else if (synbox && e.key === "Backspace") { e.preventDefault(); backupOne(); }
      else if (synbox && e.key === ",") adjustLast(e.ctrlKey ? -0.1 : -0.05);
      else if (synbox && e.key === ".") adjustLast(e.ctrlKey ? 0.1 : 0.05);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    }, [playing, doPlay, doPause, now, mediaURL, synbox, doTap, backupOne, adjustLast, correctMode, deleteSelectedBar, doUndo, doRedo, placeCursor, stepSystem, pageNum, numPages, renderPage, applyAdv, toggleCleanView, selectedBar, splitSelectedMeasure, mergeSelectedMeasure]);

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
        const r = await fetch(`${BASE}/demo-score.pdf`);
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
    <main className={styles.page} data-fullscreen={fullScreen ? "true" : "false"} data-theme={darkTheme ? "dark" : "light"}>
      {!chromeOpen && <button className={styles.showui} onClick={() => setChromeOpen(true)} title="Show toolbar (T)">UI</button>}
      {chromeOpen && <header className={styles.topbar}>
        <span className={styles.tbLogo}><svg className={styles.tbLogoSvg} width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="13" width="3" height="8" rx="1.5" fill="#2563eb"><animate attributeName="height" values="8;3;8" dur="1.1s" repeatCount="indefinite" /><animate attributeName="y" values="13;18;13" dur="1.1s" repeatCount="indefinite" /></rect><rect x="7" y="9" width="3" height="12" rx="1.5" fill="#0ea5e9"><animate attributeName="height" values="12;5;12" dur="1.1s" begin="0.15s" repeatCount="indefinite" /><animate attributeName="y" values="9;16;9" dur="1.1s" begin="0.15s" repeatCount="indefinite" /></rect><rect x="12" y="5" width="3" height="16" rx="1.5" fill="#2563eb"><animate attributeName="height" values="16;7;16" dur="1.1s" begin="0.3s" repeatCount="indefinite" /><animate attributeName="y" values="5;14;5" dur="1.1s" begin="0.3s" repeatCount="indefinite" /></rect><rect x="17" y="10" width="3" height="11" rx="1.5" fill="#0ea5e9"><animate attributeName="height" values="11;4;11" dur="1.1s" begin="0.45s" repeatCount="indefinite" /><animate attributeName="y" values="10;17;10" dur="1.1s" begin="0.45s" repeatCount="indefinite" /></rect></svg>SMART-METRO</span>
        <button className={styles.tbPlay} onClick={() => playing ? doPause() : doPlay()}>{playing ? "❚❚ pause" : "▶ play"}</button>
        <button className={`${styles.tbBtn} ${pdfName ? styles.tbBtnOn : ""}`} onClick={() => pdfInputRef.current?.click()} title={pdfName || "载入 PDF 谱"}>📄 {pdfName ? (pdfName.length > 16 ? pdfName.slice(0, 14) + "…" : pdfName) : "谱"}</button>
        <button className={`${styles.tbBtn} ${mediaURL ? styles.tbBtnOn : ""}`} onClick={() => mediaInputRef.current?.click()} title={mediaName || "载入音频/视频"}>🎵 {mediaName ? (mediaName.length > 16 ? mediaName.slice(0, 14) + "…" : mediaName) : "媒体"}</button>
        <input ref={pdfInputRef} type="file" accept=".pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPdfFile(f); e.target.value = ""; }} />
        <input ref={mediaInputRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return;
          setMediaURL(URL.createObjectURL(f));
          setMediaName(f.name);
          setMediaKind(f.type.startsWith("video") ? "video" : "audio");
          e.target.value = "";
        }} />
        <span className={styles.tbSpacer} />
        <span className={styles.tbMenuWrap}>
          <button className={styles.tbBtn} onClick={() => setMenuOpen((v) => !v)} title="设置 (F)">⚙ 设置</button>
          {menuOpen && <div className={styles.tbMenu} role="menu" aria-label="设置">
            <div className={styles.tbMenuRow}>
              <span>page</span>
              <button className={styles.pagerBtn} onClick={() => {
                const n = Math.max(1, pageNum - 1);
                pageNumRef.current = n; setPageNum(n);
                const off = pageOffsetsRef.current.find((o) => o.page === n);
                if (off && notationRef.current && stackRef.current && analysis) {
                  notationRef.current.scrollTop = off.y * (stackRef.current.clientWidth / Math.max(1, analysis.pageW));
                }
              }} title="Previous page">‹</button>
              <input type="number" min={1} max={Math.max(1, numPages)} value={pageNum} onChange={(e) => {
                const n = Math.min(Math.max(1, Number(e.target.value) || 1), numPages || 1);
                pageNumRef.current = n;
                setPageNum(n);
                const off = pageOffsetsRef.current.find((o) => o.page === n);
                if (off && notationRef.current && stackRef.current && analysis) {
                  const scale = stackRef.current.clientWidth / Math.max(1, analysis.pageW);
                  notationRef.current.scrollTop = off.y * scale;
                }
              }} /> / {numPages}
              <button className={styles.pagerBtn} onClick={() => {
                const n = Math.min(Math.max(1, numPages || 1), pageNum + 1);
                pageNumRef.current = n; setPageNum(n);
                const off = pageOffsetsRef.current.find((o) => o.page === n);
                if (off && notationRef.current && stackRef.current && analysis) {
                  notationRef.current.scrollTop = off.y * (stackRef.current.clientWidth / Math.max(1, analysis.pageW));
                }
              }} title="Next page">›</button>
            </div>
            <div className={styles.tbMenuRow}>
              <span>speed</span>
              <input type="range" min={0.1} max={4} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} /> {speed.toFixed(2)}x
            </div>
            <div className={styles.tbMenuRow}>
              <label><input type="checkbox" checked={loopB > loopA} onChange={(e) => {
                if (e.target.checked) wijzerRef.current.setLoop(loopA || 0, loopB || Math.max(loopA + 4, 4));
                else wijzerRef.current.setLoop(0, 0);
              }} /> loop</label>
              <span>A–B</span>
              <input type="number" min={0} step={0.5} value={loopA} onChange={(e) => { const v = Number(e.target.value); setLoopA(v); wijzerRef.current.setLoop(v, loopB); }} style={{ width: 64 }} />
              –
              <input type="number" min={0} step={0.5} value={loopB} onChange={(e) => { const v = Number(e.target.value); setLoopB(v); wijzerRef.current.setLoop(loopA, v); }} style={{ width: 64 }} />
            </div>
            <div className={styles.tbMenuGrid}>
              <button className={styles.tbBtn} onClick={doCountIn}>count-in</button>
              <button className={styles.tbBtn} onClick={doTap}>sync {tapCount > 0 ? `(${tapCount})` : ""}</button>
              <button className={styles.tbBtn} onClick={() => setAdvOpen((v) => !v)} title="Toggle control panel (M)">panel</button>
              <button className={styles.tbBtn} onClick={() => { if (correctMode) { setSelectedBar(null); setPie(null); } setCorrectMode(!correctMode); }} title="Barline correction mode (C)">{correctMode ? "✓ correct" : "correct"}</button>
              <button className={styles.tbBtn} onClick={() => setHelpOpen((v) => !v)} title="Keyboard shortcuts and help">help</button>
              <button className={styles.tbBtn} onClick={toggleFullScreen} title="Toggle fullscreen">{fullScreen ? "exit full" : "full screen"}</button>
              <button className={styles.tbBtn} onClick={() => setDarkTheme((v) => !v)} title="Toggle light/dark theme">{darkTheme ? "light" : "dark"}</button>
              <button className={styles.tbBtn} onClick={() => { setMenuOpen(false); setChromeOpen(false); }} title="Hide toolbar (T)">hide UI</button>
            </div>
          </div>}
        </span>
      </header>}

      {/* 分析开关与存取已并入右侧 panel, 状态行见底部 statusbar */}

      {helpOpen && <section className={styles.advpanel} role="dialog" aria-label="help">
        <strong>Keyboard</strong>
        <div>←/→ next or previous measure · ↑/↓ next system · PageUp/PageDown page</div>
        <div>Space play/pause · B sync · Backspace backup · ,/. adjust duration</div>
        <div>F setting · H help · L line cursor · M menu · V clean view · Esc close</div>
        <div>C correction mode · S split · A merge left · D merge right (with selection)</div>
        <div>Annotation: enable annot, then long-click/shift-click to add; drag to move.</div>
      </section>}

      {/* pie 接管全部纠错操作, 顶部 correctbar 已移除 */}

      {chromeOpen && correctMode && pie && selectedBar && (
        <div className={styles.pie} style={{ left: pie.x, top: pie.y }} role="menu" aria-label="小节操作">
          <div className={styles.pieDisc} onClick={() => setPie(null)} />
          {([
            { label: "拆分", title: "split: 从中间拆开 (S)", ang: -90, fn: pieAction(splitSelectedMeasure, true) },
            { label: "右合▶", title: "merge right: 与右侧小联合并 (D)", ang: -45, fn: pieAction(() => mergeSelectedMeasure("right"), true) },
            { label: "删除", title: "delete: 删除选中线 (Delete)", ang: 0, fn: pieAction(deleteSelectedBar, false), tone: "danger" },
            { label: "重做", title: "redo", ang: 45, fn: pieAction(doRedo, false) },
            { label: "全页", title: "复制本页校正到全部页", ang: 90, fn: pieAction(copyCorrectionsToAll, false) },
            { label: "重置", title: "恢复自动识别", ang: 135, fn: pieAction(resetPageCorrections, false) },
            { label: "撤销", title: "undo", ang: 180, fn: pieAction(doUndo, false) },
            { label: "◀左合", title: "merge left: 与左侧小联合并 (A)", ang: -135, fn: pieAction(() => mergeSelectedMeasure("left"), true) },
          ] as { label: string; title: string; ang: number; fn: () => void; tone?: "danger" }[]).map((it) => {
            const r = 92;
            const dx = Math.round(r * Math.cos((it.ang * Math.PI) / 180));
            const dy = Math.round(r * Math.sin((it.ang * Math.PI) / 180));
            return (
              <button
                key={it.label}
                className={it.tone === "danger" ? `${styles.pieBtn} ${styles.pieBtnDanger}` : styles.pieBtn}
                title={it.title}
                style={{ transform: `translate(${dx}px, ${dy}px)` }}
                onClick={it.fn}
              >{it.label}</button>
            );
          })}
          <div className={styles.pieCenter}>
            <span>s{selectedBar.si + 1}·m{selectedBar.bi + 1}</span>
            <button onClick={() => setPie(null)} aria-label="关闭">×</button>
          </div>
        </div>
      )}

      {chromeOpen && advOpen && (
        <div className={styles.advpanel} role="dialog" aria-label="control panel">
          <div className={styles.pcardHead}><span>Barline Correction</span><button onClick={() => setAdvOpen(false)} aria-label="关闭面板">×</button></div>
          <div className={styles.pcard}>
            <div className={styles.pcardTitle}><span>View</span></div>
            <div className={styles.pillRow}>
              {([
                [showSystems, setShowSystems, "systems"],
                [showBars, setShowBars, "barlines"],
                [showCursor, setShowCursor, "cursor"],
                [showLowConf, setShowLowConf, "low-conf"],
              ] as [boolean, (v: boolean) => void, string][]).map(([v, set, label]) => (
                <label key={label} className={`${styles.pill} ${v ? styles.pillOn : ""}`}><input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {label}</label>
              ))}
              <label className={`${styles.pill} ${opt.lncsr === 1 ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.lncsr === 1} onChange={(e) => applyAdv("lncsr", e.target.checked ? 1 : 0)} /> line cursor</label>
              <label className={`${styles.pill} ${cleanView ? styles.pillOn : ""}`}><input type="checkbox" checked={cleanView} onChange={() => toggleCleanView()} /> clean (V)</label>
              <label className={`${styles.pill} ${correctMode ? styles.pillOn : ""}`}><input type="checkbox" checked={correctMode} onChange={(e) => { setCorrectMode(e.target.checked); setSelectedBar(null); setPie(null); }} /> correct</label>
            </div>
          </div>
          <div className={styles.pcard}>
            <div className={styles.pcardTitle}><span>Mode</span></div>
            <div className={styles.pillRow}>
              {(["fast", "balanced", "scan"] as AnalysisProfileName[]).map((name) => (
                <label key={name} className={`${styles.pill} ${profileName === name ? styles.pillOn : ""}`}><input type="radio" name="profile" checked={profileName === name} onChange={() => applyProfile(name)} /> {name}</label>
              ))}
            </div>
            <button className={styles.pfileBtn} onClick={resetAdvDefaults}>恢复默认值</button>
          </div>
          <div className={styles.pcard}>
            <div className={styles.pcardTitle}><span>Timing</span></div>
            {(["zwgrens", "drmpl", "drmpl2", "mtdrmpl", "voorna", "dx"] as const).map((k) => (
              <label key={`${k}-${advNonce}`} className={styles.stepper}>{k}
                <input
                  type="number" min={ADV_RANGES[k][0]} max={ADV_RANGES[k][1]} step={ADV_STEPS[k]}
                  defaultValue={opt[k] as number}
                  onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) applyAdv(k, v); }}
                  onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { applyAdv(k, v); e.target.value = String(opt[k] as number); } }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
              </label>
            ))}
          </div>
          <div className={styles.pcard}>
            <div className={styles.pcardTitle}><span>Bars</span></div>
            <div className={styles.pillRow}>
              <label className={`${styles.pill} ${opt.sysprf ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.sysprf ? true : false} onChange={(e) => applyAdv("sysprf", e.target.checked ? 1 : 0)} /> sysprf</label>
              <label className={`${styles.pill} ${opt.onestf ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.onestf ? true : false} onChange={(e) => applyAdv("onestf", e.target.checked ? 1 : 0)} /> onestf</label>
              <label className={`${styles.pill} ${opt.eerst ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.eerst ? true : false} onChange={(e) => applyAdv("eerst", e.target.checked ? 1 : 0)} /> eerst</label>
            </div>
            <label className={styles.stepper}>skipn <input type="number" min={0} max={5} value={opt.skipn} onChange={(e) => applyAdv("skipn", Number(e.target.value))} /></label>
            <label className={styles.stepper}>seln <input type="number" min={0} max={9} value={opt.seln} onChange={(e) => applyAdv("seln", Number(e.target.value))} /></label>
            <label className={styles.stepper}>cropx <input type="number" min={0} value={opt.cropx} onChange={(e) => applyAdv("cropx", Number(e.target.value))} /></label>
            <label className={`${styles.pill} ${opt.annot === 1 ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.annot === 1} onChange={(e) => applyAdv("annot", e.target.checked ? 1 : 0)} /> annot</label>
          </div>
          <div className={styles.pcard}>
            <div className={styles.pcardTitle}><span>File</span></div>
            <button className={styles.pfileBtn} onClick={saveTiming}>save timing</button>
            <button className={styles.pfileBtn} onClick={() => void savePreload()}>save preload.js</button>
            <label className={styles.pfileBtn}>load timing <input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadTiming(f); }} /></label>
            <label className={styles.pfileBtn}>load preload <input type="file" accept=".js" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadPreload(f); }} /></label>
            <div className={styles.pillRow}>
              <label className={`${styles.pill} ${synbox ? styles.pillOn : ""}`}><input type="checkbox" checked={synbox} onChange={(e) => setSynbox(e.target.checked)} /> enable sync</label>
              <label className={`${styles.pill} ${embedMetro ? styles.pillOn : ""}`}><input type="checkbox" checked={embedMetro} onChange={(e) => setEmbedMetro(e.target.checked)} /> +metro</label>
            </div>
          </div>
          <details className={styles.pcard}>
            <summary className={styles.pcardTitle}><span>Advanced</span><span>›</span></summary>
            <label className={styles.stepper}>pagewd <input type="number" min={600} max={3000} step={50} value={opt.pagewd} onChange={(e) => applyAdv("pagewd", Number(e.target.value) || 1000)} /></label>
            <label className={styles.stepper}>fixwd <input type="number" min={0} step={100} value={opt.fixwd} onChange={(e) => applyAdv("fixwd", Number(e.target.value) || 0)} /></label>
          </details>
        </div>
      )}

      <div className={styles.mainarea}>
      {mediaURL && mediaKind === "video" && (
        <video ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls style={{ maxHeight: 160, maxWidth: 280 }} onTimeUpdate={() => { if (playing) { const c = wijzerRef.current.time2x(now(), opt.lncsr === 1); if (c) { curMixRef.current = c.measure; setCursor({ x: c.x, y: c.y, w: c.w, h: c.h }); } } }} />
      )}
      {mediaURL && mediaKind === "audio" && (
        <audio ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls style={{ width: 280, height: 36, alignSelf: "flex-start" }} onTimeUpdate={() => { if (playing) { const c = wijzerRef.current.time2x(now(), opt.lncsr === 1); if (c) { curMixRef.current = c.measure; setCursor({ x: c.x, y: c.y, w: c.w, h: c.h }); } } }} />
      )}

      <div
        id="notation"
        ref={notationRef}
        className={styles.notation}
        onClick={onScoreClick}
        onDoubleClick={onScoreDoubleClick}
        onContextMenu={onNotationContextMenu}
        onPointerMove={onNotationPointerMove}
        onPointerUp={onNotationPointerUp}
      >
        <div ref={stackRef} style={{ position: "relative", width: "100%" }}>
        <div ref={pagesHostRef} />
        {analysis && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: correctMode ? "auto" : "none" }} viewBox={`0 0 ${analysis.pageW} ${analysis.pageH}`}>
            {showSystems && analysis.systems.flatMap((s, si) => {
              const low = (analysis.confidence[si] ?? 1) < 0.6;
              const y1 = s.cs[0];
              const y2 = s.cs[s.cs.length - 1];
              if (low && showLowConf) {
                return [(
                  <rect
                    key={`sys${si}`}
                    x={s.xs.x1} y={y1} width={s.xs.x2 - s.xs.x1} height={y2 - y1}
                    fill="rgba(255,180,0,0.14)"
                    stroke="rgba(200,140,0,0.8)"
                    strokeWidth={2}
                    strokeDasharray="8 4"
                  />
                )];
              }
              const row = analysis.bars[si] ?? [];
              const els = [];
              for (let bi = 0; bi < row.length - 1; bi++) {
                const sel = selectedBar?.si === si && selectedBar?.bi === bi;
                const alt = (bi + si) % 2 === 0;
                els.push(
                  <rect
                    key={`msr${si}-${bi}`}
                    x={row[bi]} y={y1} width={Math.max(1, row[bi + 1] - row[bi])} height={y2 - y1}
                    fill={sel ? "rgba(0,120,255,0.28)" : alt ? "rgba(0,160,60,0.18)" : "rgba(20,100,235,0.18)"}
                    stroke={sel ? "rgba(0,120,255,0.7)" : undefined}
                    strokeWidth={sel ? 1.5 : undefined}
                  />,
                );
              }
              els.push(
                <rect
                  key={`sys${si}`}
                  x={s.xs.x1} y={y1} width={s.xs.x2 - s.xs.x1} height={y2 - y1}
                  fill="none"
                  stroke="rgba(0,140,60,0.35)"
                  strokeWidth={1.5}
                />,
              );
              return els;
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
        {Object.entries(annotsByPage).flatMap(([pn, arr]) => arr.map((a, i) => {
          const off = pageOffsetsRef.current.find((o) => o.page === Number(pn));
          const yAbs = a.y + (off && a.y < off.h ? off.y : 0);
          if (a.t.includes("__sgaBoot") || a.t.includes("metro-engine.js") || a.t.includes("sga_config") || a.t.includes("<scr")) return null;
          return (
          <div
            key={`ant${pn}-${i}`}
            className="ant"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={onAnnotContextMenu(i)}
            onPointerDown={onAnnotPointerDown(i)}
            onPointerMove={onAnnotPointerMove}
            onPointerUp={onAnnotPointerUp(i)}
            style={{
              position: "absolute",
              left: `${(a.x / (a.w || analysis?.pageW || 1)) * 100}%`,
              top: `${(yAbs / (analysis?.pageH || 1)) * 100}%`,
              fontSize: 15, background: "none", userSelect: "none",
              cursor: opt.annot === 1 ? "move" : "default",
              color: "#06402b", whiteSpace: "nowrap",
            }}
          >{a.t}</div>
          );
        }))}
        </div>
      </div>
      </div>

      <div className={styles.statusbar}>
        <span className={styles.statusmsg}>{status}</span>{cursorInfo ? <span className={styles.cursormsg}> · {cursorInfo}</span> : null} · {analysis ? `${analysis.systems.length} systems · ${barsTotal} measures · spatium ${analysis.spatium.toFixed(1)}px · conf ${confRange} · ${analysis.elapsedMs}ms${lowConfSystems ? ` · ${lowConfSystems}低置信度` : ""}${isManual ? " · manual" : ""} · ${tapCount} taps` : "no analysis yet"}
        keys: space play · ←/→ bar · ↑/↓ system · PgUp/PgDn page · +/− speed{synbox ? " · B tap · ⌫ backup · ,/. adjust" : ""}{correctMode ? " · correct: click/drag · dbl-click add · Delete del · Ctrl+Z/Y" : ""}{opt.annot === 1 ? " · annot: right-click new · drag move · click edit · right-click del" : ""}
      </div>

    </main>
  );
}
