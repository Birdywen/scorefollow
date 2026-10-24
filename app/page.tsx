"use client";

/**
 * scorefollow — synpdf rev.194 Next.js 全量 TypeScript 移植 (Phase 2.1)
 * PDF 渲染(pdfjs-dist) + 像素级小节检测(lib) + 光标跟随(Wijzer)
 * + count-in / A-B 循环 / 变速 / TAP 建图 / advanced 识别参数面板
 * + 人工小节线校正层(manualBarsByPage) / 覆盖层开关 / timing 校验。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDevMode } from "./hooks/useDevMode";

// 静态部署 basePath（next.config.ts 保持同步；root 构建时由 NEXT_PUBLIC_SF_BASE="" 覆盖）
const BASE = process.env.NEXT_PUBLIC_SF_BASE ?? "/scorefollow";
// 分析跟随光标提前量(秒): 小节起点来自检波器事件，实测理想起音下
// pYIN 约晚 35ms、Basic Pitch 约晚 12ms，叠加约 1 帧渲染延迟；
// 分析数据跟随载入时整体提前，影子不再慢半拍。
// 只用于分析数据跟随(TAP/手动同步点/整态恢复不走这里)。
const FOLLOW_LEAD_SEC = 0.035;
// While media plays, the shade is drawn this far (wall-clock seconds) ahead of the playhead,
// so it lands on a bar as its first note sounds instead of visibly after it.
const PLAY_LEAD_SEC = 0.1;
import {
  analyzePage,
  clearPageCache,
  opt,
  setSkipn,
  setSysprf,
  setHomrGate,
  estimateSkewAngle,
  rotateCanvasInPlace,
  getPageCacheStats,
  applyAnalysisProfile,
  buildTimingPayload,
  validateTimingPayload,
  ALGO_VERSION,
  type AnalysisProfileName,
  type PageAnalysis,
  type HomrGateFile,
} from "@/lib/synpdf-core";
import { Wijzer, buildMeasures } from "@/lib/synpdf-wijzer";
import { barLoopWindow } from "@/lib/take-loop";
import VideoExportDialog, { type VideoExportSource } from "./VideoExportDialog";
import AccountDialog from "./AccountDialog";
import { me as fetchMe, type Me } from "../lib/account";
import { deleteCloudScore, fetchSnapshot, pullScoreBlob, pushScore, type CloudScore } from "../lib/cloud-sync";
import PerformancePanel from "./PerformancePanel";
import AnalysisHelp from "./AnalysisHelp";
import MetroDock from "./MetroDock";
import TunerPanel from "./TunerPanel";
import YouTubeStrip from "./YouTubeStrip";
import { YouTubeMedia, captureTabAudio, parseYouTube, recordPlayback, youTubeUrl } from "@/lib/youtube";
import {
  type Lang, STR, cloneBars, bufToB64, type PageCrop, cropCanvasRows, cropPageMargins,
  applyPageCrop, copyCanvas, releaseCanvas, pdfPageUsesLargeRaster,
  type AnalysisRasterEntry, type RenderCacheStats, scoreSkipFor,
  decodeScoreImage, preprocessPhoto, downscaleCanvas, photoCtx, PHOTO_DARK,
  autocropPhoto, deskewPhoto, normalizePhoto,
} from "./score-photo";
import styles from "./page.module.css";

const DEFAULT_ADV: Record<string, number> = {
  zwgrens: 0.7, drmpl: 0.4, drmpl2: 2, mtdrmpl: 0.85, voorna: 0.9, dx: 3,
  sysprf: 0, onestf: 0, eerst: 0, skipn: 0, seln: 0, cropx: 0,
  pagewd: 1000, fixwd: 1000, hd: 1, deskew: 0, homrgate: 1,
};
// stepper 合法范围(与原版 synpdf.html 输入框 min/max 一致)
const ADV_RANGES: Record<string, [number, number]> = {
  zwgrens: [0.3, 1.5], drmpl: [0.1, 1], drmpl2: [0.5, 5],
  mtdrmpl: [0.3, 1.2], voorna: [0.5, 1], dx: [1, 10],
};
const ADV_STEPS: Record<string, number> = {
  zwgrens: 0.05, drmpl: 0.05, drmpl2: 0.1, mtdrmpl: 0.05, voorna: 0.05, dx: 1,
};



/**
 * 按页独立的分析参数键(skipn 除外: 它是整谱级语义, 见 scoreSkipFor, 保持全局)。
 * 在某页调参只快照该页, 重分析时各页用自己的快照, 已调好的页不受后调参数影响。
 */
const PAGE_ADV_KEYS = ["drmpl", "drmpl2", "seln", "eerst", "sysprf", "onestf",
  "zwgrens", "voorna", "mtdrmpl", "dx", "fixwd"] as const;
const RENDER_ADV_KEYS = new Set([
  "drmpl", "drmpl2", "seln", "eerst", "sysprf", "onestf", "zwgrens", "voorna",
  "mtdrmpl", "dx", "skipn", "pagewd", "hd", "deskew", "notemask", "widrescue", "homrgate",
]);

export default function ScoreFollowPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const notationRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const pagesHostRef = useRef<HTMLDivElement>(null);
  const pageOffsetsRef = useRef<{ page: number; y: number; h: number; w: number }[]>([]);
  const scoreRevisionRef = useRef(0);
  const analysisRasterCacheRef = useRef(new Map<number, AnalysisRasterEntry>());
  const displayRasterCacheRef = useRef(new Map<number, HTMLCanvasElement>());
  const analysisRasterModeRef = useRef("");
  const displayRasterModeRef = useRef("");
  const renderCacheStatsRef = useRef<RenderCacheStats>({ analysisRasterHits: 0, analysisRasterMisses: 0, displayHits: 0, displayMisses: 0 });
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | YouTubeMedia | null>(null);
  const pdfDocRef = useRef<any>(null);
  const pdfNameRef = useRef("");
  const pageNumRef = useRef(1);
  const pdfBytesRef = useRef<ArrayBuffer | null>(null);
  const pageProxyRef = useRef<any>(null);
  const wijzerRef = useRef<Wijzer>(new Wijzer());
  const rafRef = useRef(0);
  const countInTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef({ t0: 0, base: 0, running: false });
  const autoRef = useRef<Record<number, PageAnalysis>>({});
  // 上报用底图(页号→分析画布 PNG dataURL, 新谱面时随 autoRef 清空)
  const pagePngRef = useRef<Record<number, string>>({});
  // HoMR 音符模板门数据(随谱面清空; preload homr_gate 行或门文件载入后生效)
  const homrGateRef = useRef<HomrGateFile | null>(null);
  const [homrGateInfo, setHomrGateInfo] = useState("");
  const manualRef = useRef<Record<number, number[][]>>({});
  // skipn 对齐三件套: 每页实际生效 skip / 切除前系统数 / 人工行当前对齐的几何.
  // 改 skipn 只从端部切除系统, 保留端的人工行按偏移对齐后继续生效, 不再整页回退自动值.
  const pageSkipRef = useRef<Record<number, number>>({});
  const pageFullRef = useRef<Record<number, number>>({});
  const manualAlignRef = useRef<Record<number, { skip: number; full: number }>>({});
  // deskew 备注(本轮渲染各页转正角度, 汇总进最终 status)
  const deskewNotesRef = useRef<string[]>([]);
  const maskHeadsRef = useRef(0);
  // 按页分析参数快照 {页: {键: 值}}: 调参只记当前页, 各页互不影响(见 PAGE_ADV_KEYS)
  const advsRef = useRef<Record<number, Record<string, number>>>({});
  type ManualSnap = { bars: Record<number, number[][]>; align: Record<number, { skip: number; full: number }>; meter?: Record<number, number>; barnum?: Record<number, number>; loopm?: { on: boolean; from: number; to: number } };
  const undoRef = useRef<ManualSnap[]>([]);
  const redoRef = useRef<ManualSnap[]>([]);
  const dragRef = useRef<{ si: number; bi: number; active: boolean }>({ si: -1, bi: -1, active: false });
  const curMixRef = useRef(0);
  // 批注(原版 annots): {x,y:画布像素, w:创建时页宽, c:cropx, t:文本, d:删除标记} + p:页(超集字段, 原版忽略)
  interface Annot { x: number; y: number; w: number; c: number; t: string; d: number; p?: number }
  const annotsRef = useRef<Record<number, Annot[]>>({});
  const [annotsByPage, setAnnotsByPage] = useState<Record<number, Annot[]>>({});
  const annotDragRef = useRef<{ idx: number; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);

  const [status, setStatus] = useState("scorefollow 就绪 — 载入 PDF 谱开始");
  // 谱面载入/识别的机器可测阶段: ready(空闲无谱) / loading(取文件) / recognizing(逐页分析) / ready-score(有谱可用) / error(失败).
  // 文案保持双语原文, 阶段只经 setScorePhase 显式切换, 调参/光标等常规 status 不改阶段。
  type ScorePhase = "ready" | "loading" | "recognizing" | "ready-score" | "error";
  const [scorePhase, setScorePhase] = useState<ScorePhase>("ready");
  const [cursorInfo, setCursorInfo] = useState("");
  const [advOpen, setAdvOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [advNonce, forceAdv] = useState(0);
  const [analysis, setAnalysis] = useState<PageAnalysis | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pdfName, setPdfName] = useState("");
  const [mediaURL, setMediaURL] = useState("");
  const [mediaKind, setMediaKind] = useState<"audio" | "video" | "youtube">("audio");
  const [ytOpen, setYtOpen] = useState(false);
  const [ytText, setYtText] = useState("");
  const [ytErr, setYtErr] = useState("");
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  // 节拍器走带状态(引擎 synpdf:metro-state 广播驱动; 无音频时主▶按钮即节拍器开关)
  const [metroPlaying, setMetroPlaying] = useState(false);
  const [metroAvail, setMetroAvail] = useState(false);
  const [loopA, setLoopA] = useState(0);
  const [loopB, setLoopB] = useState(0);
  // 谱面小节设置(React 自有, 推给引擎 + 进 undo + 进存档):
  // meterMap: 引擎小节号→拍数(弱起 1/4 即 beats=1); barNumMap: 引擎小节号→显示号; loopM: 练习区间(引擎小节号)
  const [meterMap, setMeterMap] = useState<Record<number, number>>({});
  const [barNumMap, setBarNumMap] = useState<Record<number, number>>({});
  const [loopM, setLoopM] = useState<{ on: boolean; from: number; to: number }>({ on: false, from: 1, to: 1 });
  const [loopMark, setLoopMark] = useState(false);
  // Bar loop of a followed take (0-based measure indexes); mark 1/2 = waiting for the start/end bar tap.
  const [takeLoop, setTakeLoop] = useState<{ on: boolean; from: number; to: number }>({ on: false, from: 0, to: 0 });
  const takeLoopRef = useRef(takeLoop);
  const followUrlRef = useRef("");
  const [takeLoopMark, setTakeLoopMark] = useState<0 | 1 | 2>(0);
  // The take being followed: scores and instrument for the video's cards, last bar end for its length.
  const [followMeta, setFollowMeta] = useState<{ name: string; scores?: [string, string][]; instrument?: string; endSec?: number } | null>(null);
  const [account, setAccount] = useState<Me>({ user: null, usage: null });
  const [accountOpen, setAccountOpen] = useState(false);
  useEffect(() => { void fetchMe(BASE).then(setAccount); }, []);
  const [videoOpen, setVideoOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [expertOpen, setExpertOpen] = useState(() => { try { return localStorage.getItem("sf-expert-open") === "1"; } catch { return false; } });
  // 调整模式(对标纠错模式): 点小节弹设置框(拍号/小节号/Loop), 与纠错互斥
  const [adjustMode, setAdjustMode] = useState(false);
  const [barPop, setBarPop] = useState<{ x: number; y: number; tapX: number; tapY: number; mL: number; mT: number; mR: number; mB: number } | null>(null);
  const barPopRef = useRef<HTMLDivElement>(null);
  // adjust 弹框避让布局：旧 anchor 按固定偏移 (cx-140, cy-60) 落点，无视弹框 min-width 250px / 约 420px 高
  // 的实际尺寸与被点小节位置，必盖住被点小节。新规则：layout effect 实测弹框盒后按 右→左→下→上 择侧，
  // 与小节盒保持 >=12px 间隙并夹紧视口；视口过小无法兼顾时保弹框全可见（允许重叠，可操作优先）。
  useLayoutEffect(() => {
    if (!barPop) return;
    const el = barPopRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const GAP = 12, EDGE = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const clampRange = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));
    const m = { left: barPop.mL, top: barPop.mT, right: barPop.mR, bottom: barPop.mB };
    const overlaps = (x: number, y: number) =>
      x < m.right + GAP && x + box.width > m.left - GAP && y < m.bottom + GAP && y + box.height > m.top - GAP;
    const fits = (x: number, y: number) => x >= EDGE && y >= EDGE && x + box.width <= vw - EDGE && y + box.height <= vh - EDGE;
    const cy = clampRange(barPop.tapY - box.height / 2, EDGE, vh - box.height - EDGE);
    const cx = clampRange(barPop.tapX - box.width / 2, EDGE, vw - box.width - EDGE);
    const cands = [
      { x: m.right + GAP, y: cy },
      { x: m.left - GAP - box.width, y: cy },
      { x: cx, y: m.bottom + GAP },
      { x: cx, y: m.top - GAP - box.height },
    ];
    for (const c of cands) {
      const x = clampRange(c.x, EDGE, vw - box.width - EDGE);
      const y = clampRange(c.y, EDGE, vh - box.height - EDGE);
      if (fits(x, y) && !overlaps(x, y)) {
        if (Math.abs(x - barPop.x) > 0.5 || Math.abs(y - barPop.y) > 0.5) setBarPop({ ...barPop, x, y });
        return;
      }
    }
    const fx = clampRange(barPop.x, EDGE, vw - box.width - EDGE);
    const fy = clampRange(barPop.y, EDGE, vh - box.height - EDGE);
    if (Math.abs(fx - barPop.x) > 0.5 || Math.abs(fy - barPop.y) > 0.5) setBarPop({ ...barPop, x: fx, y: fy });
  }, [barPop]);
  const meterMapRef = useRef<Record<number, number>>({});
  const barNumRef = useRef<Record<number, number>>({});
  const loopMRef = useRef<{ on: boolean; from: number; to: number }>({ on: false, from: 1, to: 1 });
  const autoFsRef = useRef(false);
  const autoFsCount = useRef(0);
  const syncMeterMap = useCallback((n: Record<number, number>) => { meterMapRef.current = n; setMeterMap(n); }, []);
  const syncBarNum = useCallback((n: Record<number, number>) => { barNumRef.current = n; setBarNumMap(n); }, []);
  const syncLoopM = useCallback((n: { on: boolean; from: number; to: number }) => { loopMRef.current = n; setLoopM(n); }, []);
  const snapExtras = useCallback(() => ({
    meter: { ...meterMapRef.current },
    barnum: { ...barNumRef.current },
    loopm: { ...loopMRef.current },
  }), []);
  const [tapCount, setTapCount] = useState(0);
  const [synbox, setSynbox] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // 覆盖层四开关: 系统框 / 小节线 / 光标 / 低置信度
  const [showSystems, setShowSystems] = useState(false);
  const [showBars, setShowBars] = useState(false);
  const [showCursor, setShowCursor] = useState(true);
  const [showLowConf, setShowLowConf] = useState(true);
  const [diagnosticMode, setDiagnosticMode] = useState(false);
  const dev = useDevMode();
  // 干净视图: 一键隐藏分析覆盖层(光标保留), 再按恢复
  const [cleanView, setCleanView] = useState(false);
  const cleanSavedRef = useRef<{ sys: boolean; bars: boolean; cur: boolean; low: boolean; lncsr: number } | null>(null);
  // 人工校正
  const [manualBarsByPage, setManualBarsByPage] = useState<Record<number, number[][]>>({});
  const [correctMode, setCorrectMode] = useState(false);
  const [selectedBar, setSelectedBar] = useState<{ si: number; bi: number } | null>(null);
  // pie 菜单锚点(视口坐标), 选中由 selectedBar 承载
  const [pie, setPie] = useState<{ x: number; y: number } | null>(null);
  // 纠错虚拟光标(无 hover 的触屏定位用, 分析坐标系)
  const [touchPos, setTouchPos] = useState<{ x: number; y: number } | null>(null);
  // 长按新增小节线(代替双击): 按下 550ms 不动即插入, 随后的一次 click 需吞掉
  const longPressRef = useRef<{ id: number; cx: number; cy: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClickRef = useRef(false);
  const [profileName, setProfileName] = useState<AnalysisProfileName>("balanced");
  const [embedMetro, setEmbedMetro] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
  const [darkTheme, setDarkTheme] = useState(false);
  const [themeReady, setThemeReady] = useState(false);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("sf-theme"); } catch { /* private browsing */ }
    setDarkTheme(saved === "dark" || (saved !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches));
    setThemeReady(true);
    const update = (event: Event) => setDarkTheme((event as CustomEvent).detail === "dark");
    window.addEventListener("sf-theme-change", update);
    return () => window.removeEventListener("sf-theme-change", update);
  }, []);
  useEffect(() => {
    if (!themeReady) return;
    const theme = darkTheme ? "dark" : "light";
    document.documentElement.style.colorScheme = theme;
    document.documentElement.dataset.sfTheme = theme;
    try { localStorage.setItem("sf-theme", theme); localStorage.setItem("sga_theme", theme); } catch { /* private browsing */ }
    const apply = () => {
      const control = (window as unknown as { __sgaMetroControl?: { setTheme?: (value: string) => void } }).__sgaMetroControl;
      control?.setTheme?.(theme);
    };
    apply();
    window.addEventListener("synpdf:metro-state", apply);
    return () => window.removeEventListener("synpdf:metro-state", apply);
  }, [darkTheme, themeReady]);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpDialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!helpOpen) return;
    const dialog = helpDialogRef.current;
    if (!dialog) return;
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    focusFirst();
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    const onTab = (event: KeyboardEvent) => {
      // Embedded tools also listen for shortcuts. Isolate modal key events
      // before they reach those listeners, preserving native summary/button keys.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        setHelpOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0], last = elements[elements.length - 1];
      if (!first || (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last ?? dialog : first ?? dialog).focus();
      }
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onTab, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onTab, true);
      document.body.style.overflow = previousOverflow;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [helpOpen]);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [preloadPreview, setPreloadPreview] = useState<{ head: string; truncated: boolean; lines: number; bytes: number } | null>(null);
  const preloadFullRef = useRef<string>("");
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewReturnRef = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);
  // 异常上报(全自动 debug 通道): 原识别 + 校正结果 + 原 PDF 打包, 浏览器直发 GitHub
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reportConfirmed, setReportConfirmed] = useState(false);
  const [reportNoChange, setReportNoChange] = useState(false);
  const [reportToken, setReportToken] = useState(() => {
    try { return localStorage.getItem("sf-report-token") ?? ""; } catch { return ""; }
  });
  const [reportRepo, setReportRepo] = useState(() => {
    try { return localStorage.getItem("sf-report-repo") ?? "Birdywen/scorefollow"; } catch { return "Birdywen/scorefollow"; }
  });
  const [reportBusy, setReportBusy] = useState(false);
  const [reportMsg, setReportMsg] = useState("");
  // 直传服务器(主通道, 无需 token): 地址默认随站发布, 密钥只存本机 localStorage
  const [reportEndpoint, setReportEndpoint] = useState(() => {
    try { return localStorage.getItem("sf-report-endpoint") ?? `${BASE}/sf-report-upload.php`; } catch { return `${BASE}/sf-report-upload.php`; }
  });
  const [reportSecret, setReportSecret] = useState(() => {
    try { return localStorage.getItem("sf-report-secret") ?? ""; } catch { return ""; }
  });
  // 公开谱库推送 Score/: 路径 + 状态(密钥复用直传服务器同一密钥)
  const [scoreBusy, setScoreBusy] = useState(false);
  const [scoreMsg, setScoreMsg] = useState("");
  const [scoreMsgTone, setScoreMsgTone] = useState<"" | "info" | "success" | "error">("");
  const [scorePath, setScorePath] = useState("");
  // buildPreloadText 在下方定义，bundle 构建经 ref 间接调用（避 TDZ）
  const buildPreloadTextRef = useRef<((useManual?: boolean, includePdf?: boolean) => Promise<string | null>) | null>(null);
  const [lang, setLang] = useState<Lang>("zh");
  useEffect(() => {
    // Match the exported HTML on the first render, then restore the preference.
    try { if (localStorage.getItem("sf-lang") === "en") setLang("en"); } catch { /* unavailable storage */ }
  }, []);
  const tx = (k: keyof typeof STR) => STR[k][lang];
  const toggleLang = useCallback(() => {
    setLang((v) => {
      const n: Lang = v === "zh" ? "en" : "zh";
      try { localStorage.setItem("sf-lang", n); } catch { /* ignore */ }
      return n;
    });
  }, []);
  const [chromeOpen, setChromeOpen] = useState(true);
  const [mediaName, setMediaName] = useState("");
  // YouTube as the media source (synpdf's yubvid): accepts a link or a bare 11-char id.
  const loadYouTube = useCallback((input: string): boolean => {
    const yt = parseYouTube(input);
    if (!yt) return false;
    setMediaURL(youTubeUrl(yt.id, yt.start));
    setMediaName(`youtube:${yt.id}`);
    setMediaKind("youtube");
    setStatus(`YouTube ${yt.id} 载入中 / loading…`);
    return true;
  }, []);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const camInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const preloadInputRef = useRef<HTMLInputElement>(null);
  // 相机连拍(应用内取景多页): 缩略图 URL(state 驱动) + 处理后 canvas(ref 持有)
  const [camOpen, setCamOpen] = useState(false);
  const [camShots, setCamShots] = useState<string[]>([]);
  const [camBusy, setCamBusy] = useState(false);
  const [camPaused, setCamPaused] = useState(false);
  const camStreamRef = useRef<MediaStream | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const camShotsRef = useRef<HTMLCanvasElement[]>([]);
  // 稳定 ref 回调: 内联箭头每次渲染都会 detach/attach, 导致视频闪烁重启甚至黑屏
  const attachCamVideo = useCallback((el: HTMLVideoElement | null) => {
    camVideoRef.current = el;
    const stream = camStreamRef.current;
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => { setCamPaused(true); });
    }
  }, []);

  const closePreview = useCallback(() => {
    setPreloadPreview(null);
    requestAnimationFrame(() => previewReturnRef.current?.focus());
  }, []);

  useEffect(() => {
    if (preloadPreview) previewCloseRef.current?.focus();
  }, [preloadPreview]);

  const toggleFullScreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { setStatus("fullscreen unavailable"); }
  }, []);
  // 自动全屏(计数制): 主播放/节拍器进入时+1, 退出时-1; 归零且是自动进入的才退, 用户手动全屏不碰
  const enterAutoFs = useCallback(() => {
    try {
      if (document.fullscreenElement) return;
      autoFsCount.current += 1;
      autoFsRef.current = true;
      const p = document.documentElement.requestFullscreen?.() as Promise<void> | undefined;
      if (p && typeof p.catch === "function") p.catch(() => {
        autoFsCount.current = Math.max(0, autoFsCount.current - 1);
        if (autoFsCount.current === 0) autoFsRef.current = false;
      });
    } catch {
      autoFsCount.current = Math.max(0, autoFsCount.current - 1);
      if (autoFsCount.current === 0) autoFsRef.current = false;
    }
  }, []);
  const exitAutoFs = useCallback(() => {
    try {
      if (!autoFsRef.current) return;
      autoFsCount.current -= 1;
      if (autoFsCount.current > 0) return;
      autoFsCount.current = 0;
      autoFsRef.current = false;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch { /* ignore */ }
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
  const renderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const advRenderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 全页 metric 原子构建(保存/桥接共用): [pageW, p1, p2, ...], 缺失页 null,
  // 人工校正优先(useManual=false 时纯自动, 供异常上报交修复前版本)
  const buildMetricArr = useCallback((useManual = true): unknown[] => {
    const first = autoRef.current[1];
    const pageW = first?.pageW ?? opt.pagewd ?? 1000;
    const out: unknown[] = [pageW];
    const nps = Math.max(0, ...Object.keys(autoRef.current).map(Number));
    for (let n = 1; n <= nps; n++) {
      const a = autoRef.current[n];
      if (!a) { out.push(null); continue; }
      const k = pageW / a.pageW;
      const bars = useManual ? pageBarsFor(n, a) : a.bars;
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

  // 渲染+分析单页。分析栅格固定为 pagewd，与 HD 完全解耦；PDF/图片预处理结果和
  // 当前显示模式的 canvas 分层缓存。后台导出只取分析层，不再生成整份 HD 底图。
  const renderAndAnalyze = useCallback(
    async (pdf: any, n: number, canvas: HTMLCanvasElement, docId?: string, skipOverride?: number, renderDisplay = true, expectedGen?: number) => {
      renderingRef.current = true;
      const skipUsed = skipOverride ?? scoreSkipFor(n, Number(pdf?.numPages) || 1, Math.round(Number(opt.skipn) || 0));
      const pageAdv = advsRef.current[n];
      try {
        let proxy: any = null;
        const imgDoc = (pdf as any)?.__sfImage as { images: { bmp: ImageBitmap; w: number; h: number }[] } | undefined;
        const anaW = Math.max(1, Math.round(opt.pagewd || 1000));
        const deskewEnabled = (opt.deskew ?? 0) !== 0;
        const hdEnabled = (opt.hd ?? 1) !== 0;
        const rasterMode = `${scoreRevisionRef.current}:${imgDoc ? "image" : "pdf"}:${anaW}:deskew${deskewEnabled ? 1 : 0}`;
        if (analysisRasterModeRef.current !== rasterMode) {
          for (const entry of analysisRasterCacheRef.current.values()) releaseCanvas(entry.canvas);
          analysisRasterCacheRef.current.clear();
          analysisRasterModeRef.current = rasterMode;
          pagePngRef.current = {};
        }
        const displayMode = `${rasterMode}:hd${hdEnabled ? 1 : 0}`;
        if (renderDisplay && displayRasterModeRef.current !== displayMode) {
          for (const cached of displayRasterCacheRef.current.values()) releaseCanvas(cached);
          displayRasterCacheRef.current.clear();
          displayRasterModeRef.current = displayMode;
        }

        let raster = analysisRasterCacheRef.current.get(n);
        let preparedHdCanvas: HTMLCanvasElement | null = null;
        if (raster) {
          renderCacheStatsRef.current.analysisRasterHits++;
        } else {
          renderCacheStatsRef.current.analysisRasterMisses++;
          let ac = document.createElement("canvas");
          if (imgDoc) {
            const im = imgDoc.images[n - 1];
            if (!im) { autoRef.current[n] = null as any; return { a: null, proxy, canvas }; }
            ac.width = anaW;
            ac.height = Math.max(1, Math.round((anaW * im.h) / Math.max(1, im.w)));
            const ctx = ac.getContext("2d", { willReadFrequently: true })!;
            ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, ac.width, ac.height);
            ctx.drawImage(im.bmp, 0, 0, ac.width, ac.height);
          } else {
            proxy = await pdf.getPage(n);
            const v0 = proxy.getViewport({ scale: 1 });
            const rasterPage = await pdfPageUsesLargeRaster(proxy);
            let ratio = rasterPage ? 1 : 2;
            const area = (anaW * ratio) * ((anaW * ratio * v0.height) / Math.max(1, v0.width));
            if (area > 14e6) ratio *= Math.sqrt(14e6 / area);
            const vp = proxy.getViewport({ scale: (anaW * ratio) / Math.max(1, v0.width) });
            const source = document.createElement("canvas");
            source.width = Math.max(1, Math.floor(vp.width));
            source.height = Math.max(1, Math.floor(vp.height));
            await proxy.render({ canvasContext: source.getContext("2d", { willReadFrequently: true })!, viewport: vp }).promise;
            let angle = 0;
            if (deskewEnabled) {
              angle = estimateSkewAngle(source);
              if (Math.abs(angle) <= 5 && angle !== 0) rotateCanvasInPlace(source, angle);
              else angle = 0;
            }
            const crop = cropPageMargins(source);
            if (rasterPage) {
              ac = source;
            } else {
              ac.width = anaW;
              ac.height = Math.max(1, Math.round((anaW * source.height) / Math.max(1, source.width)));
              ac.getContext("2d", { willReadFrequently: true })!.drawImage(source, 0, 0, ac.width, ac.height);
            }
            raster = { canvas: ac, angle, crop };
            if (!rasterPage) preparedHdCanvas = source;
          }
          if (imgDoc) {
            let angle = 0;
            if (deskewEnabled) {
              angle = estimateSkewAngle(ac);
              if (Math.abs(angle) <= 5 && angle !== 0) rotateCanvasInPlace(ac, angle);
              else angle = 0;
            }
            const crop = cropPageMargins(ac);
            raster = { canvas: ac, angle, crop };
          }
          if (!raster) throw new Error(`page ${n} raster unavailable`);
          // A newer render can supersede this one while PDF.js is awaiting. Never let the
          // completed old raster repopulate a cache that has already changed modes.
          if (analysisRasterModeRef.current === rasterMode) analysisRasterCacheRef.current.set(n, raster);
        }
        const anaCanvas = raster.canvas;
        if (raster.angle) deskewNotesRef.current.push(`p${n} ${raster.angle > 0 ? "+" : ""}${raster.angle.toFixed(1)}°`);

        let displayCanvas = canvas;
        if (renderDisplay) {
          const cached = displayRasterCacheRef.current.get(n);
          if (cached) {
            renderCacheStatsRef.current.displayHits++;
            if (canvas !== cached) releaseCanvas(canvas);
            displayCanvas = cached;
          } else {
            renderCacheStatsRef.current.displayMisses++;
            if (imgDoc || !hdEnabled) {
              copyCanvas(anaCanvas, displayCanvas);
            } else if (preparedHdCanvas) {
              releaseCanvas(displayCanvas);
              displayCanvas = preparedHdCanvas;
              preparedHdCanvas = null;
            } else {
              if (!proxy) proxy = await pdf.getPage(n);
              const v0 = proxy.getViewport({ scale: 1 });
              let ratio = 2;
              const area = (anaW * ratio) * ((anaW * ratio * v0.height) / Math.max(1, v0.width));
              if (area > 14e6) ratio *= Math.sqrt(14e6 / area);
              const vp = proxy.getViewport({ scale: (anaW * ratio) / Math.max(1, v0.width) });
              displayCanvas.width = Math.max(1, Math.floor(vp.width));
              displayCanvas.height = Math.max(1, Math.floor(vp.height));
              await proxy.render({ canvasContext: displayCanvas.getContext("2d")!, viewport: vp }).promise;
              if (raster.angle) rotateCanvasInPlace(displayCanvas, raster.angle);
              applyPageCrop(displayCanvas, raster.crop);
            }
            if (displayRasterModeRef.current === displayMode) displayRasterCacheRef.current.set(n, displayCanvas);
          }
        }
        if (preparedHdCanvas) releaseCanvas(preparedHdCanvas);

        // A replacement request may arrive while PDF.js is rendering. Its pixels can still
        // be reused, but it must not write analysis/metric state for the superseded score.
        if (expectedGen !== undefined && expectedGen !== renderGenRef.current) {
          return { a: null, proxy, canvas: displayCanvas };
        }

        // The legacy detector reads shared options. Apply per-page values only around its
        // synchronous call, never across PDF.js awaits where UI changes can interleave.
        const savedSkip = opt.skipn;
        const savedAdv: Record<string, number> = {};
        opt.skipn = skipUsed;
        if (pageAdv) {
          for (const k of PAGE_ADV_KEYS) {
            if (pageAdv[k] === undefined) continue;
            savedAdv[k] = (opt as unknown as Record<string, number>)[k];
            if (k === "sysprf") setSysprf(pageAdv[k]);
            else (opt as unknown as Record<string, number>)[k] = pageAdv[k];
          }
        }
        let a: PageAnalysis;
        try {
          const analysisDocId = `${scoreRevisionRef.current}:${docId ?? pdfNameRef.current}`;
          a = analyzePage(anaCanvas, n, pageAdv?.seln ?? opt.seln, analysisDocId);
        } finally {
          opt.skipn = savedSkip;
          if (pageAdv) {
            for (const k of PAGE_ADV_KEYS) {
              if (pageAdv[k] === undefined) continue;
              if (k === "sysprf") setSysprf(savedAdv[k]);
              else (opt as unknown as Record<string, number>)[k] = savedAdv[k];
            }
          }
        }
        if ((opt.notemask ?? 0) !== 0) maskHeadsRef.current += a.maskHeads;
        if (a.systems.length === 0) {
          autoRef.current[n] = null as any;
          return { a: null, proxy, canvas: displayCanvas };
        }
        autoRef.current[n] = a;
        // 上报用底图: 分析画布原样 PNG(去偏+裁边后的确定性像素, 调试与浏览器同帧)
        if (!pagePngRef.current[n]) try { pagePngRef.current[n] = anaCanvas.toDataURL("image/png"); } catch { /* ignore */ }
        // skipn 对齐用: 本页实际切除数 + 切除前系统数(非空页切除数恒等于 |skip|)
        pageSkipRef.current[n] = skipUsed;
        pageFullRef.current[n] = a.systems.length + Math.abs(skipUsed);
        return { a, proxy, canvas: displayCanvas };
      } finally {
        renderingRef.current = false;
      }
    },
    [],
  );

  // 单页人工/自动小节线对齐(merge/导出共用):
  // 人工行是在某套几何(skip 切除位置 + 切除前系统数)下校的; 只要切除前系统数一致,
  // 就按端部偏移对齐, 缺的行用自动值补 —— 改 skipn 不再整页丢校正.
  const pageBarsFor = (n: number, a: PageAnalysis): number[][] => {
    const manual = manualRef.current[n];
    if (!manual || !manual.length) return a.bars;
    const al = manualAlignRef.current[n];
    const sk = pageSkipRef.current[n] ?? 0;
    const full = pageFullRef.current[n] ?? a.systems.length;
    if (al && al.full === full) {
      const off = sk - al.skip;
      return a.bars.map((row, i) => {
        const j = i + off;
        return (j >= 0 && j < manual.length ? manual[j] : row).slice();
      });
    }
    if (manual.length === a.systems.length) return manual;
    return a.bars;
  };

  const mergeFromPages = useCallback((): PageAnalysis | null => {
    const first = pageOffsetsRef.current.map((off) => autoRef.current[off.page]).find(Boolean);
    if (!first) return null;
    const systems: PageAnalysis["systems"] = [];
    const bars: number[][] = [];
    const confidence: number[] = [];
    let totalH = 0;
    for (const off of pageOffsetsRef.current) {
      // 无系统的封面/文字页也占显示高度，不能因没有分析结果而省略。
      totalH = Math.max(totalH, off.y + off.h);
      const a = autoRef.current[off.page];
      if (!a) continue;
      // 人工校正行数与重分析后的系统数对不上(改过 skipn/阈值): 同一批检测结果就按端对齐,
      // 阈值动过(切除前系统数变了)才回退自动值; 校正数据保留, 几何恢复一致时自动重新生效
      const pageBars = pageBarsFor(off.page, a);
      a.systems.forEach((s, i) => {
        systems.push({ cs: s.cs.map((y) => y + off.y), xs: { x1: s.xs.x1, x2: s.xs.x2 } });
        bars.push((pageBars[i] ?? []).slice());
        confidence.push(a.confidence[i] ?? 1);
      });
    }
    return { ...first, systems, bars, confidence, pageH: totalH, pageNumber: 1, diagnostics: [] };
  }, []);

  // 原版 readPdfdoc: 所有页竖拼进 #notation, knip 用 y 偏移合成全局小节
  const renderAllPages = useCallback(
    async (pdf: any, docId: string | undefined, gen: number) => {
      const host = pagesHostRef.current;
      if (!pdf || !host) return;
      // 调参重渲染保持阅读位置: 记下滚动条, 画完恢复(否则每次调参都跳回开头)
      const scroller = notationRef.current;
      const savedTop = scroller ? scroller.scrollTop : 0;
      deskewNotesRef.current = [];
      maskHeadsRef.current = 0;
      renderCacheStatsRef.current = { analysisRasterHits: 0, analysisRasterMisses: 0, displayHits: 0, displayMisses: 0 };
      const analysisCacheBefore = getPageCacheStats();
      host.innerHTML = "";
      const offsets: { page: number; y: number; h: number; w: number }[] = [];
      let y = 0;
      const nPages = pdf.numPages as number;
      setNumPages(nPages);
      for (let n = 1; n <= nPages; n++) {
        if (gen !== renderGenRef.current) return; // 被更新一轮取代
        setScorePhase("recognizing");
        setStatus(`rendering page: ${n}/${nPages}`);
        let canvas = document.createElement("canvas");
        let pageAna: { pageW: number; pageH: number } | null = null;
        try {
          const rr = (await renderAndAnalyze(pdf, n, canvas, docId, undefined, true, gen)) as { a: { pageW: number; pageH: number } | null; canvas: HTMLCanvasElement };
          pageAna = rr ? rr.a : null;
          if (rr?.canvas) canvas = rr.canvas;
        } catch (err) {
          if (gen === renderGenRef.current) autoRef.current[n] = null as any;
          setStatus(`page ${n} analysis skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (gen !== renderGenRef.current) return; // 丢弃过期结果
        canvas.style.display = "block";
        canvas.style.width = "100%";
        canvas.dataset.page = String(n);
        // offsets 必须记分析坐标(HD 显示画布 backing 是 2 倍, 直接记 canvas.height
        // 会把 pageH/系统 y 全部放大 R 倍)。显示画布也必须按相同的页高排版:
        // 否则每页 backing 像素比例的取整误差累积后, 四个覆盖层都会错位。
        // 有分析结果用 a.pageH(精确); 空白页按显示画布纵横比折算。
        const anaW = opt.pagewd || 1000;
        const ah = pageAna && pageAna.pageH > 0 ? pageAna.pageH
          : Math.max(1, Math.round((anaW * canvas.height) / Math.max(1, canvas.width)));
        canvas.style.aspectRatio = `${anaW} / ${ah}`;
        host.appendChild(canvas);
        offsets.push({ page: n, y, h: ah, w: anaW });
        y += ah;
      }
      if (gen !== renderGenRef.current) return;
      // 整谱级 skipn walk-back: 首/末页是空白扫描页时, 切除落到真正有系统的页.
      // 切除不改变像素(只过滤系统), 离屏重算一页即可, offsets 无需重建.
      const gSkip = Math.round(Number(opt.skipn) || 0);
      if (gSkip !== 0) {
        const withSystems = offsets
          .map((o) => o.page)
          .filter((p) => (autoRef.current[p]?.systems?.length ?? 0) > 0);
        if (withSystems.length) {
          const target = gSkip > 0 ? Math.min(...withSystems) : Math.max(...withSystems);
          const ruled = gSkip > 0 ? 1 : nPages;
          if (target !== ruled) {
            const off = document.createElement("canvas");
            // ruled 页切完是空的: 用 skip=0 对照确认它是原本空白(扫描白页)才转移目标
            await renderAndAnalyze(pdf, ruled, off, docId, 0, false, gen);
            if (gen !== renderGenRef.current) return; // 被更新一轮取代
            if ((autoRef.current[ruled]?.systems?.length ?? 0) === 0) {
              await renderAndAnalyze(pdf, target, off, docId, gSkip, false, gen);
              if (gen !== renderGenRef.current) return;
            } else {
              // 被本次切空的内容页(如末页整个是 demo): 保持切除, 该页合并时跳过
              autoRef.current[ruled] = null as any;
            }
          }
        }
      }
      pageOffsetsRef.current = offsets;
      for (const [page, entry] of analysisRasterCacheRef.current) if (page > nPages) {
        releaseCanvas(entry.canvas); analysisRasterCacheRef.current.delete(page);
      }
      for (const [page, cached] of displayRasterCacheRef.current) if (page > nPages) {
        releaseCanvas(cached); displayRasterCacheRef.current.delete(page);
      }
      const merged = mergeFromPages();
      if (!merged) {
        // 整谱无系统(切多了或空白谱): 清掉旧分析, 不让旧小节线残留在新画布上
        setAnalysis(null);
        setCursor(null);
        setCursorInfo("");
        setSelectedBar(null);
        setPie(null);
        setScorePhase("error");
        setStatus(gSkip !== 0
          ? `skipn=${gSkip} 切掉了全部系统, 请调小绝对值后重试`
          : "未检测到谱表系统, 请检查谱面或调参后重试");
        return;
      }
      const savedTimes = wijzerRef.current.times.slice();
      wijzerRef.current.reset(merged);
      const { kept, dropped } = wijzerRef.current.retainTimes(savedTimes);
      wijzerRef.current.fillDummyTimes();
      setTapCount(wijzerRef.current.times.length);
      setAnalysis(merged);
      setSelectedBar(null);
      // 光标尽量留在原小节(调参不丢位置); 越界才回 m1
      const keepMix = curMixRef.current;
      const mk = wijzerRef.current.measures[keepMix] ?? wijzerRef.current.measures[0];
      if (mk) {
        curMixRef.current = wijzerRef.current.measures[keepMix] ? keepMix : 0;
        setCursor(opt.lncsr === 1
          ? { x: mk.x, y: mk.y, w: Math.max(2, mk.w * 0.06), h: mk.h }
          : { x: mk.x, y: mk.y, w: mk.w, h: mk.h });
        setCursorInfo(`m${curMixRef.current + 1}`);
      } else {
        setCursor(null);
        setCursorInfo("");
      }
      // 恢复调参前的阅读位置
      if (scroller && gen === renderGenRef.current) {
        try { scroller.scrollTop = savedTop; } catch { /* ignore */ }
      }
      const meas = merged.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0);
      const dk = deskewNotesRef.current;
      const mh = maskHeadsRef.current;
      const rc = renderCacheStatsRef.current;
      const analysisCacheAfter = getPageCacheStats();
      const analysisHits = analysisCacheAfter.hits - analysisCacheBefore.hits;
      const analysisMisses = analysisCacheAfter.misses - analysisCacheBefore.misses;
      setScorePhase("ready-score");
      setStatus(`score: ${nPages} pages, ${merged.systems.length} systems, ${meas} measures, spatium ${merged.spatium.toFixed(1)}px, algo v${merged.algoVersion}` +
        (dropped ? ` · timing截断 ${kept}保留/${dropped}越界` : "") +
        (dk.length ? ` · deskew ${dk.join(" ")}` : "") +
        (mh > 0 ? ` · notemask ${mh}heads` : "") +
        ` · cache raster ${rc.analysisRasterHits}/${rc.analysisRasterMisses} display ${rc.displayHits}/${rc.displayMisses} analysis ${analysisHits}/${analysisMisses}`);
      emitMetricRendered();
    },
    [describeAnalysis, emitMetricRendered, mergeFromPages, renderAndAnalyze],
  );

  const renderPage = useCallback(
    async (pdf: any, _n?: number, docId?: string) => {
      // Invalidate the active generation immediately, then wait for its current PDF page
      // to finish before touching the legacy module's shared option state.
      const gen = ++renderGenRef.current;
      const job = renderQueueRef.current
        .catch(() => undefined)
        .then(() => renderAllPages(pdf, docId, gen));
      renderQueueRef.current = job;
      await job;
    },
    [renderAllPages],
  );

  // advance 调参防抖: slider 拖动只在停手 350ms 后重渲染一次
  const scheduleAdvRender = useCallback(
    (pdf: any) => {
      // Stop the active generation now rather than after the debounce delay.
      renderGenRef.current++;
      if (advRenderTimer.current) clearTimeout(advRenderTimer.current);
      advRenderTimer.current = setTimeout(() => {
        advRenderTimer.current = null;
        if (pdfDocRef.current) void renderPage(pdf ?? pdfDocRef.current);
      }, 350);
    },
    [renderPage],
  );

  // metro 桥接(MEGA-METRO/metro-engine.js 契约): 当前页 metric + 渲染状态 + 重算事件
  useEffect(() => {
    (window as unknown as Record<string, unknown>).SynPDFRuntime = Object.assign(
      (window as unknown as Record<string, unknown>).SynPDFRuntime ?? {},
      {
        version: "scorefollow-v16",
        getMetricArr: () => JSON.parse(JSON.stringify(buildMetricArr())),
        getMeasureCount: () => wijzerRef.current.measures.length,
        isRendering: () => renderingRef.current,
        getRenderCacheStats: () => ({ ...renderCacheStatsRef.current, analysis: getPageCacheStats() }),
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
    s.src = `${BASE}/metro-engine.js?v=20261017-one-cursor`;
    s.async = true;
    s.dataset.sfMetro = "1";
    s.onload = () => emitMetricRendered();
    document.head.appendChild(s);
  }, [embedMetro, emitMetricRendered]);

  // 节拍器走带状态: 引擎 setPlayBtn 每次变状态都广播(含挂载时, 顺带宣告可用)
  useEffect(() => {
    const onState = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { playing?: boolean } | undefined;
      setMetroAvail(true);
      setMetroPlaying(!!d?.playing);
    };
    window.addEventListener("synpdf:metro-state", onState);
    // 引擎若已先挂载(事件错过), 直接读一次
    try {
      const mc = (window as unknown as Record<string, unknown>).__sgaMetroControl as
        { isPlaying?: () => boolean } | undefined;
      if (mc) { setMetroAvail(true); setMetroPlaying(!!mc.isPlaying?.()); }
    } catch { /* ignore */ }
    return () => window.removeEventListener("synpdf:metro-state", onState);
  }, []);
  // 节拍器播放同样自动全屏/停止恢复(与主播放同一套 autoFs 计数)
  useEffect(() => {
    if (metroPlaying) enterAutoFs();
    else exitAutoFs();
  }, [metroPlaying, enterAutoFs, exitAutoFs]);

  // 纠错模式标记供引擎点谱监听读取: 纠错点线条不碰播放头
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__sfCorrectMode = correctMode;
  }, [correctMode]);

  interface MetroControl {
    play: (fromM?: number) => boolean;
    stop: () => boolean;
    restartAtMeasure: (m: number) => void;
    isPlaying: () => boolean;
    applyConfig: (c: Record<string, unknown>) => void;
    resync?: () => void;
  }
  const metroControl = (): MetroControl | null => {
    try {
      return ((window as unknown as Record<string, unknown>).__sgaMetroControl ?? null) as MetroControl | null;
    } catch { return null; }
  };

  // __sfSpaceControl 已删除(全仓库无人调用): 空格语义收敛到主键盘处理器, 只控制节拍器。

  // 新谱面: 必须清掉上一份谱的全部状态(缓存/人工校正/timing/undo),
  // 否则同页同尺寸会命中旧缓存、旧小节线盖到新谱上。
  const clearScoreState = useCallback(() => {
    renderGenRef.current++;
    if (advRenderTimer.current) {
      clearTimeout(advRenderTimer.current);
      advRenderTimer.current = null;
    }
    clearPageCache();
    for (const entry of analysisRasterCacheRef.current.values()) releaseCanvas(entry.canvas);
    for (const canvas of displayRasterCacheRef.current.values()) releaseCanvas(canvas);
    analysisRasterCacheRef.current.clear();
    displayRasterCacheRef.current.clear();
    analysisRasterModeRef.current = "";
    displayRasterModeRef.current = "";
    scoreRevisionRef.current++;
    setAnalysis(null);
    setCursor(null);
    setTouchPos(null);
    pageOffsetsRef.current = [];
    autoRef.current = {};
    pagePngRef.current = {};
    advsRef.current = {};
    manualRef.current = {};
    setManualBarsByPage({});
    annotsRef.current = {};
    setAnnotsByPage({});
    undoRef.current = [];
    redoRef.current = [];
    wijzerRef.current.loadTimes([]);
    wijzerRef.current.setLoop(0, 0);
    takeLoopRef.current = { on: false, from: 0, to: 0 };
    setTakeLoop(takeLoopRef.current);
    setTakeLoopMark(0);
    setFollowMeta(null);
    setVideoOpen(false);
    setTapCount(0);
    setSelectedBar(null);
    setPie(null);
    setAdjustMode(false);
    setBarPop(null);
    syncMeterMap({});
    syncBarNum({});
    syncLoopM({ on: false, from: 1, to: 1 });
    setLoopMark(false);
    homrGateRef.current = null;
    setHomrGate(null);
    setHomrGateInfo("");
  }, []);
  // Signed in: keep a cloud copy of each opened PDF and list them under "My scores".
  const [cloudScores, setCloudScores] = useState<CloudScore[]>([]);
  const [cloudScoresOpen, setCloudScoresOpen] = useState(false);
  const scoreSyncedRef = useRef(new Set<string>());
  const refreshCloudScores = useCallback(async () => {
    if (!account.user) { setCloudScores([]); return; }
    try { setCloudScores((await fetchSnapshot(BASE)).scores.filter((s) => s.kind === "pdf")); } catch { /* offline: keep the old list */ }
  }, [account.user]);
  useEffect(() => { void refreshCloudScores(); }, [refreshCloudScores]);
  useEffect(() => {
    const bytes = pdfBytesRef.current;
    if (!account.user || !pdfName || !bytes || bytes.byteLength > 25_000_000) return;
    const key = `${account.user.id}:${pdfName}:${bytes.byteLength}`;
    if (scoreSyncedRef.current.has(key)) return;
    scoreSyncedRef.current.add(key);
    pushScore(BASE, { title: pdfName.replace(/\.pdf$/i, ""), kind: "pdf", blob: new Blob([bytes], { type: "application/pdf" }) })
      .then(refreshCloudScores).catch(() => scoreSyncedRef.current.delete(key));
  }, [account.user, pdfName, numPages, refreshCloudScores]);
  const onPdfFile = useCallback(
    async (f: File) => {
      setScorePhase("loading");
      setStatus(`loading ${f.name} ...`);
      setPerformanceOpen(false);
      try {
        const pdfjs: any = await import("pdfjs-dist");
        const buf = await f.arrayBuffer();
        pdfBytesRef.current = buf.slice(0);
        const pdf = await pdfjs.getDocument({ data: buf, wasmUrl: `${BASE}/wasm/` }).promise;
        pdfDocRef.current = pdf;
        clearScoreState();
        pdfNameRef.current = f.name;
        setPdfName(f.name);
        setNumPages(pdf.numPages);
        pageNumRef.current = 1;
        setPageNum(1);
        await renderPage(pdf, 1, f.name);
      } catch (err) {
        setScorePhase("error");
        setStatus(`载入失败 ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [renderPage, clearScoreState],
  );
  // 图片/相机谱: 每张图当一页(多选多页), 与 PDF 共用分析/合并/校正链路.
  // 图片无 pdf_data: preload 导出不含 PDF, OMR 仍需 PDF(面板会提示).
  // 图片谱载入: 当前已是图片谱则追加成多页(保留已有分析/校正, 页号不变, 旧页走缓存),
  // 否则新建图片谱. preprocess=false 跳过拍摄预处理(相机连拍已在拍摄时处理过).
  const MAX_IMAGE_PAGES = 24;
  const onImageFile = useCallback(
    async (files: FileList | File[], preprocess = true) => {
      const picked = [...files].filter((f) => f.type.startsWith("image/"));
      if (!picked.length) { setScorePhase("error"); setStatus("未选中图片文件"); return; }
      setPerformanceOpen(false);
      const cur = pdfDocRef.current;
      try {
        if (cur?.__sfImage) {
          const room = Math.max(0, MAX_IMAGE_PAGES - cur.images.length);
          const list = picked.slice(0, Math.max(room, 0));
          if (!list.length) { setScorePhase("error"); setStatus(`图片已达 ${MAX_IMAGE_PAGES} 页上限, 请先导出或新建`); return; }
          setScorePhase("loading");
          setStatus(`appending ${list.length} image(s) ...`);
          for (const f of list) cur.images.push({ ...(await decodeScoreImage(f as File, preprocess)), name: (f as File).name || `page-${cur.images.length + 1}` });
          cur.numPages = cur.images.length;
          setNumPages(cur.images.length);
          // pdfNameRef 是分析缓存 docId 的一部分: 追加时保持不变, 旧页命中缓存只算新页;
          // 显示名另加计数后缀
          const base = pdfNameRef.current;
          setPdfName(cur.images.length > 1 ? `${base} +${cur.images.length - 1}` : base);
          // 滚动位置由 renderAllPages 保持
          await renderPage(cur as any, pageNumRef.current, pdfNameRef.current);
          return;
        }
        const list = picked.slice(0, 12);
        setScorePhase("loading");
        setStatus(`loading ${list.length} image(s) ...`);
        const images = [];
        for (const f of list) images.push({ ...(await decodeScoreImage(f as File, preprocess)), name: (f as File).name });
        const doc = { __sfImage: true, numPages: images.length, images };
        pdfDocRef.current = doc;
        pdfBytesRef.current = null;
        clearScoreState();
        pdfNameRef.current = list[0].name;
        setPdfName(list.length > 1 ? `${list[0].name} +${list.length - 1}` : list[0].name);
        setNumPages(images.length);
        pageNumRef.current = 1;
        setPageNum(1);
        await renderPage(doc as any, 1, list[0].name);
      } catch (err) {
        setScorePhase("error");
        setStatus(`图片载入失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [renderPage, clearScoreState],
  );

  // ---- 相机连拍 ----
  const stopCamStream = useCallback(() => {
    camStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
    camStreamRef.current = null;
  }, []);

  const discardCamShots = useCallback(() => {
    camShotsRef.current = [];
    setCamShots((prev) => {
      for (const u of prev) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
      return [];
    });
  }, []);

  const openCamera = useCallback(async () => {
    // capture input 在桌面/部分浏览器直接退化成文件选择: 首选应用内取景, 失败才回退
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("无相机接口, 已回退文件选择");
      camInputRef.current?.click();
      return;
    }
    setCamOpen(true);
    setCamBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1280 } },
        audio: false,
      });
      camStreamRef.current = stream;
      const v = camVideoRef.current;
      if (v && v.srcObject !== stream) {
        (v as HTMLVideoElement).srcObject = stream;
        try { await v.play(); setCamPaused(false); } catch { setCamPaused(true); }
      }
    } catch {
      setCamOpen(false);
      setStatus("相机不可用, 已回退文件选择");
      camInputRef.current?.click();
    } finally {
      setCamBusy(false);
    }
  }, []);

  const closeCamera = useCallback(() => {
    stopCamStream();
    discardCamShots();
    setCamOpen(false);
  }, [stopCamStream, discardCamShots]);

  const takeShot = useCallback(() => {
    const v = camVideoRef.current;
    if (!v || v.readyState < 2 || !v.videoWidth) {
      setStatus(v && v.paused ? "点一下取景画面启动相机后再拍" : "取景未就绪, 稍候再拍");
      return;
    }
    if (camShotsRef.current.length >= MAX_IMAGE_PAGES) { setStatus(`连拍已达 ${MAX_IMAGE_PAGES} 张上限`); return; }
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    try { preprocessPhoto(c); } catch { /* 预处理失败就用原图, 不丢拍摄 */ }
    camShotsRef.current.push(c);
    setCamShots((prev) => [...prev, c.toDataURL("image/jpeg", 0.82)]);
    setStatus(`已拍 ${camShotsRef.current.length} 页 · 完成后按多页谱合并`);
  }, []);

  const removeShot = useCallback((i: number) => {
    const [cv] = camShotsRef.current.splice(i, 1);
    if (!cv) return;
    setCamShots((prev) => {
      const next = prev.slice();
      const [u] = next.splice(i, 1);
      if (u) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
      return next;
    });
  }, []);

  const finishShots = useCallback(async () => {
    const shots = camShotsRef.current.splice(0);
    const thumbs = camShots;
    setCamShots([]);
    setCamOpen(false);
    stopCamStream();
    if (!shots.length) return;
    try {
      const files: File[] = [];
      for (let i = 0; i < shots.length; i++) {
        const blob = await new Promise<Blob>((resolve, reject) => {
          shots[i].toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.92);
        });
        files.push(new File([blob], `camera-p${i + 1}.jpg`, { type: "image/jpeg" }));
      }
      await onImageFile(files, false); // 拍摄时已预处理, 合并时不再重复
    } catch (err) {
      setScorePhase("error");
      setStatus(`连拍合并失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const u of thumbs) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
    }
  }, [camShots, onImageFile, stopCamStream]);

  const applyAdv = useCallback(
    (k: string, v: number) => {
      if (!Number.isFinite(v)) return;
      // number 输入钳制到合法范围, 避免 typing 中间态污染识别
      const range = ADV_RANGES[k];
      if (range) v = Math.min(range[1], Math.max(range[0], v));
      if (k === "dx") v = Math.round(v);
      if (k === "skipn") v = Math.max(-5, Math.min(5, Math.round(v)));
      else if (k === "seln") v = Math.max(0, Math.min(9, Math.round(v)));
      if (k === "skipn") { setSkipn(v); opt.skipn = v; }
      else if (k === "sysprf") { setSysprf(v); }
      else (opt as unknown as Record<string, number>)[k] = v;
      // 按页快照: 在哪页调的就记在哪页(仅分析参数, skipn/lncsr 等显示项不记),
      // 重分析各页用自己的快照, 后调的参数不影响已调好的页
      const perPage = (PAGE_ADV_KEYS as readonly string[]).includes(k);
      const pg = pageNumRef.current;
      if (perPage && pg >= 1) {
        const row = { ...(advsRef.current[pg] ?? {}) };
        row[k] = v;
        advsRef.current[pg] = row;
      }
      forceAdv((n) => n + 1);
      const rerender = RENDER_ADV_KEYS.has(k);
      if (k === "lncsr") {
        const m = wijzerRef.current.measures[curMixRef.current];
        if (m) setCursor(v === 1 ? { x: m.x, y: m.y, w: Math.max(2, m.w * 0.06), h: m.h } : { x: m.x, y: m.y, w: m.w, h: m.h });
      }
      setStatus(`advanced: ${k}=${v}` + (perPage && pg >= 1 ? ` (p${pg} 已存本页)` : "") + (rerender ? " - reanalyzed" : " - updated"));
      if (rerender && pdfDocRef.current) scheduleAdvRender(pdfDocRef.current);
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

  // V: 干净视图开关 = 四覆盖层(Systems/Barlines/Cursor/Low confidence)的总闸.
  // 开=Systems/Barlines/Low confidence 全灭, Cursor 保持打开(跟随时要看到阴影), line cursor 改成小节阴影(不重分析);
  // 关=四开关全开, line cursor 恢复进干净前的值. 简单可预测, 不再恢复旧勾选.
  const toggleCorrectMode = () => { if (correctMode) { setSelectedBar(null); setPie(null); } else { setAdjustMode(false); setBarPop(null); } setCorrectMode(!correctMode); };
  const toggleAdjustMode = () => { if (adjustMode) { setSelectedBar(null); setBarPop(null); } else { setCorrectMode(false); setSelectedBar(null); setPie(null); setLoopMark(false); } setAdjustMode(!adjustMode); };
  const toggleCleanView = useCallback(() => {
    if (!cleanView) {
      cleanSavedRef.current = {
        sys: showSystems, bars: showBars, cur: showCursor, low: showLowConf,
        lncsr: (opt as unknown as Record<string, number>).lncsr ?? 1,
      };
      // The play cursor stays on: clean view hides the analysis outlines, not the follow shade.
      setShowSystems(false); setShowBars(false); setShowCursor(true); setShowLowConf(false);
      if (((opt as unknown as Record<string, number>).lncsr ?? 1) === 1) applyAdv("lncsr", 0);
      setCleanView(true);
      setStatus(lang === "zh" ? "干净视图：已隐藏分析框线，光标照常显示（V 恢复）" : "Clean view: analysis outlines hidden, cursor still shown (V to restore)");
    } else {
      const s = cleanSavedRef.current;
      setShowSystems(true); setShowBars(true); setShowCursor(true); setShowLowConf(true);
      if (s && s.lncsr === 1 && ((opt as unknown as Record<string, number>).lncsr ?? 0) === 0) applyAdv("lncsr", 1);
      setCleanView(false);
      setStatus("clean view: 四覆盖层已全开 (V 隐藏)");
    }
  }, [cleanView, showSystems, showBars, showCursor, showLowConf, applyAdv, lang]);

  const resetAdvDefaults = useCallback(() => {
    for (const [k, v] of Object.entries(DEFAULT_ADV)) {
      if (k === "skipn") { setSkipn(v); opt.skipn = v; }
      else if (k === "sysprf") setSysprf(v);
      else (opt as unknown as Record<string, number>)[k] = v;
    }
    advsRef.current = {};
    forceAdv((n) => n + 1);
    setStatus("advanced: 已恢复默认值(含各页独立参数) - reanalyzed");
    if (pdfDocRef.current) scheduleAdvRender(pdfDocRef.current);
  }, [scheduleAdvRender]);

  // 清除当前页的独立参数(回退跟随全局), 不碰其它页
  const clearPageAdv = useCallback(() => {
    const pg = pageNumRef.current;
    if (advsRef.current[pg]) {
      delete advsRef.current[pg];
      forceAdv((n) => n + 1);
      setStatus(`p${pg} 已回退跟随全局参数 - reanalyzed`);
      if (pdfDocRef.current) scheduleAdvRender(pdfDocRef.current);
    } else {
      setStatus(`p${pg} 本来就是全局参数, 无需清除`);
    }
  }, [scheduleAdvRender]);

  // React 小节设置 → 活引擎(拍号/显示号/练习区间; 面板输入框同步由引擎 applyConfig 负责, 几何重建走 resync)
  const pushMetroPatch = useCallback(() => {
    try {
      const mc = metroControl();
      if (!mc) return;
      const lm = loopMRef.current;
      mc.applyConfig({
        meterMap: { ...meterMapRef.current },
        barNumMap: { ...barNumRef.current },
        loopOn: lm.on, loopFrom: lm.from, loopTo: lm.to,
      });
      try { mc.resync?.(); } catch { /* 引擎无 B 时重建自愈 */ }
    } catch { /* 引擎未加载时只留 React 态 */ }
  }, []);
  // ---- 人工校正层 ----
  const pushUndo = useCallback(() => {
    const snap: ManualSnap = { bars: {}, align: {}, ...snapExtras() };
    for (const [k, v] of Object.entries(manualRef.current)) snap.bars[Number(k)] = cloneBars(v);
    for (const [k, v] of Object.entries(manualAlignRef.current)) snap.align[Number(k)] = { ...v };
    undoRef.current.push(snap);
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
  }, []);

  // 整谱 bars 按页拆分写入人工层(commit/拖动共用, 不碰 undo):
  // analysis.bars 是整谱合并态, 绝不能整体塞进单个页的键下, 否则 undo/合并时行数错位
  const writeManualBars = useCallback((nextBars: number[][]) => {
    let i = 0;
    const nextManual: Record<number, number[][]> = { ...manualRef.current };
    const nextAlign: Record<number, { skip: number; full: number }> = { ...manualAlignRef.current };
    for (const off of pageOffsetsRef.current) {
      const a = autoRef.current[off.page];
      if (!a) continue;
      const nsys = a.systems.length;
      nextManual[off.page] = cloneBars(nextBars.slice(i, i + nsys));
      // 本次写入基于当前分析几何: 记下对齐快照, 后续改 skipn 按端偏移对齐
      nextAlign[off.page] = {
        skip: pageSkipRef.current[off.page] ?? 0,
        full: pageFullRef.current[off.page] ?? a.systems.length,
      };
      i += nsys;
    }
    manualRef.current = nextManual;
    manualAlignRef.current = nextAlign;
    setManualBarsByPage(nextManual);
  }, []);

  const commitBars = useCallback(
    (nextBars: number[][], label: string) => {
      if (!analysis) return;
      pushUndo();
      writeManualBars(nextBars);
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
    [analysis, pushUndo, emitMetricRendered, writeManualBars],
  );

  const resetPageCorrections = useCallback(() => {
    if (!autoRef.current[1]) { setStatus("无自动识别结果可恢复"); return; }
    pushUndo();
    manualRef.current = {};
    manualAlignRef.current = {};
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
    // analysis.bars 是整谱合并态: 先切出当前页部分, 再只复制到系统数相同的页,
    // 行数不同的页硬塞会导致合并错位(由行数门限回退为自动, 等于没复制还污染 undo)
    const autoCur = autoRef.current[pageNum];
    const whole = manualRef.current[pageNum] ?? analysis.bars;
    const cur = manualRef.current[pageNum] ?? whole.slice(0, autoCur?.systems.length ?? whole.length);
    pushUndo();
    const next: Record<number, number[][]> = {};
    const nextAlign: Record<number, { skip: number; full: number }> = {};
    const srcAl = manualAlignRef.current[pageNum];
    let skipped = 0;
    for (let n = 1; n <= numPages; n++) {
      if ((autoRef.current[n]?.systems.length ?? -1) === cur.length) {
        next[n] = cloneBars(cur);
        // 目标页几何与源页一致才带对齐信息, 否则沿用旧逻辑(行数一致即用)
        const tSkip = pageSkipRef.current[n] ?? 0;
        const tFull = pageFullRef.current[n] ?? cur.length;
        if (srcAl && tSkip === srcAl.skip && tFull === srcAl.full) nextAlign[n] = { ...srcAl };
      }
      else skipped++;
    }
    manualRef.current = next;
    manualAlignRef.current = nextAlign;
    setManualBarsByPage(next);
    setStatus(`已将 p${pageNum} 校正复制到 ${Object.keys(next).length} 页` + (skipped ? ` · ${skipped} 页系统数不同已跳过` : ""));
  }, [analysis, numPages, pageNum, pushUndo]);

  // undo/redo 恢复: 人工层整份换回后必须经 mergeFromPages 重建整谱 analysis.
  // analysis 是整谱合并态, 绝不能只拼单页(旧代码错位即 chaos 来源); 时序走 reset+retain
  const restoreManual = useCallback((snap: ManualSnap, label: string) => {
    const next = snap.bars;
    manualRef.current = next;
    manualAlignRef.current = { ...snap.align };
    setManualBarsByPage({ ...next });
    if (snap.meter) syncMeterMap({ ...snap.meter });
    if (snap.barnum) syncBarNum({ ...snap.barnum });
    if (snap.loopm) syncLoopM({ ...snap.loopm });
    pushMetroPatch();
    const merged = mergeFromPages();
    if (!merged) {
      setAnalysis(null);
      setSelectedBar(null);
      setStatus(`${label} · 谱面为空`);
      return;
    }
    const saved = wijzerRef.current.times.slice();
    wijzerRef.current.reset(merged);
    const { dropped } = wijzerRef.current.retainTimes(saved);
    wijzerRef.current.fillDummyTimes();
    setTapCount(wijzerRef.current.times.length);
    setAnalysis(merged);
    setSelectedBar(null);
    setStatus(label + (dropped ? ` · timing截断${dropped}个` : ""));
    emitMetricRendered();
  }, [mergeFromPages, emitMetricRendered, syncMeterMap, syncBarNum, syncLoopM, pushMetroPatch]);

  const doUndo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) { setStatus("没有可撤销的校正"); return; }
    const snap: ManualSnap = { bars: {}, align: {}, ...snapExtras() };
    for (const [k, v] of Object.entries(manualRef.current)) snap.bars[Number(k)] = cloneBars(v);
    for (const [k, v] of Object.entries(manualAlignRef.current)) snap.align[Number(k)] = { ...v };
    redoRef.current.push(snap);
    restoreManual(prev, "已撤销上一步校正");
  }, [restoreManual]);

  const doRedo = useCallback(() => {
    const nxt = redoRef.current.pop();
    if (!nxt) { setStatus("没有可重做的校正"); return; }
    const snap: ManualSnap = { bars: {}, align: {}, ...snapExtras() };
    for (const [k, v] of Object.entries(manualRef.current)) snap.bars[Number(k)] = cloneBars(v);
    for (const [k, v] of Object.entries(manualAlignRef.current)) snap.align[Number(k)] = { ...v };
    undoRef.current.push(snap);
    restoreManual(nxt, "已重做校正");
  }, [restoreManual]);

  // 全局 raw 序号(merge 顺序 = metric 顺序 = 引擎 raw 计数) → 引擎小节号(扣 skipBars)
  const engineMeasureFromRaw = useCallback((raw: number): number => {
    try {
      const st = (window as unknown as Record<string, unknown>).__sgaMetro as
        { skipBars?: Record<string, unknown> } | undefined;
      const sk = st?.skipBars;
      if (!sk) return raw;
      let c = 0;
      for (const k of Object.keys(sk)) { const n = Number(k); if (Number.isFinite(n) && n >= 1 && n <= raw) c++; }
      return Math.max(1, raw - c);
    } catch { return raw; }
  }, []);
  const rawOrdinalOf = useCallback((si: number, bi: number): number | null => {
    if (!analysis) return null;
    let raw = 0;
    for (let r = 0; r < analysis.bars.length; r++) {
      const row = analysis.bars[r];
      for (let b = 0; b < row.length - 1; b++) { raw++; if (r === si && b === bi) return raw; }
    }
    return null;
  }, [analysis]);
  const sibiOfRaw = useCallback((raw: number): { si: number; bi: number } | null => {
    if (!analysis || raw < 1) return null;
    let n = 0;
    for (let r = 0; r < analysis.bars.length; r++) {
      const row = analysis.bars[r];
      for (let b = 0; b < row.length - 1; b++) { n++; if (n === raw) return { si: r, bi: b }; }
    }
    return null;
  }, [analysis]);
  const engineOfSibi = useCallback((si: number, bi: number): number | null => {
    const raw = rawOrdinalOf(si, bi);
    return raw == null ? null : engineMeasureFromRaw(raw);
  }, [rawOrdinalOf, engineMeasureFromRaw]);
  const totalEngineMeasures = useCallback((): number => {
    if (!analysis) return 0;
    let raw = 0;
    for (const row of analysis.bars) raw += Math.max(0, row.length - 1);
    return engineMeasureFromRaw(raw);
  }, [analysis, engineMeasureFromRaw]);
  const dispOf = useCallback((m: number): number => barNumRef.current[m] ?? m, []);
  // 小节动作(先 pushUndo 再改, 改完推引擎; 显示号 canonical: 等于自身则删键)
  const setBarBeats = useCallback((m: number, beats: number | null) => {
    pushUndo();
    const next = { ...meterMapRef.current };
    if (beats == null) delete next[m]; else next[m] = Math.min(12, Math.max(1, Math.round(beats)));
    syncMeterMap(next);
    pushMetroPatch();
    setStatus(beats == null ? `m${m} 拍号恢复默认` : `m${m} 拍号设为 ${beats} 拍${beats === 1 ? "(弱起 1/4)" : ""} · 显示第${dispOf(m)}小节`);
  }, [pushUndo, syncMeterMap, pushMetroPatch, dispOf]);
  const setBarDisp = useCallback((m: number, disp: number | null) => {
    pushUndo();
    const next = { ...barNumRef.current };
    if (disp == null || disp === m) delete next[m];
    else next[m] = Math.max(1, Math.round(disp));
    syncBarNum(next);
    pushMetroPatch();
    setStatus(disp == null || disp === m ? `m${m} 显示号恢复默认` : `m${m} 显示为第${next[m] ?? m}小节`);
  }, [pushUndo, syncBarNum, pushMetroPatch]);
  const renumberFrom = useCallback((m: number, start: number) => {
    pushUndo();
    const total = totalEngineMeasures();
    const next = { ...barNumRef.current };
    const s = Math.max(1, Math.round(start));
    for (let k = m; k <= total; k++) {
      const v = s + (k - m);
      if (v === k) delete next[k]; else next[k] = v;
    }
    syncBarNum(next);
    pushMetroPatch();
    setStatus(`从 m${m} 起顺排: 第${s}小节向后 · 共${Math.max(0, total - m + 1)}个`);
  }, [pushUndo, syncBarNum, pushMetroPatch, totalEngineMeasures]);
  const setLoopEnds = useCallback((from: number | null, to: number | null, on?: boolean) => {
    pushUndo();
    const cur = { ...loopMRef.current };
    if (from != null) cur.from = Math.max(1, Math.round(from));
    if (to != null) cur.to = Math.max(1, Math.round(to));
    if (cur.to < cur.from) cur.to = cur.from;
    cur.on = on !== undefined ? on : true;
    syncLoopM(cur);
    pushMetroPatch();
    setStatus(cur.on ? `Loop 第${dispOf(cur.from)}–第${dispOf(cur.to)}小节 · 中间为练习区间` : "Loop 已关");
  }, [pushUndo, syncLoopM, pushMetroPatch, dispOf]);
  const clearLoopM = useCallback(() => {
    pushUndo();
    syncLoopM({ on: false, from: 1, to: 1 });
    pushMetroPatch();
    setStatus("Loop 已清除");
  }, [pushUndo, syncLoopM, pushMetroPatch]);
  const loopMarkTap = useCallback((m: number) => {
    pushUndo();
    const cur = { ...loopMRef.current };
    let next: { on: boolean; from: number; to: number };
    if (!cur.on) next = { on: true, from: m, to: m };
    else if (cur.from !== cur.to) next = { on: true, from: m, to: m };
    else next = { on: true, from: Math.min(cur.from, m), to: Math.max(cur.from, m) };
    syncLoopM(next);
    pushMetroPatch();
    setStatus(next.from === next.to
      ? `Loop 起点第${dispOf(next.from)}小节 · 再点一小节定终点`
      : `Loop 第${dispOf(next.from)}–第${dispOf(next.to)}小节 · 中间为练习区间`);
  }, [pushUndo, syncLoopM, pushMetroPatch, dispOf]);
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
  // 跟谱滚屏：把指定谱面纵坐标的小节滚进视口（与 placeCursor 同策略）。
  // 只在小节切换时调用，不要每帧调用，避免与用户手动滚动打架。
  const scrollMeasureIntoView = useCallback((y: number) => {
    const notn = notationRef.current;
    const stack = stackRef.current;
    if (notn && stack && analysis) {
      const scale = stack.clientWidth / Math.max(1, analysis.pageW);
      const yCss = y * scale;
      const target = Math.round(yCss - notn.clientHeight * 0.3);
      const mx = notn.scrollHeight - notn.clientHeight;
      notn.scrollTop = Math.max(0, Math.min(mx, target));
    }
  }, [analysis]);

  // 音频跟谱统一入口：写阴影 + 小节切换时滚屏。节拍器走 placeCursor，
  // 音频时钟（rAF/原生 timeupdate）走这里，两边共享同一个 demaat 阴影。
  const applyFollowCursor = useCallback((c: { x: number; y: number; w: number; h: number; measure: number }) => {
    const prevMix = curMixRef.current;
    curMixRef.current = c.measure;
    // Same rect as last frame: keep the state object so the page does not re-render every frame.
    setCursor((p) => p && p.x === c.x && p.y === c.y && p.w === c.w && p.h === c.h ? p : { x: c.x, y: c.y, w: c.w, h: c.h });
    if (c.measure !== prevMix) scrollMeasureIntoView(c.y);
  }, [scrollMeasureIntoView]);

  const placeCursor = useCallback((mix: number, seekT?: number) => {
    const ms = wijzerRef.current.measures;
    if (!ms.length) return;
    const idx = ((Math.round(mix) % ms.length) + ms.length) % ms.length;
    const m = ms[idx];
    curMixRef.current = idx;
    setCursor({ x: m.x, y: m.y, w: m.w, h: m.h });
    scrollMeasureIntoView(m.y);
    if (seekT != null && Number.isFinite(seekT)) {
      const md = mediaRef.current as any;
      if (md && mediaURL) md.currentTime = seekT;
      else clockRef.current = { t0: performance.now(), base: seekT, running: clockRef.current.running };
    }
    setCursorInfo(`m${idx + 1}${seekT != null ? ` t=${seekT.toFixed(2)}s` : ""}`);
  }, [mediaURL, analysis]);

  // 上/下排切换(原版 goUpDown 小节模式): 同 x 中心跳到相邻系统行
  // Turn the bar range into a time window of the take (the pass nearest the playhead when bars repeat).
  const applyTakeLoop = useCallback((next: { on: boolean; from: number; to: number }): boolean => {
    const w = wijzerRef.current;
    const set = (v: { on: boolean; from: number; to: number }) => { takeLoopRef.current = v; setTakeLoop(v); };
    if (!next.on) { set(next); w.setLoop(0, 0); setStatus(lang === "zh" ? "小节循环已关" : "Bar loop off"); return true; }
    const md = mediaRef.current as { currentTime?: number; duration?: number } | null;
    const dur = md && typeof md.duration === "number" && Number.isFinite(md.duration) && md.duration > 0 ? md.duration - 0.05 : Infinity;
    const win = barLoopWindow(w.times, next.from, next.to, md?.currentTime ?? 0, dur);
    if (!win) {
      set({ ...next, on: false }); w.setLoop(0, 0);
      setStatus(lang === "zh" ? "录音里找不到这几个小节，没法循环" : "Those bars are not in the recording");
      return false;
    }
    set(next);
    w.setLoop(win.start, win.end);
    setStatus(lang === "zh" ? `循环第 ${next.from + 1}–${next.to + 1} 小节（录音 ${win.start.toFixed(1)}–${win.end.toFixed(1)} 秒）`
      : `Looping bars ${next.from + 1}–${next.to + 1} (take ${win.start.toFixed(1)}–${win.end.toFixed(1)} s)`);
    return true;
  }, [lang]);
  const takeLoopTap = useCallback((mix: number) => {
    if (takeLoopMark === 1) {
      const v = { on: false, from: mix, to: mix };
      takeLoopRef.current = v; setTakeLoop(v); setTakeLoopMark(2);
      setStatus(lang === "zh" ? `起点第 ${mix + 1} 小节 · 再点终点小节（点同一小节=只循环这一小节）` : `Start bar ${mix + 1} · now tap the end bar (same bar = loop just it)`);
      return;
    }
    const from = Math.min(takeLoopRef.current.from, mix), to = Math.max(takeLoopRef.current.from, mix);
    setTakeLoopMark(0);
    applyTakeLoop({ on: true, from, to });
  }, [takeLoopMark, lang, applyTakeLoop]);

  // What the video dialog needs: the page canvases as drawn, bar boxes, the take's bar times and audio.
  const videoSource = (): VideoExportSource => {
    const zh = lang === "zh";
    const title = (pdfName || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ").trim();
    return {
      title,
      performer: followMeta?.instrument ?? "",
      scores: followMeta?.scores?.length ? followMeta.scores : undefined,
      loopBars: takeLoop.on ? [takeLoop.from + 1, takeLoop.to + 1] : undefined,
      build: (layout, onlyLoop, meta) => {
        const w = wijzerRef.current;
        if (!mediaURL || w.times.length < 2) return zh ? "先跟随一遍录音再导出" : "Follow a take first";
        const pages = new Map<number, HTMLCanvasElement>();
        pagesHostRef.current?.querySelectorAll<HTMLCanvasElement>("canvas[data-page]").forEach((c) => pages.set(Number(c.dataset.page), c));
        if (!pages.size) return zh ? "谱面还没画好" : "The score is not drawn yet";
        const md = mediaRef.current as { duration?: number } | null;
        const dur = md && typeof md.duration === "number" && Number.isFinite(md.duration) ? md.duration : Infinity;
        let a: number, b: number;
        if (onlyLoop && takeLoop.on && w.loopEnd > w.loopStart) { a = w.loopStart; b = Math.min(dur, w.loopEnd + 0.3); }
        else {
          a = Math.max(0, w.times[0].t - 0.8);
          const lastStart = w.times[w.times.length - 1].t;
          const last = Math.max(lastStart + 0.5, followMeta?.endSec ?? lastStart + 2);
          b = Math.min(dur, last + 1.5);
        }
        if (!(b - a > 1)) return zh ? "这段太短，导不出视频" : "That part is too short for a video";
        return { layout, pages, offsets: pageOffsetsRef.current, measures: w.measures, times: w.times, mediaUrl: mediaURL, a, b, meta };
      },
    };
  };

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
    const hit = w.x2time(cx, targetRow - 5, (mediaRef.current as { currentTime?: number } | null)?.currentTime);
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
    // bi=0(首小节左线/系统左边界)允许向右合(删 line1); 向左合由 removeIndex<=0 拦。
    // 原先 bi<=0 一刀切, 首小节 D 键永远没反应(A 从 m2 删 line1 才绕过去)。
    if (!row || bi < 0 || bi >= row.length - 1) return;
    const removeIndex = side === "left" ? bi : bi + 1;
    if (removeIndex <= 0 || removeIndex >= row.length - 1) return;
    const bars = cloneBars(analysis.bars);
    bars[si].splice(removeIndex, 1);
    setSelectedBar({ si, bi: Math.max(0, Math.min(bi, bars[si].length - 2)) });
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

  // 被点小节的客户端矩形：与 findMeasureAt 同一套谱面坐标，经 stack 盒换算到 client 坐标，供弹框避让用
  const measureClientRect = useCallback(
    (si: number, bi: number): { left: number; top: number; right: number; bottom: number } | null => {
      if (!analysis) return null;
      const stack = stackRef.current;
      if (!stack) return null;
      const r = stack.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const s = analysis.systems[si];
      const row = analysis.bars[si] ?? [];
      if (!s || row.length < 2 || bi < 0 || bi > row.length - 2) return null;
      const y1 = s.cs[0] - analysis.spatium, y2 = s.cs[s.cs.length - 1] + analysis.spatium;
      const sx = r.width / analysis.pageW, sy = r.height / analysis.pageH;
      return { left: r.left + row[bi] * sx, top: r.top + y1 * sy, right: r.left + row[bi + 1] * sx, bottom: r.top + y2 * sy };
    },
    [analysis],
  );

  const onScoreClick = useCallback(
    (ev: React.MouseEvent) => {
      if (suppressClickRef.current) { suppressClickRef.current = false; return; } // 长按新增后的抬手 click
      const p = canvasCoords(ev.clientX, ev.clientY);
      if (!p) return;
      if (adjustMode) {
        // 调整模式: 点小节/线都弹设置框, 点空关闭
        // 初猜沿用旧固定偏移，携带 tap 点与小节盒给 layout effect 做实测择侧（旧偏移必盖小节，仅作首帧初值，绘制前即被纠正）
        const anchor = (cx: number, cy: number, m: { left: number; top: number; right: number; bottom: number } | null) => ({
          x: Math.min(Math.max(8, cx - 140), window.innerWidth - 300),
          y: Math.min(Math.max(8, cy - 60), window.innerHeight - 420),
          tapX: cx, tapY: cy,
          mL: m?.left ?? cx, mT: m?.top ?? cy, mR: m?.right ?? cx, mB: m?.bottom ?? cy,
        });
        const meas = findMeasureAt(p.x, p.y);
        if (meas) {
          const em = engineOfSibi(meas.si, meas.bi);
          setSelectedBar(meas);
          setBarPop(anchor(ev.clientX, ev.clientY, measureClientRect(meas.si, meas.bi)));
          if (em != null) setStatus(`第${dispOf(em)}小节 · 拍号/小节号/Loop`);
          return;
        }
        const hit = findNearestBar(p.x, p.y);
        const rowLen = hit ? (analysis?.bars[hit.si]?.length ?? 0) : 0;
        if (hit && hit.bi < rowLen - 1) {
          const em = engineOfSibi(hit.si, hit.bi);
          setSelectedBar({ si: hit.si, bi: hit.bi });
          setBarPop(anchor(ev.clientX, ev.clientY, measureClientRect(hit.si, hit.bi)));
          if (em != null) setStatus(`第${dispOf(em)}小节 · 拍号/小节号/Loop`);
          return;
        }
        setSelectedBar(null);
        setBarPop(null);
        return;
      }
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
      const hit = wijzerRef.current.x2time(p.x, p.y, (mediaRef.current as { currentTime?: number } | null)?.currentTime);
      if (!hit) { setSelectedBar(null); return; }
      if (takeLoopMark) { takeLoopTap(hit.measure); return; }
      if (loopMark) { loopMarkTap(engineMeasureFromRaw(hit.measure + 1)); return; }
      placeCursor(hit.measure, hit.t);
      const sibi = sibiOfRaw(hit.measure + 1);
      if (sibi) setSelectedBar(sibi);
      // metro 点小节由引擎 host 监听统一处理(播放中=暖机重起, 未播放=只移动头),
      // 这里不再另发 metro-jump, 避免双通道重复重起
    },
    [analysis, canvasCoords, correctMode, findMeasureAt, findNearestBar, measureClientRect, pageNum, placeCursor, engineMeasureFromRaw, loopMark, loopMarkTap, sibiOfRaw, adjustMode, engineOfSibi, dispOf, takeLoopMark, takeLoopTap],
  );

  // 纠错新增小节线(长按/双击共用): 点位须落在某系统行内
  const insertBarAt = useCallback(
    (cx: number, cy: number, via: string) => {
      if (!analysis) return;
      const p = canvasCoords(cx, cy);
      if (!p) return;
      let targetSi = -1;
      analysis.systems.forEach((s, si) => {
        const y1 = s.cs[0];
        const y2 = s.cs[s.cs.length - 1];
        if (p.y >= y1 - analysis.spatium && p.y <= y2 + analysis.spatium) targetSi = si;
      });
      if (targetSi < 0) { setStatus(`${via}位置不在任何系统内, 未新增`); return; }
      const bars = cloneBars(analysis.bars);
      bars[targetSi] = [...(bars[targetSi] ?? []), Math.round(p.x)].sort((a, b) => a - b);
      const bi = bars[targetSi].indexOf(Math.round(p.x));
      setSelectedBar({ si: targetSi, bi });
      commitBars(bars, `新增 p${pageNum} s${targetSi + 1} x=${Math.round(p.x)}`);
    },
    [analysis, canvasCoords, commitBars, pageNum],
  );

  const onScoreDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (!correctMode || !analysis) return;
      insertBarAt(ev.clientX, ev.clientY, "双击");
    },
    [analysis, correctMode, insertBarAt],
  );

  // 长按 550ms 不动即新增(触屏/鼠标左键, 拖线条不触发: 线条 pointerdown 已 stopPropagation)
  const cancelLongPress = useCallback(() => {
    if (longPressRef.current) { clearTimeout(longPressRef.current.timer); longPressRef.current = null; }
  }, []);
  const onNotationPointerDown = useCallback(
    (ev: React.PointerEvent) => {
      if (!correctMode || !analysis) return;
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      const p = canvasCoords(ev.clientX, ev.clientY);
      if (p) setTouchPos({ x: p.x, y: p.y });
      cancelLongPress();
      const cx = ev.clientX, cy = ev.clientY;
      longPressRef.current = {
        id: ev.pointerId, cx, cy,
        timer: setTimeout(() => {
          longPressRef.current = null;
          suppressClickRef.current = true; // 吞掉抬手后的一次 click(不弹 pie/不跳光标)
          insertBarAt(cx, cy, "长按");
        }, 550),
      };
    },
    [analysis, canvasCoords, cancelLongPress, correctMode, insertBarAt],
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
      // 长按滑动超 12px 取消新增; 纠错下虚拟光标跟随(触屏常显, 鼠标仅按住时)
      const lp = longPressRef.current;
      if (lp && lp.id === ev.pointerId
        && Math.hypot(ev.clientX - lp.cx, ev.clientY - lp.cy) > 12) cancelLongPress();
      if (correctMode && analysis && (ev.pointerType !== "mouse" || ev.buttons > 0)) {
        const tp = canvasCoords(ev.clientX, ev.clientY);
        if (tp) setTouchPos({ x: tp.x, y: tp.y });
      }
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
      writeManualBars(bars);
      wijzerRef.current.measures = buildMeasures({ ...analysis, bars });
      setAnalysis({ ...analysis, bars });
    },
    [analysis, canvasCoords, writeManualBars],
  );

  const onNotationPointerUp = useCallback(() => {
    cancelLongPress(); // 提前抬手: 长按不触发(抬手后的 click 正常走选中)
    const drag = dragRef.current;
    if (!drag.active) return;
    drag.active = false;
    redoRef.current = [];
    if (analysis) {
      const x = analysis.bars[drag.si]?.[drag.bi];
      setStatus(`校正 p${pageNum} s${drag.si + 1} → x=${Math.round(x ?? 0)}`);
    }
  }, [analysis, cancelLongPress, pageNum]);

  // 退出纠错清掉虚拟光标/挂起的长按
  useEffect(() => {
    if (!correctMode) { setTouchPos(null); cancelLongPress(); suppressClickRef.current = false; }
  }, [correctMode, cancelLongPress]);

  // ---- 批注(原版 annots 语义): annot 模式下右键新建, 拖动移动, 单击编辑, 右键删除 ----
  const commitAnnots = useCallback((next: Annot[]) => {
    const all = { ...annotsRef.current, [pageNum]: next };
    annotsRef.current = all;
    setAnnotsByPage(all);
  }, [pageNum]);

  const onNotationContextMenu = useCallback((ev: React.MouseEvent) => {
    if (correctMode) { ev.preventDefault(); return; } // 纠错长按不弹系统菜单/放大镜
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
  }, [analysis, canvasCoords, commitAnnots, correctMode, pageNum]);

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

  // Shade position for playhead t, PLAY_LEAD_SEC ahead in real time (scaled by playback rate).
  const followAt = useCallback((t: number) => {
    const m = mediaRef.current as { playbackRate?: number } | null;
    const rate = m && mediaURL && typeof m.playbackRate === "number" && m.playbackRate > 0 ? m.playbackRate : speed;
    return wijzerRef.current.time2x(t + PLAY_LEAD_SEC * rate, opt.lncsr === 1);
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
    const c = followAt(t);
    if (c) {
      applyFollowCursor(c);
      setCursorInfo(`m${c.measure + 1} t=${(Math.floor(t * 4) / 4).toFixed(2)}s`); // 4 Hz label: no per-frame re-render
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [now, mediaURL, followAt]);

  // 单时钟规则：一个视图同一时间只跟一个时钟、只显示一个阴影。
  // 播录音（doPlay/原生播放）→ 停掉旧节拍器引擎并藏起它的 sga-shade，demaat 接管；
  // 节拍器接管（▶/🥁/圆盘/录音）→ 暂停录音并停掉 React 阴影，sga-shade 接管。
  function parkLegacyShade() {
    try { document.getElementById("sga-shade")?.style.setProperty("display", "none"); } catch { /* noop */ }
  }
  const stopMetroForMedia = useCallback(() => {
    try {
      const mc = metroControl();
      if (mc && mc.isPlaying()) mc.stop();
    } catch { /* noop */ }
    setMetroPlaying(false);
    parkLegacyShade();
  }, []);
  const yieldToMetro = useCallback(() => {
    try {
      const md = mediaRef.current as unknown as { paused?: boolean; pause?: () => void } | null;
      if (md && mediaURL && md.paused === false) md.pause?.();
    } catch { /* noop */ }
    // 立刻停 tick: pause 事件是异步的, 期间 tick 会把 React 光标又画回来。
    cancelAnimationFrame(rafRef.current);
    setPlaying(false);
    setCursor(null);
  }, [mediaURL]);
  useEffect(() => {
    const takeover = () => yieldToMetro();
    window.addEventListener("sf:metro-takeover", takeover);
    return () => window.removeEventListener("sf:metro-takeover", takeover);
  }, [yieldToMetro]);
  // 强制只显示一个光标: 节拍器亮出 sga-shade 时, 录音在播则收起 shade, 否则撤掉 React 光标;
  // React 光标一出现(绘制前)就收起 shade。
  useEffect(() => {
    const onShade = () => {
      const md = mediaRef.current as unknown as { paused?: boolean } | null;
      if (md && mediaURL && md.paused === false) parkLegacyShade();
      else setCursor(null);
    };
    window.addEventListener("sf:metro-shade-shown", onShade);
    return () => window.removeEventListener("sf:metro-shade-shown", onShade);
  }, [mediaURL]);
  useLayoutEffect(() => {
    if (cursor && showCursor) parkLegacyShade();
  }, [cursor, showCursor]);
  const doPlay = useCallback(() => {
    enterAutoFs();
    stopMetroForMedia();
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
  }, [mediaURL, speed, tick, enterAutoFs]);

  const doPause = useCallback(() => {
    exitAutoFs();
    if (countInTimerRef.current) {
      clearInterval(countInTimerRef.current);
      countInTimerRef.current = null;
    }
    const m = mediaRef.current as any;
    if (m && mediaURL) m.pause();
    else {
      const c = clockRef.current;
      c.base = now();
      c.running = false;
    }
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, [mediaURL, now, exitAutoFs]);

  // 谱面播放器原生控件（或外部调用 el.play()）启动/暂停音频时，同样点亮
  // 跟谱状态：与 doPlay/doPause 对齐，但绝不触发自动全屏。
  const syncMediaPlaying = useCallback(() => {
    stopMetroForMedia();
    const m = mediaRef.current as unknown as { playbackRate?: number } | null;
    if (m && mediaURL && typeof m.playbackRate === "number") m.playbackRate = speed;
    setPlaying(true);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [mediaURL, speed, tick]);

  const doCountIn = useCallback(() => {
    if (countInTimerRef.current) clearInterval(countInTimerRef.current);
    const beats = parseInt(String(opt.bpmsr).split("-")[0], 10) || 4;
    let i = 0;
    setStatus(`count-in: ${beats} beats ...`);
    const iv = setInterval(() => {
      i++;
      setStatus(`count-in: ${beats - i} beats ...`);
      if (i >= beats) {
        clearInterval(iv);
        if (countInTimerRef.current === iv) countInTimerRef.current = null;
        doPlay();
      }
    }, 600);
    countInTimerRef.current = iv;
  }, [doPlay, opt.bpmsr]);

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
      meterMap: Object.keys(meterMapRef.current).length ? { ...meterMapRef.current } : undefined,
      barNumMap: Object.keys(barNumRef.current).length ? { ...barNumRef.current } : undefined,
      metroLoop: loopMRef.current.on ? { ...loopMRef.current } : undefined,
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

  // 异常上报 bundle: 修复前 preload.js(纯自动) + 修复后 preload.js(人工校正) +
  // 原 PDF(pdfBytesRef)；issue 里附逐行 diff，直达第几页第几行、增/删/移了哪条线。
  // 图片谱无原文件则只带数据(kind=image, 调试时需另附原图)
  const buildReportBundle = useCallback(async (): Promise<{
    dir: string; fileBase: string; report: Record<string, unknown>;
    pdfBuf: ArrayBuffer | null; summary: string[]; origJs: string; fixedJs: string;
  } | null> => {
    if (!analysis || !numPages) return null;
    const summary: string[] = [];
    const diff: string[] = [];
    for (let n = 1; n <= numPages; n++) {
      const a = autoRef.current[n];
      if (!a) continue;
      const corrected = pageBarsFor(n, a);
      const autoCount = a.bars.reduce((s, b) => s + Math.max(0, b.length - 1), 0);
      const corrCount = corrected.reduce((s, b) => s + Math.max(0, b.length - 1), 0);
      summary.push(`p${n}: auto ${autoCount} → corrected ${corrCount}${manualRef.current[n] ? " (manual)" : ""}`);
      // 逐行 diff(TOL=4 配对): +新增 -删除 ~移位(>1px)
      a.bars.forEach((autoRow, si) => {
        const fixRow = corrected[si] ?? [];
        const used = new Array(fixRow.length).fill(false);
        const moved: string[] = [];
        const removed: number[] = [];
        autoRow.forEach((w) => {
          let best = -1, bestD = 5;
          fixRow.forEach((d, ii) => {
            if (used[ii]) return;
            const dd = Math.abs(d - w);
            if (dd < bestD) { bestD = dd; best = ii; }
          });
          if (best >= 0) {
            used[best] = true;
            if (bestD > 1) moved.push(`${Math.round(w)}→${Math.round(fixRow[best])}`);
          } else removed.push(Math.round(w));
        });
        const added = fixRow.filter((_, ii) => !used[ii]).map((x) => Math.round(x));
        if (added.length || removed.length || moved.length) {
          diff.push(`p${n} s${si + 1}:` +
            (added.length ? ` +[${added.join(",")}]` : "") +
            (removed.length ? ` -[${removed.join(",")}]` : "") +
            (moved.length ? ` ~[${moved.join(",")}]` : ""));
        }
      });
    }
    if (!diff.length) diff.push("(auto 与 corrected 逐行一致：无小节线改动，问题在别处)");
    const optSnap: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(opt)) {
      if (typeof v === "number" || typeof v === "string") optSnap[k] = v;
    }
    const numKeys = ["drmpl", "drmpl2", "skipn", "seln", "eerst", "sysprf", "onestf",
      "zwgrens", "voorna", "mtdrmpl", "dx", "fixwd"] as const;
    const advs: Record<string, Record<string, number>> = {};
    for (let n = 1; n <= numPages; n++) {
      const row: Record<string, number> = {};
      const snap = advsRef.current[n];
      for (const k of numKeys) {
        row[k] = k === "skipn" || snap?.[k] === undefined
          ? 1 * ((opt as unknown as Record<string, number>)[k] ?? 0)
          : 1 * snap[k];
      }
      advs[String(n)] = row;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileBase = (pdfName || "score").replace(/\.pdf$/i, "")
      .replace(/[^\w\-一-鿿]+/g, "_").slice(0, 40) || "score";
    const pdfBuf = pdfBytesRef.current ? pdfBytesRef.current.slice(0) : null;
    const bpt = buildPreloadTextRef.current;
    if (!bpt) { setReportMsg("内部错误：导出器未就绪"); return null; }
    setStatus("上报：生成修复前 preload …");
    // orig 版只留 metric 做对照, 不嵌 PDF(以 fixed 版那份为准, 省一份拷贝)
    const origJs = await bpt(false, false);
    if (!origJs) return null;
    setStatus("上报：生成修复后 preload …");
    const fixedJs = await bpt(true, true);
    if (!fixedJs) return null;
    // sha 仍按原字节算(供抽 PDF 后校验), 不再单独传 score.pdf
    let pdfSha = "";
    if (pdfBuf && typeof crypto !== "undefined" && crypto.subtle) {
      const d = await crypto.subtle.digest("SHA-256", pdfBuf.slice(0));
      pdfSha = Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
    }
    const report: Record<string, unknown> = {
      app: "scorefollow-report", schema: 3, createdAt: new Date().toISOString(),
      pdfName: pdfName || "", kind: pdfBuf ? "pdf" : "image",
      algoVersion: ALGO_VERSION, opt: optSnap, advs,
      files: ["orig.preload.js", "fixed.preload.js"],
      summary, diff, note: reportNote.trim(),
      pdf: pdfBuf ? { file: "fixed.preload.js 内 pdf_data", bytes: pdfBuf.byteLength, sha256: pdfSha } : null,
      // 分析底图(页号→分析画布 PNG dataURL, 与浏览器同帧像素, 无则该页 null)
      pagePngs: Object.fromEntries(
        Object.keys(autoRef.current)
          .map(Number)
          .filter((n) => autoRef.current[n])
          .map((n) => [String(n), pagePngRef.current[n] ?? null]),
      ),
    };
    return { dir: `${stamp}-${fileBase}`, fileBase, report, pdfBuf, summary, origJs, fixedJs };
  }, [analysis, numPages, pdfName, manualBarsByPage, opt, reportNote]);

  // 上报门禁: 没分析 / 还在纠错模式 / 无校正证据 / 没勾确认, 一律不让提交(下载同门)
  const reportGate = useCallback((): string[] => {
    const bad: string[] = [];
    if (!analysis || !numPages) bad.push(lang === "zh" ? "先载入并分析谱面" : "Load and analyze a score first");
    if (correctMode) bad.push(lang === "zh" ? "先退出纠错模式（点“完成校正”）" : "Exit correction mode first (Done correcting)");
    if (!(Object.keys(manualBarsByPage).length > 0 || reportNoChange)) {
      bad.push(lang === "zh" ? "至少校正一页，或勾选“本谱无需校正”" : "Correct at least one page, or check “no correction needed”");
    }
    if (!reportConfirmed) bad.push(lang === "zh" ? "勾选“确认校正完成”后才能提交" : "Check “correction complete” before submitting");
    return bad;
  }, [analysis, numPages, correctMode, manualBarsByPage, reportNoChange, reportConfirmed, lang]);

  const downloadReport = useCallback(async () => {
    const bad = reportGate();
    if (bad.length) { setReportMsg(bad.join("；")); return; }
    setReportMsg(lang === "zh" ? "生成 bundle 中…" : "Building bundle…");
    let b: Awaited<ReturnType<typeof buildReportBundle>>;
    try {
      b = await buildReportBundle();
    } catch (e) {
      setReportMsg((lang === "zh" ? "生成失败：" : "Build failed: ") + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (!b) { setReportMsg("无可上报的数据"); return; }
    const save = (blob: Blob, name: string) => {
      const el = document.createElement("a");
      el.href = URL.createObjectURL(blob);
      el.download = name;
      el.click();
      setTimeout(() => URL.revokeObjectURL(el.href), 4000);
    };
    save(new Blob([b.origJs], { type: "text/javascript" }), `${b.dir}-orig.preload.js`);
    save(new Blob([b.fixedJs], { type: "text/javascript" }), `${b.dir}-fixed.preload.js`);
    save(new Blob([JSON.stringify(b.report, null, 1)], { type: "application/json" }), `${b.dir}-report.json`);
    setReportMsg(lang === "zh"
      ? `已下载 bundle（${b.dir}，3 个文件；原 PDF 在 fixed.preload.js 里），发过来即可开修`
      : `Bundle downloaded (${b.dir}, 3 files; source PDF inside fixed.preload.js)`);
  }, [reportGate, buildReportBundle, lang]);

  // 全自动提交: 浏览器直发 GitHub(Contents API 传文件 + Issues API 建单),
  // token 只存本机 localStorage, 绝不进代码仓库；静态托管无后端，这是唯一零服务器通道
  const submitReport = useCallback(async () => {
    const bad = reportGate();
    if (bad.length) { setReportMsg(bad.join("；")); return; }
    const tok = reportToken.trim();
    const repo = (reportRepo.trim() || "Birdywen/scorefollow").replace(/^\/+|\/+$/g, "");
    if (!tok) {
      setReportMsg(lang === "zh" ? "先填写 GitHub token（仅存本机浏览器）" : "Enter a GitHub token first (stored only in this browser)");
      return;
    }
    if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) {
      setReportMsg(lang === "zh" ? "仓库格式应为 owner/repo" : "Repo must look like owner/repo");
      return;
    }
    const b = await buildReportBundle().catch((e: unknown) => {
      setReportMsg((lang === "zh" ? "生成失败：" : "Build failed: ") + (e instanceof Error ? e.message : String(e)));
      return null;
    });
    if (!b) { setReportBusy(false); setReportMsg((m) => m || "无可上报的数据"); return; }
    setReportMsg(lang === "zh" ? "上传中…" : "Uploading…");
    try {
      try { localStorage.setItem("sf-report-token", tok); localStorage.setItem("sf-report-repo", repo); } catch { /* ignore */ }
      const fixedBytes = new Blob([b.fixedJs]).size;
      if (fixedBytes > 90 * 1024 * 1024) {
        throw new Error(lang === "zh" ? "fixed.preload.js 超过 90MB，GitHub 单文件上限，请改用“仅下载”" : "fixed.preload.js over 90MB exceeds GitHub single-file limit; use download instead");
      }
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" };
      const put = async (path: string, contentB64: string) => {
        const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
          method: "PUT", headers,
          body: JSON.stringify({ message: `auto-report: ${b.dir} ${path.split("/").pop()}`, content: contentB64, branch: "main" }),
        });
        if (!r.ok) {
          const t = await r.text().then((s) => s.slice(0, 200)).catch(() => "");
          throw new Error(`upload ${path.split("/").pop()} failed: ${r.status} ${t}`);
        }
      };
      const enc = new TextEncoder();
      await put(`reports/${b.dir}/orig.preload.js`, bufToB64(enc.encode(b.origJs).buffer as ArrayBuffer));
      await put(`reports/${b.dir}/fixed.preload.js`, bufToB64(enc.encode(b.fixedJs).buffer as ArrayBuffer));
      await put(`reports/${b.dir}/report.json`, bufToB64(enc.encode(JSON.stringify(b.report, null, 1)).buffer as ArrayBuffer));
      const diffLines = (b.report.diff as string[]).slice(0, 60);
      const lines = [
        `auto-report by scorefollow web UI (algo v${ALGO_VERSION})`, ``,
        `谱面: ${pdfName || "(未命名)"} · ${numPages} 页 · kind=${b.pdfBuf ? "pdf" : "image"}${
          b.report.pdf ? ` · 原 PDF 嵌于 fixed.preload.js 的 pdf_data（sha256 ${(b.report.pdf as Record<string, unknown>).sha256 || "n/a"}，可用 scripts/preload-pdf.mjs 抽出）` : " · 无原文件（图片谱，需另附原图）"}`,
        ``, `## 改动定位（auto → corrected）`,
        ...b.summary.map((s) => `- ${s}`),
        ...diffLines.map((s) => `- \`${s}\``),
        (b.report.diff as string[]).length > 60 ? `- …（共 ${(b.report.diff as string[]).length} 行，见 report.json）` : ``, ``,
        `备注: ${(reportNote.trim() || "（无）").slice(0, 2000)}`, ``,
        `bundle: \`reports/${b.dir}/\``,
        `- [orig.preload.js](https://github.com/${repo}/blob/main/reports/${b.dir}/orig.preload.js)（修复前·纯自动）`,
        `- [fixed.preload.js](https://github.com/${repo}/blob/main/reports/${b.dir}/fixed.preload.js)（修复后·人工校正·含原 PDF）`,
        `- [report.json](https://github.com/${repo}/blob/main/reports/${b.dir}/report.json)`,
      ];
      const ir = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST", headers,
        body: JSON.stringify({ title: `[auto-report] ${b.fileBase} ${b.dir.slice(0, 10)}`, body: lines.join("\n"), labels: ["auto-report"] }),
      });
      if (!ir.ok) {
        const t = await ir.text().then((s) => s.slice(0, 200)).catch(() => "");
        throw new Error(`create issue failed: ${ir.status} ${t}`);
      }
      const ij = await ir.json() as { number?: number };
      setReportMsg(lang === "zh"
        ? `已提交：issue #${ij.number} · bundle reports/${b.dir}/ —— 喊一声就开修`
        : `Submitted: issue #${ij.number} · bundle reports/${b.dir}/`);
    } catch (e) {
      setReportMsg((lang === "zh" ? "提交失败：" : "Submit failed: ") +
        (e instanceof Error ? e.message : String(e)) +
        (lang === "zh" ? "（可改用“仅下载 bundle”把文件发过来）" : " (use “Download bundle only” instead)"));
    } finally {
      setReportBusy(false);
    }
  }, [reportGate, buildReportBundle, reportToken, reportRepo, pdfName, numPages, reportNote, lang]);

  // 主通道: 直传服务器本地目录(~/scorefollow-reports/<dir>/)，无需 token、无中转。
  // 级联: 先走配置的地址, 不通再试同源 /sf-report-upload(本机测试直收)——两边都写同一密钥即可一次点通。
  const submitToServer = useCallback(async (): Promise<boolean> => {
    const bad = reportGate();
    if (bad.length) { setReportMsg(bad.join("；")); return false; }
    const secret = reportSecret.trim();
    if (!secret) {
      setReportMsg(lang === "zh" ? "先填写上报密钥（服务器 ~/sf-report-secret 首行）" : "Enter the upload secret first (first line of ~/sf-report-secret)");
      return false;
    }
    const b = await buildReportBundle().catch((e: unknown) => {
      setReportMsg((lang === "zh" ? "生成失败：" : "Build failed: ") + (e instanceof Error ? e.message : String(e)));
      return null;
    });
    if (!b) { setReportMsg((m) => m || "无可上报的数据"); return false; }
    setReportBusy(true);
    setReportMsg(lang === "zh" ? "直传服务器中…" : "Uploading to server…");
    try {
      const configured = reportEndpoint.trim() || `${BASE}/sf-report-upload.php`;
      const sameOrigin = `${window.location.origin}/sf-report-upload`;
      const endpoints = [...new Set([configured, sameOrigin])];
      try { localStorage.setItem("sf-report-endpoint", configured); localStorage.setItem("sf-report-secret", secret); } catch { /* ignore */ }
      const fd = new FormData();
      fd.append("secret", secret);
      fd.append("dir", b.dir);
      fd.append("orig", new Blob([b.origJs], { type: "text/javascript" }), "orig.preload.js");
      fd.append("fixed", new Blob([b.fixedJs], { type: "text/javascript" }), "fixed.preload.js");
      fd.append("meta", new Blob([JSON.stringify(b.report, null, 1)], { type: "application/json" }), "report.json");
      let lastErr = "";
      for (const endpoint of endpoints) {
        try {
          const r = await fetch(endpoint, { method: "POST", body: fd });
          const j = await r.json().catch(() => null) as { ok?: boolean; error?: string; dir?: string } | null;
          if (!r.ok || !j || j.ok !== true) {
            throw new Error(`server ${r.status}: ${(j && j.error) || "upload rejected"}`);
          }
          setReportMsg(lang === "zh"
            ? `已直传服务器（经 ${endpoint}）：~/scorefollow-reports/${j.dir || b.dir}/ —— 喊一声就开修`
            : `Uploaded to server (via ${endpoint}): ~/scorefollow-reports/${j.dir || b.dir}/`);
          return true;
        } catch (e) {
          lastErr = e instanceof Error ? `${endpoint} → ${e.message}` : String(e);
        }
      }
      setReportMsg((lang === "zh" ? "直传失败：" : "Server upload failed: ") + lastErr);
      return false;
    } finally {
      setReportBusy(false);
    }
  }, [reportGate, buildReportBundle, reportEndpoint, reportSecret, lang]);

  // preload.js 文本组装(原版 synpdf.html 兼容: 全页 metric + pdf_data + 全局 timing + 逐页 adv)

  // 读活节拍器预设(面板导出与 File 卡导出统一写 sga_config, 导入时恢复)
  const readMetroCfg = useCallback((): Record<string, unknown> | null => {
    try {
      const st = (window as unknown as Record<string, unknown>).__sgaMetro as Record<string, unknown> | undefined;
      if (!st || typeof st.bpm !== "number") return null;
      const cfg: Record<string, unknown> = {};
      for (const k of ["bpm", "meter", "color", "opacity", "countIn", "seqText", "meterMap",
        "skipBars", "barNumMap", "loopOn", "loopFrom", "loopTo", "loopN", "sound", "showBarnums", "followY", "lang"]) {
        const v = st[k];
        if (v !== undefined && v !== null) cfg[k] = v;
      }
      return cfg;
    } catch { return null; }
  }, []);

  // 供 File 卡预览/下载 + 节拍器面板 ⤓ Export(经 window.__sfPreloadText)共用
  // useManual=false 时 metric 全取自动值(异常上报交修复前版本用), 头部打标区分;
  // includePdf=false 时不嵌 pdf_data(上报 orig 版只留 metric 做对照, PDF 以 fixed 版那份为准)
  const buildPreloadText = useCallback(async (useManual = true, includePdf = true): Promise<string | null> => {
    const pdf = pdfDocRef.current;
    if (!pdf || !numPages) { setStatus("先载入谱面再保存 preload"); return null; }
    await renderQueueRef.current.catch(() => undefined);
    const w = wijzerRef.current;
    // 全页分析(缺失页后台补算, 人工校正优先)
    const off = document.createElement("canvas");
    for (let n = 1; n <= numPages; n++) {
      if (!autoRef.current[n]) {
        setStatus(`saving preload: 分析 p${n}/${numPages} ...`);
        await renderAndAnalyze(pdf, n, off, undefined, undefined, false);
      }
    }
    const metric = buildMetricArr(useManual) as unknown[];
    const numKeys = ["drmpl", "drmpl2", "skipn", "seln", "eerst", "sysprf", "onestf",
      "zwgrens", "voorna", "mtdrmpl", "dx", "fixwd"] as const;
    const adv: Record<string, Record<string, number>> = {};
    for (let n = 1; n <= numPages; n++) {
      const row: Record<string, number> = {};
      const snap = advsRef.current[n];
      // 该页调过的键用快照(不含 skipn: 整谱级, 全页统一用全局), 其余跟随全局
      for (const k of numKeys) {
        row[k] = k === "skipn" || snap?.[k] === undefined
          ? 1 * ((opt as unknown as Record<string, number>)[k] ?? 0)
          : 1 * snap[k];
      }
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
    L.push(`//# **** exported by scorefollow algo v${ALGO_VERSION} · ${numPages} pages metric${useManual ? "" : " AUTO-ONLY(orig)"} + ${pdfBytesRef.current && (opt as unknown as Record<string, number>).wpdf !== 0 ? "pdf_data + " : ""}timing ****`);
    L.push("//########################################");
    L.push(`pdf_file = ${JSON.stringify(base + ".pdf")};`);
    if (includePdf && pdfBytesRef.current && (opt as unknown as Record<string, number>).wpdf !== 0) {
      L.push(`pdf_data = ${bin2txt(pdfBytesRef.current)};`);
    }
    // synpdf convention: a YouTube source is saved as opt.yubvid with an empty media_file.
    const yubvid = mediaName.startsWith("youtube:") ? mediaName.slice(8) : "";
    if (yubvid) optSnap.yubvid = yubvid;
    L.push(`media_file = ${JSON.stringify(yubvid ? "" : mediaName || "")};`);
    L.push(`msc_tracks = "";`);
    L.push(`offset_js = 0.00;`);
    L.push(`opt = ${JSON.stringify(optSnap)};`);
    // 节拍器预设独立行(面板导出经 annot loader 注入同样内容; 导入时恢复活引擎)
    const metroCfg = readMetroCfg();
    if (metroCfg) L.push(`sga_config = ${JSON.stringify(metroCfg)};`);
    // 界面预设独立行(原版忽略不认识的行, 兼容)
    L.push(`ui_state = ${JSON.stringify({
      fullScreen: fullScreen || Boolean(document.fullscreenElement),
      hideUI: !chromeOpen,
      cleanView, darkTheme, lang,
      showSystems, showBars, showCursor, showLowConf, diagnosticMode,
      speed, profileName, loopA, loopB, synbox, embedMetro, pageNum,
      meterMap: meterMapRef.current, barNumMap: barNumRef.current, metroLoop: loopMRef.current,
    })};`);
    const annotAll: { x: number; y: number; w: number; c: number; t: string; d: number; p?: number }[] = [];
    for (const [pn, arr] of Object.entries(annotsRef.current)) {
      for (const a of arr) annotAll.push({ x: a.x, y: a.y, w: a.w, c: a.c, t: a.t, d: 0, p: Number(pn) });
    }
    // 节拍器嵌入: loader 藏进 annot(原版 eval 即自启动, 与 MEGA-METRO/metro-engine.js 同机制)
    const isEngineAnnot = (t: string) =>
      t.includes("__sgaBoot") || t.includes("metro-engine.js") || t.includes("sga_config");
    if (embedMetro) {
      const engineURL = window.location.origin + `${BASE}/metro-engine.js`;
      const cfgJson = JSON.stringify(metroCfg ?? {});
      const loader = '<scr' + 'ipt>window.sga_config=' + cfgJson + ';(function(){if(window.__sgaBoot)return;window.__sgaBoot=1;' +
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
    // HoMR 门数据随谱走(原版忽略不认识的行, 兼容): 载入时先于分析注入
    if (homrGateRef.current) L.push(`homr_gate = ${JSON.stringify(homrGateRef.current)};`);
    return L.join("\n") + "\n";
  }, [analysis, numPages, pageNum, pdfName, renderAndAnalyze, bin2txt, embedMetro, buildMetricArr, opt,
    readMetroCfg, fullScreen, chromeOpen, cleanView, darkTheme, lang,
    showSystems, showBars, showCursor, showLowConf, diagnosticMode,
    speed, profileName, loopA, loopB, synbox, mediaName, homrGateInfo]);

  useEffect(() => { buildPreloadTextRef.current = buildPreloadText; }, [buildPreloadText]);

  // save preload.js: 预览仅显示摘要；完整文本保留供下载/复制。
  const savePreload = useCallback(async () => {
    previewReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const txt = await buildPreloadText();
    if (!txt) return;
    preloadFullRef.current = txt;
    const lines = txt.split("\n");
    const HEAD = 80;
    const bytes = new Blob([txt]).size;
    const visible: string[] = [];
    let inPdf = false;
    for (const line of lines) {
      if (line.startsWith("pdf_data = ")) {
        visible.push("pdf_data = [PDF 内容已在预览中折叠；下载与复制包含完整内容];");
        inPdf = !line.trimEnd().endsWith("];");
      } else if (inPdf) {
        if (line.trimEnd().endsWith("];")) inPdf = false;
      } else {
        visible.push(line);
      }
      if (visible.length >= HEAD) break;
    }
    setPreloadPreview({
      head: visible.map((line) => line.length > 600 ? line.slice(0, 600) + " … [该行仅在预览中截断]" : line).join("\n"),
      truncated: lines.length > visible.length || visible.some((line) => line.length > 600),
      lines: lines.length,
      bytes,
    });
    setStatus(`preload preview: ${lines.length} 行 · ${(bytes / 1024).toFixed(0)} KB — 检查后点下载`);
  }, [buildPreloadText]);

  const downloadPreload = useCallback(() => {
    const txt = preloadFullRef.current;
    if (!txt) return;
    const base = (pdfName || "score").replace(/\.pdf$/i, "");
    const blob = new Blob([txt], { type: "text/javascript" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = base + ".js";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum);
    const w = wijzerRef.current;
    const withPdf = pdfBytesRef.current && (opt as unknown as Record<string, number>).wpdf !== 0;
    setStatus(`saved preload ${base}.js · ${numPages} pages · ${w.times.length} sync points` +
      (withPdf ? " · 含PDF" : (pdfBytesRef.current ? " · 无PDF(+PDF 已关)" : " · 无PDF(直接打开的?demo)")));
    closePreview();
  }, [pdfName, pageNum, numPages, renderPage, opt, closePreview]);

  const copyPreload = useCallback(async () => {
    const txt = preloadFullRef.current;
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      setStatus(`preload 已复制(${(new Blob([txt]).size / 1024).toFixed(0)} KB)`);
    } catch { setStatus("复制失败: 剪贴板被浏览器拒绝, 请用下载"); }
  }, []);

  // 宿主 builder 桥: 节拍器面板 ⤓ Export 在无原版 #show 时走这里拿校对数据
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__sfPreloadText = () => buildPreloadText();
  }, [buildPreloadText]);

  // preload.js 载入(原版兼容): pdf_data 内嵌PDF + 全页 metric 配对 + times + 逐页 adv
  // + sga_config(节拍器预设→活引擎) + ui_state(界面预设, 含全屏/隐藏UI)
  const loadPreloadText = useCallback(async (txt: string, name: string, fullPath?: string) => {
    setPerformanceOpen(false);
    if (!txt.includes("//# This page")) { setScorePhase("error"); setStatus("not a preload file(缺 //# This page 标记)"); return; }
    setScorePhase("loading");
    renderGenRef.current++;
    if (advRenderTimer.current) {
      clearTimeout(advRenderTimer.current);
      advRenderTimer.current = null;
    }
    await renderQueueRef.current.catch(() => undefined);
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
    // 2) metric / times / opt / adv / 预设解析
    const metric = getArr("metric_arr");
    const times = getArr("times_arr");
    const advAll = getObj("adv_settings");
    const optAll = getObj("opt");
    const sgaOwn = getObj("sga_config");
    const uiState = getObj("ui_state");
    const homrGateData = getObj("homr_gate") as unknown as HomrGateFile | null;
    // HoMR 门(先于逐页分析注入; 无则清空旧谱残留, 与 clearScoreState 同语义)
    homrGateRef.current = null;
    setHomrGate(null);
    setHomrGateInfo("");
    if (homrGateData && Array.isArray(homrGateData.pages) &&
      homrGateData.pages.every((p) => Number.isInteger(p.page) && Array.isArray(p.notes) &&
        Array.isArray(p.systems) && p.systems.every((s) => Array.isArray(s.bars)))) {
      homrGateRef.current = homrGateData;
      setHomrGate(homrGateData);
      const nn = homrGateData.pages.reduce((a, p) => a + p.notes.length, 0);
      setHomrGateInfo(`HoMR门·${homrGateData.pages.length}页·${nn}音符`);
    }
    const mediaWant = getStr("media_file");
    const yubvid = typeof optAll?.yubvid === "string" ? optAll.yubvid : "";
    if (yubvid) loadYouTube(yubvid);
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
    // 导入的按页 adv 存为快照(不含 skipn), 后续重分析各页沿用, 不再互相覆盖
    advsRef.current = {};
    if (advAll) {
      for (const [pn, row] of Object.entries(advAll)) {
        const n = Number(pn);
        if (!Number.isInteger(n) || n < 1 || !row || typeof row !== "object") continue;
        const snap: Record<string, number> = {};
        for (const [k, val] of Object.entries(row as Record<string, unknown>)) {
          const num = 1 * (val as number);
          if (!Number.isFinite(num)) continue;
          if (k === "skipn") continue;
          if (!(PAGE_ADV_KEYS as readonly string[]).includes(k)) continue;
          snap[k] = num;
        }
        if (Object.keys(snap).length) advsRef.current[n] = snap;
      }
    }
    clearPageCache();
    for (const entry of analysisRasterCacheRef.current.values()) releaseCanvas(entry.canvas);
    for (const cached of displayRasterCacheRef.current.values()) releaseCanvas(cached);
    analysisRasterCacheRef.current.clear();
    displayRasterCacheRef.current.clear();
    analysisRasterModeRef.current = "";
    displayRasterModeRef.current = "";
    scoreRevisionRef.current++;
    autoRef.current = {};
    pagePngRef.current = {};
    annotsRef.current = {};
    setAnnotsByPage({});
    undoRef.current = [];
    redoRef.current = [];
    setSelectedBar(null);
    // 3) 载入 PDF
    const pdfjs: any = await import("pdfjs-dist");
    let pdf = pdfDocRef.current;
    if (!pdfBytes && !pdf && fullPath && fullPath.includes("/")) {
      // 公开谱库 bundle: fixed.js 为省体积不嵌 pdf_data, 同目录 original.pdf 即原谱, 顺手取回
      // (ezmusicscore 练习链接 ?preload=Score/书/曲/fixed.js 即此情形; 取不到则走原提示)。
      const dir = fullPath.replace(/^\/+/, "").split("/").slice(0, -1).join("/");
      if (dir) {
        try {
          setStatus("preload 无内嵌PDF, 取同目录 original.pdf ...");
          const rr = await fetch(`${BASE}/${dir}/original.pdf`);
          if (rr.ok) {
            const ab = await rr.arrayBuffer();
            if (ab.byteLength > 0) pdfBytes = new Uint8Array(ab).buffer;
          }
        } catch { /* 取不到则走原提示 */ }
      }
    }
    if (pdfBytes) {
      pdfBytesRef.current = pdfBytes.slice(0);
      pdf = await pdfjs.getDocument({ data: pdfBytes, wasmUrl: `${BASE}/wasm/` }).promise;
      pdfDocRef.current = pdf;
      const want = getStr("pdf_file");
      pdfNameRef.current = want || name.replace(/\.js$/i, ".pdf");
      setPdfName(pdfNameRef.current);
      setNumPages(pdf.numPages);
    } else if (!pdf) { setScorePhase("error"); setStatus("无PDF可载入"); return; }
    // 4) 逐页分析(逐页 adv 生效) + metric 配对为人工校正
    const metricPages: unknown[] = Array.isArray(metric) ? (metric as unknown[]) : [];
    const metricWd = Number(metricPages[0]) || 0;
    const off = document.createElement("canvas");
    const nextManual: Record<number, number[][]> = {};
    for (let n = 1; n <= (pdf.numPages as number); n++) {
      // 按页快照由 renderAndAnalyze 自动叠加, 无需再逐页改全局
      setScorePhase("recognizing");
      setStatus(`loading preload: 分析 p${n}/${pdf.numPages} ...`);
      const { a } = await renderAndAnalyze(pdf, n, off, undefined, undefined, false);
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
    // 刚按新几何配对的人工行: 对齐快照记当前 skip/full, 后续改 skipn 照常对齐
    const nextAlign: Record<number, { skip: number; full: number }> = {};
    for (const n of Object.keys(nextManual).map(Number)) {
      const a = autoRef.current[n];
      if (a) nextAlign[n] = {
        skip: pageSkipRef.current[n] ?? 0,
        full: pageFullRef.current[n] ?? a.systems.length,
      };
    }
    manualAlignRef.current = nextAlign;
    const annotArr = getArr("annots");
    // 旧文件(面板导出)无 sga_config 独立行: 从 annot loader 的 window.sga_config={...} 里抠
    let sgaCfg: Record<string, unknown> | null =
      sgaOwn && typeof sgaOwn === "object" ? (sgaOwn as Record<string, unknown>) : null;
    if (!sgaCfg && Array.isArray(annotArr)) {
      for (const a of annotArr as { t?: unknown }[]) {
        const t = String(a?.t ?? "");
        const k = t.indexOf("window.sga_config");
        if (k < 0) continue;
        const b = t.indexOf("{", k);
        if (b < 0) continue;
        let depth = 0; let instr = false;
        for (let j = b; j < t.length; j++) {
          const ch = t[j];
          if (instr) { if (ch === '"') instr = false; continue; }
          if (ch === '"') { instr = true; continue; }
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) { try { sgaCfg = JSON.parse(t.slice(b, j + 1)); } catch { sgaCfg = null; } break; }
          }
        }
        if (sgaCfg) break;
      }
    }
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
    await renderPage(pdf, 1);
    // 5) 预设恢复: 节拍器 sga_config → 活引擎; ui_state → 界面(含全屏/隐藏UI)
    const restored: string[] = [];
    try {
      const mc = (window as unknown as Record<string, unknown>).__sgaMetroControl as
        { applyConfig?: (c: Record<string, unknown>) => void } | undefined;
      if (sgaCfg && mc?.applyConfig) { mc.applyConfig(sgaCfg); restored.push("metro"); }
    } catch { /* 引擎未加载时跳过 */ }
    if (uiState && typeof uiState === "object") {
      const u = uiState as Record<string, unknown>;
      const num = (v: unknown): number | undefined => {
        const n = 1 * (v as number);
        return Number.isFinite(n) ? n : undefined;
      };
      if (typeof u.showSystems === "boolean") setShowSystems(u.showSystems);
      if (typeof u.showBars === "boolean") setShowBars(u.showBars);
      if (typeof u.showCursor === "boolean") setShowCursor(u.showCursor);
      if (typeof u.showLowConf === "boolean") setShowLowConf(u.showLowConf);
      if (typeof u.cleanView === "boolean") setCleanView(u.cleanView);
      if (typeof u.diagnosticMode === "boolean") setDiagnosticMode(u.diagnosticMode);
      if (typeof u.darkTheme === "boolean") setDarkTheme(u.darkTheme);
      if (u.lang === "zh" || u.lang === "en") {
        setLang(u.lang);
        try { localStorage.setItem("sf-lang", u.lang); } catch { /* ignore */ }
      }
      const sp = num(u.speed);
      if (sp !== undefined) setSpeed(Math.min(4, Math.max(0.1, sp)));
      if (u.profileName === "fast" || u.profileName === "balanced" || u.profileName === "scan") {
        setProfileName(u.profileName); // 只记名, opt 已由文件恢复, 不重跑分析
      }
      const la = num(u.loopA); const lb = num(u.loopB);
      if (la !== undefined) setLoopA(la);
      if (lb !== undefined) setLoopB(lb);
      if (la !== undefined || lb !== undefined) {
        wijzerRef.current.setLoop(la ?? 0, lb ?? Math.max((la ?? 0) + 4, 4));
      }
      if (u.meterMap && typeof u.meterMap === "object") {
        const mm: Record<number, number> = {};
        for (const [k, v] of Object.entries(u.meterMap as Record<string, unknown>)) { const m = Number(k); const b = Number(v); if (Number.isFinite(m) && Number.isFinite(b)) mm[m] = Math.min(12, Math.max(1, Math.round(b))); }
        meterMapRef.current = mm; setMeterMap(mm);
      }
      if (u.barNumMap && typeof u.barNumMap === "object") {
        const bn: Record<number, number> = {};
        for (const [k, v] of Object.entries(u.barNumMap as Record<string, unknown>)) { const m = Number(k); const n2 = Number(v); if (Number.isFinite(m) && Number.isFinite(n2) && Math.round(n2) !== m) bn[m] = Math.max(1, Math.round(n2)); }
        barNumRef.current = bn; setBarNumMap(bn);
      }
      if (u.metroLoop && typeof u.metroLoop === "object") {
        const ml = u.metroLoop as Record<string, unknown>;
        const lm = { on: ml.on === true, from: Math.max(1, Math.round(Number(ml.from) || 1)), to: Math.max(1, Math.round(Number(ml.to) || 1)) };
        loopMRef.current = lm; setLoopM(lm);
      }
      try {
        const mc2 = metroControl();
        if (mc2) {
          mc2.applyConfig({ meterMap: { ...meterMapRef.current }, barNumMap: { ...barNumRef.current }, loopOn: loopMRef.current.on, loopFrom: loopMRef.current.from, loopTo: loopMRef.current.to });
          try { mc2.resync?.(); } catch { /* ignore */ }
        }
      } catch { /* 引擎未加载时跳过 */ }
      if (typeof u.synbox === "boolean") setSynbox(u.synbox);
      if (typeof u.embedMetro === "boolean") setEmbedMetro(u.embedMetro);
      if (typeof u.hideUI === "boolean") setChromeOpen(!u.hideUI);
      const pg = num(u.pageNum);
      if (pg !== undefined) {
        const target = Math.min(Math.max(1, Math.round(pg)), (pdf.numPages as number) || 1);
        pageNumRef.current = target;
        setPageNum(target);
        const off = pageOffsetsRef.current.find((o) => o.page === target);
        const notn = notationRef.current;
        const stack = stackRef.current;
        const a0 = autoRef.current[target];
        if (off && notn && stack && a0) {
          notn.scrollTop = off.y * (stack.clientWidth / Math.max(1, a0.pageW));
        }
      }
      if (u.fullScreen === true && !document.fullscreenElement) {
        document.documentElement.requestFullscreen?.()?.catch?.(() => {
          setStatus("preload 要求全屏: 浏览器拒绝了自动全屏, 请手动点 full screen");
        });
      }
      restored.push("界面");
    }
    if (!uiState || typeof uiState !== "object" || (uiState as Record<string, unknown>).pageNum === undefined) {
      pageNumRef.current = 1;
      setPageNum(1);
    }
    const adopted = Object.keys(nextManual).length;
    setScorePhase("ready-score");
    setStatus(`loaded preload ${name} · ${adopted} 页小节线已采用 · ${wijzerRef.current.times.length} sync points` +
      (pdfBytes ? " · PDF内嵌" : "") +
      (restored.length ? ` · 预设已恢复(${restored.join("+")})` : "") +
      (yubvid ? ` · YouTube ${yubvid}` : mediaWant && !mediaURL ? ` · 请载入音频 ${mediaWant}` : ""));
  }, [renderPage, mediaURL, loadYouTube]);

  const loadPreload = useCallback((f: File) => {
    f.text().then((txt) => void loadPreloadText(txt, f.name)).catch(() => { setScorePhase("error"); setStatus("preload 文件读取失败"); });
  }, [loadPreloadText]);

  // HoMR 音符模板门数据载入(scripts/homr-gate.py 产物): 校验形状后注入,
  // 重分析即生效(只否决符干, 不新增)。preload 的 homr_gate 行走同样入口。
  const applyHomrGateData = useCallback((d: unknown, name: string): boolean => {
    const ok = !!d && typeof d === "object" &&
      Array.isArray((d as HomrGateFile).pages) &&
      (d as HomrGateFile).pages.every((p) =>
        Number.isInteger(p.page) && Array.isArray(p.notes) && Array.isArray(p.systems) &&
        p.systems.every((s) => Array.isArray(s.bars)));
    if (!ok) { setStatus(`HoMR 门数据无效: ${name}`); return false; }
    const gd = d as HomrGateFile;
    homrGateRef.current = gd;
    setHomrGate(gd);
    const nn = gd.pages.reduce((a, p) => a + p.notes.length, 0);
    setHomrGateInfo(`HoMR门·${gd.pages.length}页·${nn}音符`);
    clearPageCache();
    forceAdv((n) => n + 1);
    if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNumRef.current);
    setStatus(`HoMR 门已载入: ${name} (${gd.pages.length}页/${nn}音符) - reanalyzed`);
    return true;
  }, [renderPage]);
  const loadHomrGate = useCallback((f: File) => {
    f.text().then((txt) => {
      let p: unknown;
      try { p = JSON.parse(txt); } catch { setStatus("HoMR 门文件解析失败"); return; }
      applyHomrGateData(p, f.name);
    }).catch(() => setStatus("HoMR 门文件读取失败"));
  }, [applyHomrGateData]);

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
      if (d.meterMap && typeof d.meterMap === "object") {
        const mm: Record<number, number> = {};
        for (const [k, v] of Object.entries(d.meterMap)) { const m = Number(k); const b = Number(v); if (Number.isFinite(m) && Number.isFinite(b)) mm[m] = Math.min(12, Math.max(1, Math.round(b))); }
        syncMeterMap(mm);
      }
      if (d.barNumMap && typeof d.barNumMap === "object") {
        const bn: Record<number, number> = {};
        for (const [k, v] of Object.entries(d.barNumMap)) { const m = Number(k); const n2 = Number(v); if (Number.isFinite(m) && Number.isFinite(n2) && Math.round(n2) !== m) bn[m] = Math.max(1, Math.round(n2)); }
        syncBarNum(bn);
      }
      if (d.metroLoop && typeof d.metroLoop === "object") {
        const ml = d.metroLoop as { on?: unknown; from?: unknown; to?: unknown };
        syncLoopM({ on: ml.on === true, from: Math.max(1, Math.round(Number(ml.from) || 1)), to: Math.max(1, Math.round(Number(ml.to) || 1)) });
      }
      pushMetroPatch();
      wijzerRef.current.loadTimes(d.times_arr);
      if (d.loop) wijzerRef.current.setLoop(d.loop.start, d.loop.end);
      setTapCount(wijzerRef.current.times.length);
      forceAdv((n) => n + 1);
      if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum);
      setStatus(`loaded ${wijzerRef.current.times.length} sync points` + (warnings.length ? ` · 注意: ${warnings.join("; ")}` : ""));
    }).catch(() => setStatus("timing file parse failed"));
  }, [analysis, pageNum, pdfName, renderPage, syncMeterMap, syncBarNum, syncLoopM, pushMetroPatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (helpOpen) { e.preventDefault(); setHelpOpen(false); return; }
        if (preloadPreview) { closePreview(); return; }
        setHelpOpen(false); setMenuOpen(false); setOpenMenu(false); setAdvOpen(false); setPie(null); setSelectedBar(null); setBarPop(null); setLoopMark(false); setTakeLoopMark(0);
        return;
      }
      if (preloadPreview || helpOpen) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      // 焦点在按钮时保留快捷键；只有空格/回车留给按钮原生激活，避免双触发播放。
      if (target?.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
      if (synbox && e.ctrlKey && (e.key === "," || e.key === ".")) {
        e.preventDefault(); adjustLast(e.key === "," ? -0.1 : 0.1); return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === "t") { e.preventDefault(); setChromeOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "f") { e.preventDefault(); void toggleFullScreen(); return; }
      if (e.key.toLowerCase() === "h") { e.preventDefault(); setHelpOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "l") { e.preventDefault(); applyAdv("lncsr", opt.lncsr === 1 ? 0 : 1); return; }
      if (e.key.toLowerCase() === "m") { e.preventDefault(); setAdvOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (adjustMode) { setAdjustMode(false); setSelectedBar(null); setBarPop(null); }
        else { setAdjustMode(true); setCorrectMode(false); setSelectedBar(null); setPie(null); setLoopMark(false); }
        return;
      }
      if (e.key.toLowerCase() === "v") { e.preventDefault(); toggleCleanView(); return; }
      if (e.key.toLowerCase() === "c") { e.preventDefault(); if (correctMode) { setSelectedBar(null); setPie(null); } else { setAdjustMode(false); setBarPop(null); } setCorrectMode(!correctMode); return; }
      if (correctMode && (e.key === "Delete" || e.key === "Del" || e.key === "Backspace")) { e.preventDefault(); deleteSelectedBar(); setPie(null); return; }
      if (correctMode && selectedBar && (e.key === "s" || e.key === "S")) { e.preventDefault(); splitSelectedMeasure(); return; }
      if (correctMode && selectedBar && (e.key === "a" || e.key === "A")) { e.preventDefault(); mergeSelectedMeasure("left"); return; }
      if (correctMode && selectedBar && (e.key === "d" || e.key === "D")) { e.preventDefault(); mergeSelectedMeasure("right"); return; }
      if (e.key === " ") {
        // 空格只控制节拍器开/关, 与播放彻底解耦(播放请按 P)。
        e.preventDefault();
        if (!e.repeat) {
          const mc = metroControl();
          if (mc) { mc.isPlaying() ? mc.stop() : mc.play(); }
        }
      }
      else if (e.key.toLowerCase() === "p") {
        // P 播放/暂停: 有音频播音频, 无音频走时钟光标; 再按一次暂停。
        e.preventDefault();
        if (!e.repeat) { playing ? doPause() : doPlay(); }
      }
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
    }, [playing, doPlay, doPause, now, mediaURL, synbox, doTap, backupOne, adjustLast, correctMode, deleteSelectedBar, doUndo, doRedo, placeCursor, stepSystem, pageNum, numPages, renderPage, applyAdv, toggleCleanView, selectedBar, splitSelectedMeasure, mergeSelectedMeasure, preloadPreview, closePreview, helpOpen, toggleFullScreen, engineMeasureFromRaw, loopMark, loopMarkTap, sibiOfRaw, adjustMode, engineOfSibi, dispOf]);

  useEffect(() => {
    const m = mediaRef.current as any;
    if (m && mediaURL) m.playbackRate = speed;
    if (!mediaURL) clockRef.current.running = playing;
  }, [speed, mediaURL, playing]);

  // URL 演奏参数覆盖: ?preload=Score/x.js&bpm=80&meter=3/4&countIn=2&speed=1&sound=wood
  // 在 preload 预设恢复之后再压一层, 速度随链接走, 发给学生点开即用。
  const applyUrlOverrides = useCallback((params: URLSearchParams) => {
    const cfg: Record<string, unknown> = {};
    // 缺参数时 params.get 返回 null: 必须先判有无, Number(null)===0 会误触下限 (bpm=20/speed=0.1)
    const bpmRaw = (params.get("bpm") || "").trim();
    if (/^\d+$/.test(bpmRaw)) cfg.bpm = Math.min(300, Math.max(20, parseInt(bpmRaw, 10)));
    const meter = (params.get("meter") || "").trim();
    if (/^\d{1,2}\/\d{1,2}$/.test(meter)) cfg.meter = meter;
    const countInRaw = (params.get("countIn") || "").trim();
    if (/^\d+$/.test(countInRaw)) cfg.countIn = Math.min(8, Math.max(0, parseInt(countInRaw, 10)));
    const sound = params.get("sound") || "";
    if (["wood", "clave", "beep", "digital", "snare", "voice_zh", "voice_en"].includes(sound)) cfg.sound = sound;
    const speedRaw = (params.get("speed") || "").trim();
    if (/^\d+(\.\d+)?$/.test(speedRaw)) setSpeed(Math.min(4, Math.max(0.1, Number(speedRaw))));
    // ?yt=<link or id> (or synpdf's ?yubvid=<id>) plays that YouTube video with the preload
    const yt = params.get("yt") || params.get("yubvid") || "";
    if (yt) loadYouTube(yt);
    if (!Object.keys(cfg).length) return;
    // 引擎可能稍后才挂载: 先试一次, 不成则跟 metro-state 重试(约 3 秒)
    let tries = 0;
    const push = () => {
      tries += 1;
      try {
        const mc = (window as unknown as Record<string, unknown>).__sgaMetroControl as
          { applyConfig?: (c: Record<string, unknown>) => void } | undefined;
        if (mc?.applyConfig) {
          mc.applyConfig(cfg);
          try { (mc as unknown as { resync?: () => void })?.resync?.(); } catch { /* ignore */ }
          setStatus((s) => s + " · 链接演奏参数已应用");
          return;
        }
      } catch { /* retry */ }
      if (tries < 6) window.setTimeout(push, 500);
    };
    push();
  }, [loadYouTube]);

  // 一键推送公开谱库: fixed preload → 本站 Score/ 目录(经 sf-report-upload.php target=score),
  // 落盘即公开可 fetch, 索引页 /scores/ 自动收录, 返回可分享链接并复制。
  const publishToScore = useCallback(async () => {
    if (!analysis || !numPages) {
      setScoreMsgTone("error");
      setScoreMsg(lang === "zh" ? "先载入并分析谱面" : "Load and analyze a score first");
      return;
    }
    const secret = reportSecret.trim();
    if (!secret) {
      setScoreMsgTone("error");
      setScoreMsg(lang === "zh" ? "先在上报区填写推送密钥（与直传服务器同一密钥）" : "Enter the upload secret first (same as server upload)");
      return;
    }
    // 三件套 bundle: 文件夹 Score/书名/曲名/ 下存 fixed.js(校正版) + auto.js(原始扫描版) + 原文件
    let folder = scorePath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!folder) {
      const base = (pdfName || "score").replace(/\.pdf$/i, "")
        .replace(/[^\w\-一-鿿]+/g, "_").slice(0, 40) || "score";
      folder = `Score/${base}`;
    }
    // 兼容旧习惯: 填了 .../曲名.js 就取目录部分
    folder = folder.replace(/\/[^/]+\.js$/i, "");
    if (!/^Score\/[0-9A-Za-z\-_./]{1,110}$/.test(folder) || folder.includes("..") || /\/$/.test(folder)) {
      setScoreMsgTone("error");
      setScoreMsg(lang === "zh" ? "路径须形如 Score/书名/曲名（字母数字 - _ . /，会自动建文件夹）" : "Path must look like Score/book/piece (a folder is created)");
      return;
    }
    const bpt = buildPreloadTextRef.current;
    if (!bpt) {
      setScoreMsgTone("error");
      setScoreMsg(lang === "zh" ? "谱面导出失败" : "Export failed");
      return;
    }
    setScoreMsgTone("info");
    setScoreMsg(lang === "zh" ? "生成校正版/原始版中…" : "Building fixed/auto bundles…");
    const fixedJs = await bpt(true, false).catch(() => null);
    if (!fixedJs) {
      setScoreMsgTone("error");
      setScoreMsg(lang === "zh" ? "谱面导出失败" : "Export failed");
      return;
    }
    const autoJs = await bpt(false, false).catch(() => null);
    if (!autoJs) {
      setScoreMsgTone("error");
      setScoreMsg(lang === "zh" ? "原始版导出失败" : "Auto export failed");
      return;
    }
    // 原文件: 有 PDF 存原 PDF, 图片谱存分析底图 PNG(与分析同帧像素)
    const originals: { name: string; blob: Blob }[] = [];
    if (pdfBytesRef.current) {
      originals.push({ name: "original.pdf", blob: new Blob([pdfBytesRef.current.slice(0)], { type: "application/pdf" }) });
    } else {
      for (let n = 1; n <= numPages; n++) {
        const du = pagePngRef.current[n];
        if (!du) continue;
        try {
          const blob = await (await fetch(du)).blob();
          originals.push({ name: `original-p${n}.png`, blob });
        } catch { /* 缺页跳过 */ }
      }
    }
    const path = `${folder}/fixed.js`;
    const metro = readMetroCfg();
    setScoreBusy(true);
    setScoreMsgTone("info");
    setScoreMsg(lang === "zh" ? "推送公开谱库中…" : "Publishing to library…");
    try {
      const fd = new FormData();
      fd.append("secret", secret);
      fd.append("target", "score-bundle");
      fd.append("folder", folder);
      fd.append("title", folder.split("/").pop() || folder);
      if (metro && typeof metro.bpm === "number") fd.append("bpm", String(metro.bpm));
      if (metro && typeof metro.meter === "string") fd.append("meter", metro.meter);
      fd.append("fixed", new Blob([fixedJs], { type: "text/javascript" }), "fixed.js");
      fd.append("auto", new Blob([autoJs], { type: "text/javascript" }), "auto.js");
      originals.forEach((o, i) => fd.append(`orig${i}`, o.blob, o.name));
      // 级联: 本站 PHP(虚拟主机) 不通则试同源直收 report-server.py(本机 nginx+8931)
      const configured = reportEndpoint.trim() || `${BASE}/sf-report-upload.php`;
      const sameOrigin = `${window.location.origin}/sf-report-upload`;
      let link = "";
      let lastErr = "";
      for (const endpoint of [...new Set([configured, sameOrigin])]) {
        try {
          const r = await fetch(endpoint, { method: "POST", body: fd });
          const j = await r.json().catch(() => null) as { ok?: boolean; error?: string; path?: string } | null;
          if (!r.ok || !j || j.ok !== true) throw new Error(`server ${r.status}: ${(j && j.error) || "rejected"}`);
          link = `${window.location.origin}${BASE}/?preload=${encodeURIComponent(j.path || path)}`;
          break;
        } catch (e) {
          lastErr = e instanceof Error ? `${endpoint} → ${e.message}` : String(e);
        }
      }
      if (!link) throw new Error(lastErr || "upload rejected");
      setScoreMsgTone("success");
      setScoreMsg((lang === "zh" ? "已公开：" : "Published: ") + link);
      try {
        await navigator.clipboard.writeText(link);
        setScoreMsg((m) => m + (lang === "zh" ? "（已复制）" : " (copied)"));
      } catch { /* 剪贴板不可用时只展示链接 */ }
    } catch (e) {
      setScoreMsgTone("error");
      setScoreMsg((lang === "zh" ? "推送失败：" : "Publish failed: ") + (e instanceof Error ? e.message : String(e)));
    } finally {
      setScoreBusy(false);
    }
  }, [analysis, numPages, reportSecret, scorePath, pdfName, readMetroCfg, reportEndpoint, lang]);

  // URL 直载 preload(原版风格): ?曲名.js(裸文件名, 相对本站目录) 或 ?preload=曲名.js
  // 例: /scorefollow/?mytune.js / /scorefollow/?preload=mytune.js
  // 原版 synpdf.html?preload_file.js 同约定(同目录相对路径, 也支持 ../ 上级)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = window.location.search.replace(/^\?/, "");
    if (!q) return;
    const params = new URLSearchParams(window.location.search);
    let name = params.get("preload") || "";
    if (!name && !q.includes("=") && /\.js$/i.test(q)) name = q; // 原版裸文件名风格
    if (!name) return;
    // 只允许本站相对路径, 拒绝绝对 URL/反斜杠(防 open-fetch)
    if (/^[a-z][a-z0-9+.-]*:/i.test(name) || name.startsWith("//") || name.includes("\\")) {
      setScorePhase("error");
      setStatus("URL preload 只允许本站相对路径");
      return;
    }
    name = name.split("#")[0];
    let dead = false;
    (async () => {
      try {
        setScorePhase("loading");
        setStatus(`URL preload 载入中: ${name} ...`);
        const r = await fetch(`${BASE}/${name.replace(/^\/+/, "")}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const txt = await r.text();
        if (dead) return;
        await loadPreloadText(txt, name.split("/").pop() || "url-preload.js", name);
        if (dead) return;
        applyUrlOverrides(params);
      } catch {
        if (!dead) { setScorePhase("error"); setStatus(`URL preload 载入失败: ${name}(文件须与本站同源可访问; file:// 下浏览器会拦截)`); }
      }
    })();
    return () => { dead = true; };
  }, [loadPreloadText]);

  // demo 模式: ?demo=1 自动载入内置谱 (免上传即测); 有 URL preload 参数时让位
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("demo")) return;
    const q = window.location.search.replace(/^\?/, "");
    if ((params.get("preload") || (!q.includes("=") && /\.js$/i.test(q) ? q : ""))) return;
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`${BASE}/demo-score.pdf`);
        const b = await r.blob();
        if (dead) return;
        await onPdfFile(new File([b], "demo-score.pdf", { type: "application/pdf" }));
        if (!dead) setStatus((s) => s + " · demo 谱已载入");
      } catch {
        if (!dead) { setScorePhase("error"); setStatus("demo 谱载入失败"); }
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
  const correctedPages = Object.keys(manualBarsByPage).length;
  const onScoreScroll = useCallback(() => {
    const host = notationRef.current;
    const stack = stackRef.current;
    if (!host || !stack || !analysis) return;
    const y = host.scrollTop * analysis.pageW / Math.max(1, stack.clientWidth);
    const current = pageOffsetsRef.current.findLast((off) => off.y <= y + 8)?.page ?? 1;
    if (current !== pageNumRef.current) { pageNumRef.current = current; setPageNum(current); }
  }, [analysis]);

  return (
    <main className={styles.page} data-fullscreen={fullScreen ? "true" : "false"} data-theme={darkTheme ? "dark" : "light"} data-mode={correctMode ? "correct" : diagnosticMode ? "diagnostic" : "practice"}>
      <MetroDock lang={lang} hidden={helpOpen || correctMode || !!preloadPreview || tunerOpen || playing} onEnginePlay={() => { yieldToMetro(); }} />
      {!chromeOpen && <button className={styles.showui} onClick={() => setChromeOpen(true)} title="Show toolbar (T)">UI</button>}
      {chromeOpen && <header className={styles.topbar}>
        <span className={styles.tbLogo}><svg className={styles.tbLogoSvg} width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="13" width="3" height="8" rx="1.5" fill="#2563eb"><animate attributeName="height" values="8;3;8" dur="1.1s" repeatCount="indefinite" /><animate attributeName="y" values="13;18;13" dur="1.1s" repeatCount="indefinite" /></rect><rect x="7" y="9" width="3" height="12" rx="1.5" fill="#0ea5e9"><animate attributeName="height" values="12;5;12" dur="1.1s" begin="0.15s" repeatCount="indefinite" /><animate attributeName="y" values="9;16;9" dur="1.1s" begin="0.15s" repeatCount="indefinite" /></rect><rect x="12" y="5" width="3" height="16" rx="1.5" fill="#2563eb"><animate attributeName="height" values="16;7;16" dur="1.1s" begin="0.3s" repeatCount="indefinite" /><animate attributeName="y" values="5;14;5" dur="1.1s" begin="0.3s" repeatCount="indefinite" /></rect><rect x="17" y="10" width="3" height="11" rx="1.5" fill="#0ea5e9"><animate attributeName="height" values="11;4;11" dur="1.1s" begin="0.45s" repeatCount="indefinite" /><animate attributeName="y" values="10;17;10" dur="1.1s" begin="0.45s" repeatCount="indefinite" /></rect></svg>MEGA-METRO</span>
        <span className={styles.openWrap}>
          <button className={`${styles.tbBtn} ${pdfName || mediaURL ? styles.tbBtnOn : ""}`} onClick={() => { setOpenMenu((v) => !v); setMenuOpen(false); }} aria-expanded={openMenu} aria-haspopup="menu" aria-controls="sf-open" title={tx("open")}>{tx("open")} ▾</button>
          {openMenu && <div className={styles.openMenu} id="sf-open" role="menu" aria-label={tx("open")}>
            <button role="menuitem" className={styles.openItem} onClick={() => { setOpenMenu(false); pdfInputRef.current?.click(); }}>{pdfName ? "✓" : "📄"} {tx("loadPdf")}{pdfName ? ` · ${pdfName.length > 18 ? pdfName.slice(0, 16) + "…" : pdfName}` : ""}</button>
            <button role="menuitem" className={styles.openItem} onClick={() => { setOpenMenu(false); imgInputRef.current?.click(); }}>🖼 {tx("loadImage")}</button>
            <button role="menuitem" className={styles.openItem} onClick={() => { setOpenMenu(false); void openCamera(); }}>📷 {tx("takePhoto")}</button>
            <button role="menuitem" className={styles.openItem} onClick={() => { setOpenMenu(false); mediaInputRef.current?.click(); }}>{mediaURL && mediaKind !== "youtube" ? "✓" : "🎵"} {tx("loadMedia")}</button>
            <button role="menuitem" className={styles.openItem} aria-expanded={ytOpen} onClick={() => { setYtOpen((v) => !v); setYtErr(""); }}>{mediaKind === "youtube" && mediaURL ? "✓" : "▶"} {tx("loadYoutube")}</button>
            {ytOpen && <form className={styles.ytForm} onSubmit={(e) => {
              e.preventDefault();
              if (loadYouTube(ytText)) { setYtOpen(false); setOpenMenu(false); setYtText(""); }
              else setYtErr(lang === "zh" ? "无法识别的 YouTube 链接或视频 ID" : "Not a YouTube link or 11-character video id");
            }}>
              <input autoFocus type="text" inputMode="url" value={ytText} onChange={(e) => { setYtText(e.target.value); setYtErr(""); }}
                placeholder="https://youtu.be/…" aria-label={tx("loadYoutube")} aria-invalid={!!ytErr} />
              <button type="submit" disabled={!ytText.trim()}>{lang === "zh" ? "载入" : "Load"}</button>
              {ytErr && <span className={styles.ytErr} role="alert">{ytErr}</span>}
            </form>}
            {account.user && <><div className={styles.menuSep} role="separator" />
            <button role="menuitem" className={styles.openItem} aria-expanded={cloudScoresOpen} onClick={() => setCloudScoresOpen((v) => !v)}>☁ {lang === "zh" ? "我的乐谱" : "My scores"} ({cloudScores.length})</button>
            {cloudScoresOpen && (cloudScores.length === 0 ? <span className={styles.ytErr}>{lang === "zh" ? "还没有云端乐谱：打开一个 PDF 就会自动保存" : "Nothing yet: opening a PDF saves it here"}</span>
              : cloudScores.map((s) => <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
                <button role="menuitem" className={styles.openItem} style={{ flex: 1, textAlign: "left" }} onClick={async () => {
                  try {
                    const blob = await pullScoreBlob(BASE, s);
                    setOpenMenu(false);
                    await onPdfFile(new File([blob], `${s.title}.pdf`, { type: "application/pdf" }));
                  } catch { setStatus(lang === "zh" ? "云端乐谱下载失败" : "Could not download the score"); }
                }}>{s.title}</button>
                <button role="menuitem" className={styles.openItem} aria-label={lang === "zh" ? `从云端删除 ${s.title}` : `Remove ${s.title} from the cloud`}
                  onClick={() => { void deleteCloudScore(BASE, s.id).then(refreshCloudScores).catch(() => undefined); }}>×</button>
              </div>))}</>}
            {dev && <><div className={styles.menuSep} role="separator" />
            <button role="menuitem" className={styles.openItem} onClick={() => { setOpenMenu(false); preloadInputRef.current?.click(); }}>📥 {tx("loadPreload")} · {tx("expertDev")}</button></>}
          </div>}
        </span>
        <input ref={pdfInputRef} type="file" accept=".pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPdfFile(f); e.target.value = ""; }} />
        <input ref={imgInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files?.length) void onImageFile(e.target.files); e.target.value = ""; }} />
        <input ref={camInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { if (e.target.files?.length) void onImageFile(e.target.files); e.target.value = ""; }} />
        <input ref={mediaInputRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return;
          setMediaURL(URL.createObjectURL(f));
          setMediaName(f.name);
          setMediaKind(f.type.startsWith("video") ? "video" : "audio");
          e.target.value = "";
        }} />
        <input ref={preloadInputRef} type="file" accept=".js" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadPreload(f); e.target.value = ""; }} />
         <span className={styles.tbTitle} data-empty={pdfName ? "false" : "true"} title={pdfName || undefined}>{pdfName || tx("noScore")}{numPages ? ` · ${numPages}${tx("pageUnit")}` : ""}</span>
          {loopM.on && <span className={styles.tbGroup} title={lang === "zh" ? "节拍器练习区间(点谱面小节可改)" : "Metro practice range (tap score bars to change)"}>Loop {barNumRef.current[loopM.from] ?? loopM.from}–{barNumRef.current[loopM.to] ?? loopM.to}</span>}
        <span className={styles.tbSpacer} />
        <button className={styles.tbBtn} onClick={() => setAccountOpen(true)} title={account.user?.email ?? (lang === "zh" ? "登录 / 注册" : "Sign in / Sign up")}>{account.user ? `👤 ${account.user.displayName || account.user.email.split("@")[0]}` : (lang === "zh" ? "登录" : "Sign in")}</button>
        <span className={styles.tbMenuWrap}>
          <button className={styles.tbBtn} aria-label={tx("tuner")} onClick={() => setTunerOpen(true)} title={tx("tuner")}>🎚</button>
           <button className={styles.tbBtn} onClick={() => { setMenuOpen((v) => !v); setOpenMenu(false); }} aria-expanded={menuOpen} aria-controls="sf-settings" title={tx("settings")}>⚙ {tx("settings")}</button>
           {menuOpen && <div className={styles.tbMenu} id="sf-settings" role="region" aria-label={tx("settings")}>
            <div className={styles.tbMenuRow}>
              <label><input type="checkbox" checked={loopB > loopA} onChange={(e) => {
                if (takeLoopRef.current.on) { takeLoopRef.current = { ...takeLoopRef.current, on: false }; setTakeLoop(takeLoopRef.current); }
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
              <button className={styles.tbBtn} onClick={() => { if (correctMode) { setSelectedBar(null); setPie(null); } else { setAdjustMode(false); setBarPop(null); } setCorrectMode(!correctMode); }} title="Barline correction mode (C)">{correctMode ? "✓ correct" : "correct"}</button>
              <button className={`${styles.tbBtn} ${loopMark ? styles.tbBtnOn : ""}`} onClick={() => setLoopMark((v) => !v)} title={lang === "zh" ? "谱面点选练习区间: 先点起点小节, 再点终点小节" : "Tap score to mark practice range: start bar first, then end bar"}>{loopMark ? tx("loopMarking") : tx("loopMark")}</button>
              <button className={styles.tbBtn} onClick={() => { setMenuOpen(false); setHelpOpen(true); }} title="Keyboard shortcuts and help">? help</button>
              <button className={styles.tbBtn} onClick={toggleFullScreen} title="Toggle fullscreen (F)">{fullScreen ? "exit full" : "full screen"}</button>
              <button className={styles.tbBtn} onClick={() => setDarkTheme((v) => !v)} title="Toggle light/dark theme">{darkTheme ? "light" : "dark"}</button>
              <button className={styles.tbBtn} onClick={toggleLang} title="语言 / Language">{lang === "zh" ? "English" : "中文"}</button>
              <button className={styles.tbBtn} onClick={() => { setMenuOpen(false); setChromeOpen(false); }} title="Hide toolbar (T)">hide UI</button>
            </div>
          </div>}
        </span>
      </header>}

      {/* 分析开关与存取已并入右侧 panel, 状态行见底部 statusbar */}
      {barPop && selectedBar && analysis && (() => {
        const m = engineOfSibi(selectedBar.si, selectedBar.bi);
        if (m == null) return null;
        const beats = meterMap[m] ?? 0;
        const disp = barNumRef.current[m] ?? m;
        const total = totalEngineMeasures();
        return (
          <div ref={barPopRef} className={styles.barPop} style={{ top: barPop.y, left: barPop.x, right: "auto" }} role="dialog" aria-label={tx("barSetup")}>
            <div className={styles.tbMenuRow}>
              <strong>{tx("barSetup")} · {disp === m ? `第${disp}小节` : `m${m}→第${disp}小节`}</strong>
              <span style={{ flex: 1 }} />
              <button className={styles.tbBtn} onClick={() => { setSelectedBar(null); setBarPop(null); }} title={tx("close")}>×</button>
            </div>
            <div className={styles.tbMenuRow} style={{ flexWrap: "wrap" }}>
              <span>{tx("barMeter")}</span>
              <select value={beats} onChange={(e) => setBarBeats(m, Number(e.target.value) || null)}>
                <option value={0}>{tx("meterDefault")}</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((b) => (<option key={b} value={b}>{b}</option>))}
              </select>
              {[1, 2, 3, 4, 6].map((b) => (
                <button key={b} className={`${styles.tbBtn} ${beats === b ? styles.tbBtnOn : ""}`} onClick={() => setBarBeats(m, b)}>
                  {b === 1 ? tx("pickup14") : b === 6 ? "6/8" : `${b}/4`}
                </button>
              ))}
            </div>
            <div className={styles.tbMenuRow}>
              <span>{tx("barNo")}</span>
              <input id="sf-barno" type="number" min={1} max={Math.max(1, total)} key={`bn-${m}`} defaultValue={disp}
                onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v >= 1 && v !== disp) setBarDisp(m, v); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              <button className={styles.tbBtn} onClick={() => { const el = document.getElementById("sf-barno") as HTMLInputElement | null; const v = el ? Math.round(Number(el.value)) : disp; if (Number.isFinite(v) && v >= 1) renumberFrom(m, v); }} title={lang === "zh" ? "从该小节起按此号向后顺排" : "Renumber this and following bars from here"}>{tx("renumber")}</button>
            </div>
            <div className={styles.tbMenuRow}>
              <span>{tx("loopToggle")}{loopM.on ? ` ${barNumRef.current[loopM.from] ?? loopM.from}–${barNumRef.current[loopM.to] ?? loopM.to}` : (lang === "zh" ? "关" : " off")}</span>
            </div>
            <div className={styles.tbMenuRow}>
              <button className={styles.tbBtn} onClick={() => setLoopEnds(m, null)}>{tx("loopFrom")}</button>
              <button className={styles.tbBtn} onClick={() => setLoopEnds(null, m)}>{tx("loopTo")}</button>
              <button className={`${styles.tbBtn} ${loopM.on ? styles.tbBtnOn : ""}`} onClick={() => setLoopEnds(null, null, !loopM.on)}>{loopM.on ? `✓${tx("loopToggle")}` : tx("loopToggle")}</button>
              <button className={styles.tbBtn} onClick={clearLoopM}>{tx("loopClear")}</button>
            </div>
          </div>
        );
      })()}

       {chromeOpen && <nav className={styles.practicebar} aria-label={tx("practice")}>
          {!mediaURL ? (
            <button className={styles.practicePlay} onClick={() => {
              const mc = metroControl();
              if (mc) { if (metroPlaying) mc.stop(); else if (mc.play()) yieldToMetro(); }
              else { playing ? doPause() : doPlay(); }
            }} title={metroAvail
              ? (lang === "zh" ? "节拍器播放/停止(含预备拍); 播放中点小节=暖机重起" : "Metro play/stop with count-in; tap a measure while playing to restart there")
              : (lang === "zh" ? "节拍器未加载, 退回静音光标" : "Metro unavailable, silent cursor fallback")}>
              {metroAvail ? (metroPlaying ? tx("metroStop") : tx("metroPlay")) : (playing ? tx("pause") : tx("play"))}
            </button>
          ) : (
            <>
              <button className={styles.practicePlay} onClick={() => playing ? doPause() : doPlay()}>
                {playing ? tx("pause") : tx("play")}
              </button>
              {metroAvail && (
                <button className={`${styles.practiceBtn} ${metroPlaying ? styles.practiceBtnActive : ""}`} aria-pressed={metroPlaying}
                  onClick={() => { const mc = metroControl(); if (mc) { if (metroPlaying) mc.stop(); else if (mc.play()) yieldToMetro(); } }}
                  title={lang === "zh" ? "节拍器独立播放/停止(含预备拍); 播放中点小节=暖机重起" : "Metro play/stop with count-in; tap a measure while playing to restart there"}>
                  🥁
                </button>
              )}
              {tapCount >= 2 && (
                <button className={`${styles.practiceBtn} ${takeLoop.on || takeLoopMark ? styles.practiceBtnActive : ""}`} aria-pressed={takeLoop.on}
                  onClick={() => {
                    if (takeLoopMark) { setTakeLoopMark(0); setStatus(lang === "zh" ? "已取消选小节" : "Bar pick cancelled"); }
                    else if (takeLoop.on) applyTakeLoop({ ...takeLoop, on: false });
                    else { setLoopMark(false); setTakeLoopMark(1); setStatus(lang === "zh" ? "在谱面上点要循环的第一个小节" : "Tap the first bar to loop on the score"); }
                  }}
                  title={lang === "zh" ? "循环录音里的几个小节：点这里，再在谱面点起点和终点小节；再点一次关闭" : "Loop bars of the recording: click, then tap the start and end bars on the score; click again to stop"}>
                  🔁 {takeLoopMark === 1 ? (lang === "zh" ? "点起点小节" : "Tap start bar")
                    : takeLoopMark === 2 ? (lang === "zh" ? "点终点小节" : "Tap end bar")
                    : takeLoop.on ? `${takeLoop.from + 1}–${takeLoop.to + 1}` : <span className={styles.phoneHide}>{lang === "zh" ? "循环小节" : "Loop bars"}</span>}
                </button>
              )}
              {tapCount >= 2 && mediaKind !== "youtube" && (
                <button className={styles.practiceBtn} onClick={() => { doPause(); setVideoOpen(true); }}
                  title={lang === "zh" ? "把这一遍录音和谱面合成 MP4（带片头片尾）" : "Make an MP4 of this take with the score (with title and closing cards)"}>
                  🎬 <span className={styles.phoneHide}>{lang === "zh" ? "导出视频" : "Export video"}</span>
                </button>
              )}
            </>
          )}
         <span className={styles.practiceDivider} />
          <button className={styles.practiceBtn} disabled={!analysis || pageNum <= 1} onClick={() => {
           const n = Math.max(1, pageNum - 1); pageNumRef.current = n; setPageNum(n);
           const off = pageOffsetsRef.current.find((o) => o.page === n);
           if (off && notationRef.current && stackRef.current && analysis) notationRef.current.scrollTop = off.y * (stackRef.current.clientWidth / Math.max(1, analysis.pageW));
          }} aria-label={tx("prevPage")}>‹</button>
          <span className={styles.pageIndicator}><span className={styles.phoneHide}>{lang === "zh" ? "第 " : "Page "}</span>{pageNum} / {numPages || 1}{lang === "zh" && <span className={styles.phoneHide}> 页</span>}</span>
          <button className={styles.practiceBtn} disabled={!analysis || pageNum >= numPages} onClick={() => {
           const n = Math.min(numPages || 1, pageNum + 1); pageNumRef.current = n; setPageNum(n);
           const off = pageOffsetsRef.current.find((o) => o.page === n);
           if (off && notationRef.current && stackRef.current && analysis) notationRef.current.scrollTop = off.y * (stackRef.current.clientWidth / Math.max(1, analysis.pageW));
          }} aria-label={tx("nextPage")}>›</button>
          <span className={styles.practiceDivider} />
          <label className={styles.speedControl}>{tx("speed")}
            <input type="range" min={0.1} max={4} step={0.05} value={speed} aria-label={tx("speed")} aria-valuetext={`${speed.toFixed(2)}×`} onChange={(e) => setSpeed(Number(e.target.value))} />
           <b>{speed.toFixed(2)}×</b>
         </label>
           <span className={styles.practiceDivider} />
           <button className={`${styles.practiceBtn} ${correctMode ? styles.practiceBtnActive : ""} ${styles.desktopOnly}`} aria-pressed={correctMode} onClick={toggleCorrectMode}>
             {correctMode ? tx("correcting") : tx("correct")}
           </button>
           <button className={`${styles.practiceBtn} ${adjustMode ? styles.practiceBtnActive : ""} ${styles.desktopOnly}`} aria-pressed={adjustMode} onClick={toggleAdjustMode} title="Bar adjust mode (J)">
             {adjustMode ? tx("adjusting") : tx("adjust")}
           </button>
           <button className={`${styles.practiceBtn} ${performanceOpen ? styles.practiceBtnActive : ""}`} aria-expanded={performanceOpen} onClick={() => { setPerformanceOpen((v) => !v); setAdvOpen(false); }}>{lang === "zh" ? <><span className={styles.phoneHide}>演奏</span>分析</> : "Analyze"}</button>
           <details className={styles.moreWrap}>
             <summary className={`${styles.practiceBtn} ${cleanView ? styles.practiceBtnActive : ""}`} title={lang === "zh" ? "更多" : "More"} aria-label={lang === "zh" ? "更多" : "More"}>⋯</summary>
             <div className={styles.moreMenu} onClick={(e) => { if ((e.target as HTMLElement).closest("button")) { const d = e.currentTarget.parentElement as HTMLDetailsElement | null; if (d) d.open = false; } }}>
               <button className={`${styles.practiceBtn} ${correctMode ? styles.practiceBtnActive : ""} ${styles.mobileOnly}`} aria-pressed={correctMode} onClick={toggleCorrectMode}>
                 {correctMode ? tx("correcting") : tx("correct")}
               </button>
               <button className={`${styles.practiceBtn} ${adjustMode ? styles.practiceBtnActive : ""} ${styles.mobileOnly}`} aria-pressed={adjustMode} onClick={toggleAdjustMode} title="Bar adjust mode (J)">
                 {adjustMode ? tx("adjusting") : tx("adjust")}
               </button>
               {dev && <button className={styles.practiceBtn} onClick={() => { setReportOpen(true); setReportMsg(""); }} title={tx("reportTitle")}>{tx("reportIssue")}</button>}
               <button className={`${styles.practiceBtn} ${cleanView ? styles.practiceBtnActive : ""}`} aria-pressed={cleanView} onClick={toggleCleanView}>{tx("cleanView")}</button>
               <button className={`${styles.practiceBtn} ${advOpen ? styles.practiceBtnActive : ""}`} aria-expanded={advOpen} aria-controls="sf-control-panel" onClick={() => setAdvOpen((v) => !v)} title="Panel (M)">{tx("panelBtn")}</button>
             </div>
           </details>
          <span className={styles.practiceHint}>{analysis ? `${analysis.systems.length} ${tx("sysUnit")} · ${barsTotal} ${tx("barUnit")}${lowConfSystems ? ` · ${lowConfSystems}${tx("lowConf")}` : ""}` : tx("waiting")}</span>
        </nav>}

       {chromeOpen && correctMode && <div className={styles.modebar} role="status">
         <span className={styles.modeDot} /> <strong>{tx("correcting")}</strong>
         <span className={styles.modeHint}>{selectedBar ? `${tx("selected")} · p${pageNum} · s${selectedBar.si + 1} · x${Math.round(analysis?.bars[selectedBar.si]?.[selectedBar.bi] ?? 0)}` : tx("correctHint")}</span>
         <button onClick={doUndo} disabled={!undoRef.current.length}>{tx("pieUndo")}</button>
         <button onClick={doRedo} disabled={!redoRef.current.length}>{tx("pieRedo")}</button>
          <button onClick={() => { setCorrectMode(false); setSelectedBar(null); setPie(null); }}>{tx("exitCorrect")}</button>
          {dev && <button onClick={() => { setReportOpen(true); setReportMsg(""); }}>{tx("reportIssue")}</button>}
        </div>}

       {helpOpen && <div className={styles.helpBackdrop} onClick={() => setHelpOpen(false)}>
          <section ref={helpDialogRef} tabIndex={-1} className={styles.helpDialog} role="dialog" aria-modal="true" aria-label={lang === "zh" ? "帮助与快捷键" : "Help and shortcuts"} onClick={(e) => e.stopPropagation()}>
           <header className={styles.helpHero}>
             <div className={styles.helpHeroIcon}>♪</div>
             <div><p className={styles.helpEyebrow}>SCOREFOLLOW GUIDE</p><h2>{lang === "zh" ? "把练习变成一条清晰的路" : "A clearer path through practice"}</h2><p>{lang === "zh" ? "从载入谱面，到节拍器跟随，再到演奏分析，这里是你的快速地图。" : "From loading a score to following the beat and reviewing a take, here is your quick map."}</p></div>
             <button className={styles.helpClose} onClick={() => setHelpOpen(false)} aria-label={tx("close")}>×</button>
           </header>
           <div className={styles.helpBody}>
             <section className={styles.helpQuickStart} aria-labelledby="help-quick-start">
              <h3 id="help-quick-start" className={styles.helpSectionTitle}>{lang === "zh" ? "快速入门" : "Quick start"}</h3>
              <div className={styles.helpCardGrid}>
             <section className={styles.helpCard + " " + styles.helpCardAccent}><span className={styles.helpCardIcon}>▶</span><div><h3>{lang === "zh" ? "开始播放" : "Start playing"}</h3><p>{lang === "zh" ? "谱面载入并显示后，按 P 即可播放, 再按一次暂停; 无音频时走时钟光标。空格只控制节拍器开/关, 与播放互不干扰。" : "Once the score is visible, press P to play and again to pause (clock cursor when no audio). Space toggles only the metronome and never touches playback."}</p><kbd>P</kbd><span className={styles.helpMeta}>{lang === "zh" ? "播放 / 暂停" : "play / pause"}</span></div></section>
              <section className={styles.helpCard}><span className={styles.helpCardIcon}>⌁</span><div><h3>{lang === "zh" ? "跟着节拍练" : "Practice with the beat"}</h3><p>{lang === "zh" ? "右下角 BPM 按钮展开节拍器圆盘，可播放、调速、切换预备拍和音色。闲置 4 秒自动收起；键盘操作时保留展开。完整设置保留循环、拍号等功能。⚙ 设置菜单里的 light/dark 按钮切换夜间模式并记住选择。点击谱面小节可移动起点。" : "Open the bottom-right BPM dial for playback, tempo, count-in and sound. It folds after 4 seconds idle and stays open during keyboard use. Full settings retain loops and meter controls. The light/dark button in the ⚙ settings menu switches and remembers night mode. Click a score measure to move the start."}</p><kbd>← →</kbd><kbd>↑ ↓</kbd><kbd>Space</kbd><span className={styles.helpMeta}>{lang === "zh" ? "小节 / 系统 · 空格节拍器开/关" : "measure / system · Space metronome on/off"}</span></div></section>
             <section className={styles.helpCard}><span className={styles.helpCardIcon}>◌</span><div><h3>{lang === "zh" ? "建立同步" : "Build sync"}</h3><p>{lang === "zh" ? "播放录音时按 B 记录拍点；Backspace 撤回一个点，逗号和句号微调时值。" : "While listening, press B to mark beats. Backspace removes one; comma and period fine-tune duration."}</p><div><kbd>B</kbd><kbd>⌫</kbd><kbd>, .</kbd></div></div></section>
             <section className={styles.helpCard}><span className={styles.helpCardIcon}>✦</span><div><h3>{lang === "zh" ? "查看演奏分析" : "Review your take"}</h3><p>{lang === "zh" ? "打开“演奏分析”，上传练习录音，查看音准、节奏、稳定性与需要回听的小节。" : "Open Analyze and upload a take to see pitch, rhythm, stability, and measures worth revisiting."}</p><span className={styles.helpTag}>{lang === "zh" ? "练习报告" : "practice report"}</span></div></section>
              </div>
             </section>
              <AnalysisHelp lang={lang} />
              <section className={styles.helpShortcuts}><h3>{lang === "zh" ? "更多快捷键" : "More shortcuts"}</h3><div className={styles.shortcutGrid}><span><kbd>F</kbd>{lang === "zh" ? "全屏" : "fullscreen"}</span><span><kbd>M</kbd>{lang === "zh" ? "控制面板" : "panel"}</span><span><kbd>V</kbd>{lang === "zh" ? "干净视图" : "clean view"}</span><span><kbd>L</kbd>{lang === "zh" ? "行光标" : "line cursor"}</span><span><kbd>C</kbd>{lang === "zh" ? "纠错模式" : "correction"}</span><span><kbd>J</kbd>{lang === "zh" ? "调整模式" : "adjust"}</span><span><kbd>P</kbd>{lang === "zh" ? "播放 / 暂停" : "play / pause"}</span><span><kbd>Space</kbd>{lang === "zh" ? "节拍器开 / 关" : "metronome on / off"}</span><span><kbd>Esc</kbd>{lang === "zh" ? "关闭窗口" : "close window"}</span></div></section>
           </div>
           <footer className={styles.helpFooter}><span>{lang === "zh" ? "提示：按钮也可以直接点击，快捷键适合专注演奏时使用。" : "Tip: every shortcut also has a button, so you can stay focused on the music."}</span><button className={styles.practicePlay} onClick={() => setHelpOpen(false)}>{lang === "zh" ? "开始练习" : "Start practicing"}</button></footer>
         </section>
       </div>}

        {tunerOpen && <TunerPanel lang={lang} onClose={() => setTunerOpen(false)} />}
        {reportOpen && <div className={styles.modalBackdrop} onClick={() => setReportOpen(false)}>
          <section className={styles.exportDialog} role="dialog" aria-modal="true" aria-label={tx("reportTitle")} onClick={(e) => e.stopPropagation()}>
            <div className={styles.exportHead}>
              <div><h2>{tx("reportTitle")}</h2>
                <p>{numPages} {tx("pageUnit")} · {correctedPages} {lang === "zh" ? "页已校正" : "corrected pages"} · algo v{ALGO_VERSION} · {pdfBytesRef.current ? lang === "zh" ? "原 PDF 将嵌于 fixed.preload.js" : "source PDF embedded in fixed.preload.js" : lang === "zh" ? "图片谱（无原文件，需另附原图）" : "image score (no source file; attach originals separately)"}</p></div>
              <button className={styles.practiceBtn} onClick={() => setReportOpen(false)} aria-label={tx("close")}>×</button>
            </div>
            <div className={styles.exportActions} style={{ justifyContent: "flex-start" }}>
              <span>{!analysis || !numPages ? "✗" : "✓"} {lang === "zh" ? "已分析" : "Analyzed"}</span>
              <span>{correctMode ? "✗" : "✓"} {tx("exitCorrect")}</span>
              <span>{Object.keys(manualBarsByPage).length > 0 || reportNoChange ? "✓" : "✗"} {lang === "zh" ? "有校正/无需校正" : "Corrected / N/A"}</span>
              <span>{reportConfirmed ? "✓" : "✗"} {lang === "zh" ? "已确认" : "Confirmed"}</span>
              {correctMode && <button className={styles.practiceBtn} onClick={() => { setCorrectMode(false); setSelectedBar(null); setPie(null); }}>{lang === "zh" ? "退出纠错并继续" : "Exit correction & continue"}</button>}
            </div>
            <label className={styles.expertHint} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={reportConfirmed} onChange={(e) => setReportConfirmed(e.target.checked)} />
              <span>{tx("reportConfirmDone")}</span>
            </label>
            <label className={styles.expertHint} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={reportNoChange} onChange={(e) => setReportNoChange(e.target.checked)} />
              <span>{tx("reportNoChangeOpt")}</span>
            </label>
            <textarea rows={3} style={{ width: "100%" }} value={reportNote} onChange={(e) => setReportNote(e.target.value)} placeholder={tx("reportNotePh")} />
            <input style={{ width: "100%" }} value={reportEndpoint} onChange={(e) => setReportEndpoint(e.target.value)} placeholder={tx("reportEndpointPh")} />
            <input style={{ width: "100%" }} type="password" autoComplete="off" value={reportSecret} onChange={(e) => setReportSecret(e.target.value)} placeholder={tx("reportSecretPh")} />
            <p className={styles.expertHint}>{lang === "zh"
              ? "服务器配一次即可（ezmusics shell）：head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ~/sf-report-secret && mkdir -p ~/scorefollow-reports && chmod 700 ~/scorefollow-reports —— 首行字符串填进上面密钥框"
              : "One-time server setup (ezmusics shell): pipe 16 random bytes into ~/sf-report-secret and mkdir ~/scorefollow-reports, then paste the first line into the secret box above"}</p>
            <details>
              <summary className={styles.expertHint}>{lang === "zh" ? "备用：经 GitHub 中转（需 token）" : "Fallback: via GitHub (needs token)"}</summary>
              <input style={{ width: "100%" }} type="password" autoComplete="off" value={reportToken} onChange={(e) => setReportToken(e.target.value)} placeholder={tx("reportTokenPh")} />
              <input style={{ width: "100%" }} value={reportRepo} onChange={(e) => setReportRepo(e.target.value)} placeholder="owner/repo" />
              <div className={styles.exportActions}>
                <button className={styles.practiceBtn} onClick={() => void submitReport()} disabled={reportBusy}>{reportBusy ? "…" : tx("reportSubmit")}</button>
              </div>
            </details>
            {reportMsg && <p className={styles.expertHint}>{reportMsg}</p>}
            <div className={styles.exportActions}>
              <button className={styles.practiceBtn} onClick={() => void downloadReport()} disabled={reportBusy}>{tx("reportDownloadOnly")}</button>
              <button className={styles.practicePlay} onClick={() => void submitToServer()} disabled={reportBusy}>{reportBusy ? "…" : tx("reportServer")}</button>
            </div>
          </section>
        </div>}

        {preloadPreview && <div className={styles.modalBackdrop} onClick={closePreview}>
         <section className={styles.exportDialog} role="dialog" aria-modal="true" aria-label={tx("exportPreview")} onClick={(e) => e.stopPropagation()}
           onKeyDown={(e) => {
             if (e.key !== "Tab") return;
             const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
             if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
             else if (!e.shiftKey && document.activeElement === buttons[buttons.length - 1]) { e.preventDefault(); buttons[0]?.focus(); }
           }}>
           <div className={styles.exportHead}><div><h2>{tx("exportPreview")} · preload.js</h2><p>{numPages} {tx("pageUnit")} · {barsTotal} {tx("barUnit")} · {tapCount} sync · {correctedPages} corrected · {(preloadPreview.bytes / 1024).toFixed(0)} KB</p></div>
             <button ref={previewCloseRef} className={styles.practiceBtn} onClick={closePreview} aria-label={tx("close")}>×</button></div>
           <pre className={styles.exportCode}>{preloadPreview.head}{preloadPreview.truncated ? "\n…(预览已截断；下载与复制包含完整数据)" : ""}</pre>
            <div className={styles.exportActions}>
              <button className={styles.practiceBtn} onClick={() => void copyPreload()}>{lang === "zh" ? "复制完整数据" : "Copy all"}</button>
              <button className={styles.practicePlay} onClick={downloadPreload}>{lang === "zh" ? "下载 .js" : "Download .js"}</button>
            </div>
          </section>
        </div>}

       {/* 相机连拍: 应用内取景, 多张合并为多页谱(拍摄时逐张裁边/纠偏/提亮) */}
       {camOpen && <div className={styles.modalBackdrop} onClick={closeCamera}>
         <section className={styles.exportDialog} role="dialog" aria-modal="true" aria-label={lang === "zh" ? "相机连拍" : "Camera capture"} onClick={(e) => e.stopPropagation()}>
           <div className={styles.exportHead}>
             <div><h2>📷 {lang === "zh" ? "相机连拍" : "Camera capture"}</h2>
               <p>{lang === "zh" ? "逐页拍摄, 完成后合并为多页谱(已拍自动裁边/纠偏/提亮)" : "Shoot page by page, combine into a multi-page score on done"}</p></div>
             <button className={styles.practiceBtn} onClick={closeCamera} aria-label={tx("close")}>×</button>
           </div>
           <div className={styles.camWrap}>
             <video ref={attachCamVideo}
               playsInline muted autoPlay className={styles.camVideo}
               onPlaying={() => setCamPaused(false)} onPause={() => setCamPaused(true)}
               onClick={(e) => { const v = e.target as HTMLVideoElement; v.play().then(() => setCamPaused(false)).catch(() => {}); }} />
             {camPaused && !camBusy && (
               <button className={styles.camPlayOverlay}
                 onClick={() => { const v = camVideoRef.current; if (v) v.play().then(() => setCamPaused(false)).catch(() => setStatus("相机启动失败, 请检查权限")); }}>
                 ▶ {lang === "zh" ? "点击启动取景" : "Tap to start preview"}
               </button>
             )}
           </div>
           {camBusy && <p className={styles.expertHint}>{lang === "zh" ? "正在打开相机…" : "Opening camera…"}</p>}
           {camShots.length > 0 && <div className={styles.camThumbs}>
             {camShots.map((u, i) => (
               <span key={`${i}-${u.slice(-8)}`} className={styles.camThumb}>
                 {/* eslint-disable-next-line @next/next/no-img-element */}
                 <img src={u} alt={`p${i + 1}`} />
                 <button onClick={() => removeShot(i)} aria-label={lang === "zh" ? `删除第${i + 1}页` : `Remove page ${i + 1}`}>×</button>
               </span>
             ))}
           </div>}
           <div className={styles.exportActions}>
             <button className={styles.practiceBtn} onClick={takeShot}>{lang === "zh" ? "拍摄" : "Shoot"}</button>
             <button className={styles.practicePlay} disabled={!camShots.length} onClick={() => void finishShots()}>{lang === "zh" ? `完成(${camShots.length})` : `Done (${camShots.length})`}</button>
           </div>
         </section>
       </div>}

      {/* pie 接管全部纠错操作, 顶部 correctbar 已移除 */}

      {chromeOpen && correctMode && pie && selectedBar && (
         <div className={styles.pie} style={{ left: pie.x, top: pie.y }} role="group" aria-label={tx("measureOps")}>
          <div className={styles.pieDisc} onClick={() => setPie(null)} />
          {([
            { label: tx("pieSplit"), title: "split: 从中间拆开 (S)", ang: -90, fn: pieAction(splitSelectedMeasure, true) },
            { label: tx("pieMergeR"), title: "merge right: 与右侧小联合并 (D)", ang: -45, fn: pieAction(() => mergeSelectedMeasure("right"), true) },
            { label: tx("pieDelete"), title: "delete: 删除选中线 (Delete)", ang: 0, fn: pieAction(deleteSelectedBar, false), tone: "danger" },
            { label: tx("pieRedo"), title: "redo", ang: 45, fn: pieAction(doRedo, false) },
            { label: tx("pieAllPages"), title: "复制本页校正到全部页", ang: 90, fn: pieAction(copyCorrectionsToAll, false) },
            { label: tx("pieReset"), title: "恢复自动识别", ang: 135, fn: pieAction(resetPageCorrections, false) },
            { label: tx("pieUndo"), title: "undo", ang: 180, fn: pieAction(doUndo, false) },
            { label: tx("pieMergeL"), title: "merge left: 与左侧小联合并 (A)", ang: -135, fn: pieAction(() => mergeSelectedMeasure("left"), true) },
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
            <button onClick={() => setPie(null)} aria-label={tx("close")}>×</button>
          </div>
        </div>
      )}

       <div className={styles.workspace}>
        {performanceOpen && <PerformancePanel cloudBase={account.user ? BASE : ""} lang={lang} dev={dev} pdfMeasures={barsTotal} pdfName={pdfName} pdfBytes={() => pdfBytesRef.current}
          youtubeLink={mediaKind === "youtube" ? mediaURL : ""}
          captureYouTube={async ({ link, startSec, lengthSec, onProgress }) => {
            // Ask for tab audio first, while the click still counts as a user gesture.
            const stream = await captureTabAudio();
            try {
              const want = link ? parseYouTube(link) : null;
              if (link && !want) throw new Error(lang === "zh" ? "无法识别的 YouTube 链接" : "Not a YouTube link");
              const cur = mediaRef.current;
              if (want && !(cur instanceof YouTubeMedia && cur.id === want.id)) loadYouTube(link!);
              let media: YouTubeMedia | null = null;
              for (let i = 0; i < 100 && !media; i++) {
                const m = mediaRef.current;
                if (m instanceof YouTubeMedia && m.isReady && (!want || m.id === want.id)) media = m;
                else await new Promise((r) => setTimeout(r, 200));
              }
              if (!media) throw new Error(lang === "zh" ? "YouTube 播放器未就绪" : "YouTube player not ready");
              const rec = await recordPlayback(stream, media, startSec, lengthSec, { onProgress });
              return { ...rec, name: `YouTube ${media.id} @${Math.round(startSec)}s` };
            } finally {
              stream.getTracks().forEach((t) => t.stop());
            }
          }}
          getSyncedAudio={() => {
            if (!mediaURL) return null;
            doPause();
            // YouTube: the panel gets the audio excerpt from the analysis service.
            if (mediaKind === "youtube") {
              const yt = parseYouTube(mediaURL);
              if (!yt) return null;
              return { url: "", youtube: yt.id, name: mediaName, measureCount: barsTotal,
                markers: wijzerRef.current.times.map((entry) => ({ measure: entry.mix + 1, audioSec: entry.t })) };
            }
            return { url: mediaURL, name: mediaName || "Synced audio", measureCount: barsTotal,
              markers: wijzerRef.current.times.map((entry) => ({ measure: entry.mix + 1, audioSec: entry.t })) };
          }}
          onApplyMeasureSync={(markers) => {
            const w = wijzerRef.current;
            if (!w.measures.length) return lang === "zh" ? "谱面尚未分析出小节" : "Score measures not analyzed yet";
            const entries = markers
              .filter((m) => Number.isInteger(m.measure) && m.measure >= 1 && Number.isFinite(m.audioSec) && m.audioSec >= 0)
              .map((m) => ({ t: Math.round(m.audioSec * 1000) / 1000, mix: m.measure - 1 }))
              .filter((e) => e.mix < w.measures.length);
            if (entries.length < 2) return lang === "zh" ? "自动同步点不足" : "Not enough auto sync points";
            for (let i = 1; i < entries.length; i++) {
              if (!(entries[i].t > entries[i - 1].t)) return lang === "zh" ? "自动同步点时间不递增" : "Auto sync points are not increasing";
            }
            w.loadTimes(entries);
            setTapCount(entries.length);
            return null;
          }}
          onFollowTake={({ name, url: takeUrl, blob, starts, onsets, meta }) => {
            const w = wijzerRef.current;
            if (!w.measures.length) return lang === "zh" ? "谱面尚未分析出小节" : "Score measures not analyzed yet";
            const entries = (starts ?? [])
              .filter((s) => Number.isInteger(s.measure) && s.measure >= 1 && Number.isFinite(s.startSec) && s.startSec >= 0)
              .map((s) => ({ t: Math.max(0, Math.round((s.startSec - FOLLOW_LEAD_SEC) * 1000) / 1000), mix: s.measure - 1 }))
              .filter((e) => e.mix < w.measures.length);
            if (entries.length < 2) return lang === "zh" ? "可用小节起点不足" : "Not enough usable measure starts";
            for (let i = 1; i < entries.length; i++) {
              if (!(entries[i].t > entries[i - 1].t)) return lang === "zh" ? "小节起点时间不递增" : "Measure starts are not increasing";
            }
            // Clicks land on the take's measured onsets (exact played time, no lead).
            const onsetMap = new Map<number, { frac: number; t: number }[]>();
            for (const o of onsets ?? []) {
              const mix = o.measure - 1;
              if (!Number.isFinite(o.sec) || !Number.isFinite(o.frac) || mix < 0 || mix >= w.measures.length) continue;
              onsetMap.set(mix, [...(onsetMap.get(mix) ?? []), { frac: o.frac, t: o.sec }].sort((a, b) => a.frac - b.frac));
            }
            // The panel revokes its take URLs when it closes; play (and export) from our own URL of the take.
            let url = takeUrl;
            if (blob) {
              if (followUrlRef.current) URL.revokeObjectURL(followUrlRef.current);
              url = followUrlRef.current = URL.createObjectURL(blob);
            }
            setMediaURL(url);
            setMediaName(name);
            setMediaKind("audio");
            parkLegacyShade();
            w.loadTimes(entries, onsetMap);
            setTapCount(entries.length);
            setFollowMeta({ name, ...meta });
            // A bar loop keeps its bars and is re-timed for the new take.
            if (takeLoopRef.current.on) applyTakeLoop(takeLoopRef.current);
            if (!showCursor) return { warning: lang === "zh"
              ? "光标覆盖层已关闭，播放时看不到蓝色阴影：请在“面板”工作台打开“光标”"
              : "The cursor overlay is off, so no shade will show during playback. Enable “Cursor” in the Panel workspace." };
            return null;
          }}
         onJump={(measure) => placeCursor(measure - 1)} onClose={() => setPerformanceOpen(false)} />}
        {accountOpen && <AccountDialog lang={lang === "zh" ? "zh" : "en"} base={BASE} state={account} onState={setAccount} onClose={() => setAccountOpen(false)} />}
        {videoOpen && <VideoExportDialog lang={lang === "zh" ? "zh" : "en"} source={videoSource()} onClose={() => setVideoOpen(false)} />}
        {chromeOpen && advOpen && (
          <aside id="sf-control-panel" className={`${styles.advpanel} ${styles.controlPanel}`} aria-label={tx("panelBtn")}>
            <div className={styles.pcardHead}><span>{lang === "zh" ? "练习工作台" : "Practice workspace"}</span><button onClick={() => setAdvOpen(false)} aria-label={tx("closePanel")}>×</button></div>
          <div className={styles.pcard}>
             <div className={styles.pcardTitle}><span className={styles.stepNum} aria-hidden="true">1</span><span>{tx("viewSection")}</span></div>
            <div className={styles.pillRow}>
              {([
                 [showSystems, setShowSystems, "systemOverlay"],
                 [showBars, setShowBars, "barOverlay"],
                 [showCursor, setShowCursor, "cursorOverlay"],
                 [showLowConf, setShowLowConf, "lowOverlay"],
               ] as [boolean, (v: boolean) => void, string][]).map(([v, set, label]) => (
                 <label key={label} className={`${styles.pill} ${v ? styles.pillOn : ""}`}><input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {tx(label)}</label>
               ))}
               <label className={`${styles.pill} ${opt.lncsr === 1 ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.lncsr === 1} onChange={(e) => applyAdv("lncsr", e.target.checked ? 1 : 0)} /> {tx("lineCursor")}</label>
               <label className={`${styles.pill} ${cleanView ? styles.pillOn : ""}`}><input type="checkbox" checked={cleanView} onChange={() => toggleCleanView()} /> {tx("cleanView")} (V)</label>
               <label className={`${styles.pill} ${correctMode ? styles.pillOn : ""}`}><input type="checkbox" checked={correctMode} onChange={(e) => { setCorrectMode(e.target.checked); setSelectedBar(null); setPie(null); }} /> {tx("correct")}</label>
              {dev && <label className={`${styles.pill} ${diagnosticMode ? styles.pillOn : ""}`}><input type="checkbox" checked={diagnosticMode} onChange={(e) => { const on = e.target.checked; if (on && cleanView) toggleCleanView(); if (on) { setShowSystems(true); setShowBars(true); setShowCursor(true); setShowLowConf(true); } setDiagnosticMode(on); }} /> {tx("diagnostics")}</label>}
              </div>
              {dev && <p className={styles.expertHint}>{lang === "zh" ? "诊断视图 = 全开上方四个覆盖层 + 底栏技术信息(版本/谱距/置信/耗时); 覆盖层只跟四个勾选走" : "Diagnostics = all four overlays above on + technical footer; overlays follow only the four checkboxes"}</p>}
            </div>
          {dev && <div className={styles.pcard}>
             <div className={styles.pcardTitle}><span className={styles.stepNum} aria-hidden="true">2</span><span>{tx("modeSection")}</span></div>
            <div className={styles.pillRow}>
             {(["fast", "balanced", "scan"] as AnalysisProfileName[]).map((name) => (
                <label key={name} className={`${styles.pill} ${profileName === name ? styles.pillOn : ""}`}><input type="radio" name="profile" checked={profileName === name} onChange={() => applyProfile(name)} /> {name}</label>
              ))}
             </div>
             <button className={styles.pfileBtn} onClick={resetAdvDefaults}>{tx("resetDefaults")}</button>
             {Object.keys(advsRef.current).length > 0 && (
               <p className={styles.expertHint}>
                 {lang === "zh"
                   ? `p${Object.keys(advsRef.current).sort().join("、p")} 有独立参数(在他页调参不影响这些页) · 当前 p${pageNum}${advsRef.current[pageNum] ? "(本页已调)" : "(跟随全局)"}`
                   : `p${Object.keys(advsRef.current).sort().join(", p")} have per-page params · current p${pageNum}${advsRef.current[pageNum] ? " (tuned)" : " (global)"}`}
                 {advsRef.current[pageNum] && <button className={styles.pfileBtn} onClick={clearPageAdv}>{lang === "zh" ? "清除本页参数" : "Clear this page"}</button>}
               </p>
             )}
           </div>}
          {/* 小节/阈值参数已并入下方高级(开发者)折叠区 */}
          <div className={styles.pcard}>
             <div className={styles.pcardTitle}><span className={styles.stepNum} aria-hidden="true">{dev ? 3 : 2}</span><span>{tx("fileSection")}</span></div>
            <button className={styles.pfileBtn} onClick={saveTiming}>{tx("saveTiming")}</button>
            {dev && <button className={styles.pfileBtn} onClick={() => void savePreload()}>{tx("savePreload")}</button>}
            {dev && <div className={styles.pillRow}>
              <input
                style={{ width: "100%" }}
                value={scorePath}
                onChange={(e) => setScorePath(e.target.value)}
                placeholder={lang === "zh" ? "公开路径：Score/书名/曲名（空=自动，发布存 fixed/auto/原文件三件套）" : "Public path: Score/book/piece (empty=auto; publishes fixed/auto/original bundle)"}
              />
            </div>}
            <div className={styles.pillRow}>
              {dev && <button className={styles.pfileBtn} disabled={scoreBusy} onClick={() => void publishToScore()}>
                {scoreBusy ? "…" : lang === "zh" ? "推送到 Score" : "Publish to Score"}
              </button>}
              <a className={styles.pfileBtn} href={`${BASE}/scores/`}>
                {lang === "zh" ? "公开谱库" : "Library"}
              </a>
            </div>
            {scoreMsg && <p role="status" className={`${styles.statusChip} ${scoreMsgTone === "error" ? styles.statusChipError : scoreMsgTone === "success" ? styles.statusChipSuccess : ""}`}>{scoreMsg}</p>}
            <label className={styles.pfileBtn}>{tx("loadTiming")} <input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadTiming(f); }} /></label>
            {dev && <label className={styles.pfileBtn}>{tx("loadPreload")} <input type="file" accept=".js" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadPreload(f); }} /></label>}
            {dev && <label className={styles.pfileBtn} title={lang === "zh" ? "载入 scripts/homr-gate.py 生成的门数据(本地 HoMR 音符模板, 否决符干)" : "Load gate data from scripts/homr-gate.py (local HoMR note templates, veto stems)"}>{lang === "zh" ? "载入门数据" : "Load gate"} <input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadHomrGate(f); e.target.value = ""; }} /></label>}
             <div className={styles.pillRow}>
               <label className={`${styles.pill} ${synbox ? styles.pillOn : ""}`}><input type="checkbox" checked={synbox} onChange={(e) => setSynbox(e.target.checked)} /> {tx("enableSync")}</label>
               {dev && <><label className={`${styles.pill} ${embedMetro ? styles.pillOn : ""}`}><input type="checkbox" checked={embedMetro} onChange={(e) => setEmbedMetro(e.target.checked)} /> +metro</label>
               <label className={`${styles.pill} ${((opt as unknown as Record<string, number>).wpdf ?? 1) !== 0 ? styles.pillOn : ""}`}><input type="checkbox" checked={((opt as unknown as Record<string, number>).wpdf ?? 1) !== 0} onChange={(e) => applyAdv("wpdf", e.target.checked ? 1 : 0)} title="preload.js 是否内嵌 pdf_data base64(关=只存 metric/timing, 体积小)" /> +PDF</label></>}
             </div>
             {dev && <p className={styles.expertHint}>{lang === "zh" ? `${numPages} 页 · ${correctedPages} 页校正 · ${tapCount} 个同步点 · PDF ${((opt as unknown as Record<string, number>).wpdf ?? 1) !== 0 ? "包含" : "不包含"}` : `${numPages} pages · ${correctedPages} corrected · ${tapCount} sync points · PDF ${((opt as unknown as Record<string, number>).wpdf ?? 1) !== 0 ? "included" : "excluded"}`}</p>}
          </div>
          {dev && <details className={styles.pcard} open={expertOpen} onToggle={(e) => { const o = (e.target as HTMLDetailsElement).open; setExpertOpen(o); try { localStorage.setItem("sf-expert-open", o ? "1" : "0"); } catch { /* ignore */ } }}>
             <summary className={styles.pcardTitle}><span className={styles.stepNum} aria-hidden="true">4</span><span>{tx("expertSection")} · {tx("expertDev")}</span><span className={styles.pcardCaret} aria-hidden="true">›</span></summary>
             <p className={styles.expertHint}>{lang === "zh" ? "仅在识别困难时调整；修改后会重新分析谱面。" : "Adjust only when recognition needs tuning; changes rerun analysis."}</p>
             <div className={styles.pcardTitle}>{tx("timingSection")}</div>
             {(["drmpl", "drmpl2", "dx"] as const).map((k) => (
               <label key={`${k}-${advNonce}`} className={styles.stepper}>{k}
                 <input type="number" min={ADV_RANGES[k][0]} max={ADV_RANGES[k][1]} step={ADV_STEPS[k]}
                   defaultValue={opt[k] as number}
                   onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) applyAdv(k, v); }}
                   onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { applyAdv(k, v); e.target.value = String(opt[k] as number); } }}
                   onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
               </label>
             ))}
            <label className={styles.stepper}>pagewd <input type="number" min={600} max={3000} step={50} value={opt.pagewd} onChange={(e) => applyAdv("pagewd", Number(e.target.value) || 1000)} /></label>
            <label className={styles.stepper}>fixwd <input type="number" min={0} step={100} value={opt.fixwd} onChange={(e) => applyAdv("fixwd", Number(e.target.value) || 0)} /></label>
            <div className={styles.pcardTitle}><span>{tx("barsSection")}</span></div>
            <div className={styles.pillRow}>
              <label className={`${styles.pill} ${opt.sysprf ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.sysprf ? true : false} onChange={(e) => applyAdv("sysprf", e.target.checked ? 1 : 0)} /> sysprf</label>
              <label className={`${styles.pill} ${opt.onestf ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.onestf ? true : false} onChange={(e) => applyAdv("onestf", e.target.checked ? 1 : 0)} /> onestf</label>
              <label className={`${styles.pill} ${opt.eerst ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.eerst ? true : false} onChange={(e) => applyAdv("eerst", e.target.checked ? 1 : 0)} /> eerst</label>
              <label className={`${styles.pill} ${(opt.hd ?? 1) ? styles.pillOn : ""}`}><input type="checkbox" checked={(opt.hd ?? 1) ? true : false} onChange={(e) => applyAdv("hd", e.target.checked ? 1 : 0)} title={lang === "zh" ? "高清渲染: 显示按屏幕超采样, 分析分辨率不变" : "HiDPI render: display upsampled, analysis unchanged"} /> hd</label>
              <label className={`${styles.pill} ${(opt.deskew ?? 0) ? styles.pillOn : ""}`}><input type="checkbox" checked={(opt.deskew ?? 0) ? true : false} onChange={(e) => applyAdv("deskew", e.target.checked ? 1 : 0)} title={lang === "zh" ? "偏斜校正: 扫描摆不正自动转正（默认关：转正会把细竖线碎成楼梯）" : "Deskew: auto-straighten tilted scans (default off: rotation fragments thin verticals)"} /> deskew</label>
              <label className={`${styles.pill} ${(opt.notemask ?? 0) ? styles.pillOn : ""}`}><input type="checkbox" checked={(opt.notemask ?? 0) ? true : false} onChange={(e) => applyAdv("notemask", e.target.checked ? 1 : 0)} title={lang === "zh" ? "音符优先: 先抠符头符干再认小节线(实验)" : "Notes first: mask noteheads/stems before bar detection (experimental)"} /> notemask</label>
              <label className={`${styles.pill} ${(opt.widrescue ?? 0) ? styles.pillOn : ""}`}><input type="checkbox" checked={(opt.widrescue ?? 0) ? true : false} onChange={(e) => applyAdv("widrescue", e.target.checked ? 1 : 0)} title={lang === "zh" ? "宽度先验: 过宽小节低阈抢救淡线(实验)" : "Width prior: rescue faint bars in wide gaps (experimental)"} /> widrescue</label>
              <label className={`${styles.pill} ${(opt.homrgate ?? 1) ? styles.pillOn : ""}`}><input type="checkbox" checked={(opt.homrgate ?? 1) ? true : false} onChange={(e) => applyAdv("homrgate", e.target.checked ? 1 : 0)} title={lang === "zh" ? `HoMR 音符门: 有门数据时否决符干(只否决不新增)${homrGateInfo ? ` · ${homrGateInfo}` : " · 当前无门数据"}` : `HoMR note gate: veto stems when gate data present (veto-only)${homrGateInfo ? ` · ${homrGateInfo}` : " · no gate data"}`} /> homrgate{homrGateInfo ? "·" : ""}</label>
            </div>
            <label className={styles.stepper}>skipn <input type="number" min={-5} max={5} step={1} value={opt.skipn} title={lang === "zh" ? ">0 去掉整谱开头 N 个系统(封面/标题, 只动首个有系统页); <0 去掉整谱末尾 |N| 个系统(它曲/demo, 只动末个有系统页)" : "score-level: positive drops first N systems of first content page; negative drops last |N| of last content page"} onChange={(e) => applyAdv("skipn", Number(e.target.value))} /></label>
            <label className={styles.stepper}>seln <input type="number" min={0} max={9} value={opt.seln} onChange={(e) => applyAdv("seln", Number(e.target.value))} /></label>
            <div className={styles.pcardTitle}><span>{lang === "zh" ? "阈值(原版三阈值)" : "Thresholds"}</span></div>
            {([
              ["zwgrens", "blackThresh"],
              ["voorna", "beforeAfter"],
              ["mtdrmpl", "barlineThresh"],
            ] as const).map(([k, label]) => (
              <label key={`${k}-${advNonce}`} className={styles.stepper}>{tx(label)}({k})
                <input type="number" min={ADV_RANGES[k][0]} max={ADV_RANGES[k][1]} step={ADV_STEPS[k]}
                  defaultValue={opt[k] as number}
                  title={lang === "zh" ? "只记当前页, 整谱重分析但各页保留已调参数" : "Saved for current page only; other tuned pages keep theirs"}
                  onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) applyAdv(k, v); }}
                  onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { applyAdv(k, v); e.target.value = String(opt[k] as number); } }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              </label>
            ))}
            <label className={styles.stepper}>cropx <input type="number" min={0} value={opt.cropx} onChange={(e) => applyAdv("cropx", Number(e.target.value))} /></label>
             <label className={`${styles.pill} ${opt.annot === 1 ? styles.pillOn : ""}`}><input type="checkbox" checked={opt.annot === 1} onChange={(e) => applyAdv("annot", e.target.checked ? 1 : 0)} /> {tx("annotate")}</label>
          </details>}
         </aside>
       )}

      <div className={styles.mainarea}>
      {mediaURL && mediaKind === "video" && (
        <video className={styles.mediaStrip} ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls onPlay={() => { syncMediaPlaying(); }} onPause={() => { doPause(); }} onEnded={() => { doPause(); }} onTimeUpdate={(e) => { if (playing && !e.currentTarget.paused) { const c = followAt(now()); if (c) applyFollowCursor(c); } }} />
      )}
      {mediaURL && mediaKind === "youtube" && (() => {
        const yt = parseYouTube(mediaURL);
        return yt && <YouTubeStrip className={styles.mediaStrip} id={yt.id} start={yt.start}
          onMedia={(m) => {
            if (m) mediaRef.current = m;
            else if (mediaRef.current instanceof YouTubeMedia) mediaRef.current = null;
          }}
          onReady={() => setStatus(`YouTube ${yt.id} ✓`)}
          onPlay={() => { syncMediaPlaying(); }} onPause={() => { doPause(); }} onEnded={() => { doPause(); }}
          onError={(code) => {
            doPause();
            // 101/150/152: the owner disabled embedding, or YouTube wants a sign-in (bot check).
            setStatus(code === 101 || code === 150 || code === 152
              ? `YouTube 拒绝在此播放(视频禁止嵌入或需要登录) / YouTube refused playback here (embedding disabled or sign-in required) [${code}]`
              : code === -1 ? "YouTube 播放器载入失败(网络?) / YouTube player failed to load"
              : `YouTube 错误 ${code}: 视频不存在或不可用 / video unavailable`);
          }} />;
      })()}
      {mediaURL && mediaKind === "audio" && (
        <audio className={styles.mediaStrip} ref={(el) => { mediaRef.current = el; }} src={mediaURL} controls onPlay={() => { syncMediaPlaying(); }} onPause={() => { doPause(); }} onEnded={() => { doPause(); }} onTimeUpdate={(e) => { if (playing && !e.currentTarget.paused) { const c = followAt(now()); if (c) applyFollowCursor(c); } }} />
      )}

        <div
         id="notation"
         ref={notationRef}
         className={styles.notation}
         onScroll={onScoreScroll}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const fs = e.dataTransfer?.files;
          if (!fs || !fs.length) return;
          const all = [...fs];
          const pdf = all.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
          if (pdf) { void onPdfFile(pdf); return; }
          const imgs = all.filter((f) => f.type.startsWith("image/"));
          if (imgs.length) void onImageFile(imgs);
        }}
        onClick={onScoreClick}
        onDoubleClick={onScoreDoubleClick}
        onContextMenu={onNotationContextMenu}
        onPointerDown={onNotationPointerDown}
        onPointerMove={onNotationPointerMove}
        onPointerUp={onNotationPointerUp}
        onPointerCancel={cancelLongPress}
        style={correctMode ? { WebkitTouchCallout: "none", userSelect: "none" } : undefined}
      >
         <div ref={stackRef} style={{ position: "relative", width: "100%" }}>
         <div ref={pagesHostRef} />
         {correctMode && touchPos && analysis && (
           <div aria-hidden="true" style={{
             position: "absolute", pointerEvents: "none", zIndex: 5,
             left: `${(touchPos.x / (analysis.pageW || 1)) * 100}%`,
             top: `${(touchPos.y / (analysis.pageH || 1)) * 100}%`,
             width: 34, height: 34, transform: "translate(-50%, -50%)",
           }}>
             <div style={{ position: "absolute", left: 16, top: 2, width: 2, height: 30, background: "rgba(0,120,255,0.9)" }} />
             <div style={{ position: "absolute", left: 2, top: 16, width: 30, height: 2, background: "rgba(0,120,255,0.9)" }} />
             <div style={{ position: "absolute", left: 7, top: 7, width: 20, height: 20, borderRadius: "50%", border: "2px solid rgba(0,120,255,0.9)" }} />
           </div>
         )}
          {!analysis && <div className={styles.emptyScore} data-drag={dragActive ? "true" : "false"}><span aria-hidden="true">♬</span><h1>{tx("noPdfHint")}</h1><p>{tx("emptyDrop")}</p><button className={styles.practicePlay} onClick={() => pdfInputRef.current?.click()}>{tx("loadPdf")}</button><div className={styles.emptyActions}><button className={styles.tbBtn} onClick={() => imgInputRef.current?.click()}>{tx("loadImage")}</button><button className={styles.tbBtn} onClick={() => void openCamera()}>{tx("takePhoto")}</button></div><ol className={styles.emptySteps}><li>{tx("step1")}</li><li>{tx("step2")}</li><li>{tx("step3")}</li></ol></div>}
         {analysis && pageOffsetsRef.current.slice(1).map((off) => <div key={off.page} className={styles.pageBreak} style={{ top: `${off.y / analysis.pageH * 100}%` }} aria-hidden="true">{lang === "zh" ? `第 ${off.page} 页` : `Page ${off.page}`}</div>)}
         {analysis && (
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: correctMode ? "auto" : "none" }} viewBox={`0 0 ${analysis.pageW} ${analysis.pageH}`} preserveAspectRatio="none">
             {showSystems && !cleanView && analysis.systems.flatMap((s, si) => {
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
             {(showBars || correctMode) && (!cleanView || correctMode) && (analysis.bars.flatMap((b, si) => {
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
        {(takeLoop.on || takeLoopMark === 2) && wijzerRef.current.measures.slice(takeLoop.from, (takeLoopMark === 2 ? takeLoop.from : takeLoop.to) + 1).map((m, i) => (
          <div key={`tl${i}`} aria-hidden="true" style={{
            position: "absolute", pointerEvents: "none", borderRadius: 6,
            border: "2px dashed rgba(234,88,12,0.8)", background: "rgba(251,146,60,0.07)",
            left: `${(m.x / (analysis?.pageW || 1)) * 100}%`,
            top: `${(m.y / (analysis?.pageH || 1)) * 100}%`,
            width: `${(m.w / (analysis?.pageW || 1)) * 100}%`,
            height: `${(m.h / (analysis?.pageH || 1)) * 100}%`,
          }} />
        ))}
        {showCursor && cursor && (
          <div className="demaat" style={{
            position: "absolute",
            // 与旧节拍器 sga-shade 蓝色默认保持一致 (metro-engine.js applyShadeStyle blue/opacity 0.28)。
            background: "linear-gradient(180deg,rgba(0,224,255,0.28),rgba(0,150,255,0.160))",
            boxShadow: "0 0 16px 3px rgba(0,200,255,0.40),inset 0 0 10px rgba(255,255,255,0.22)",
            border: "1.5px solid rgba(120,235,255,0.65)",
            borderRadius: 9,
            mixBlendMode: "multiply",
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
      </div>

       <footer className={styles.statusbar}>
         <span className={styles.statusmsg} role="status" aria-live="polite" data-testid="score-load-status" data-phase={scorePhase} data-has-score={analysis ? "true" : "false"}>{status}{/* 纯 CSS spinner：仅 loading/recognizing 可见，其余阶段仍在 DOM 但隐藏；状态由 role=status 文本播报，spinner aria-hidden 不重复打扰读屏 */}<span className={styles.loadSpin} data-active={scorePhase === "loading" || scorePhase === "recognizing"} aria-hidden="true" /></span>
         {analysis && <span className={styles.statusFacts}>
           <span>{lang === "zh" ? `第 ${pageNum}/${numPages} 页` : `Page ${pageNum}/${numPages}`}</span>
           <span>{cursorInfo || `${barsTotal} ${tx("barUnit")}`}</span>
           {lowConfSystems > 0 && <span className={styles.statusWarning}>{lowConfSystems} {tx("lowConf")}</span>}
           {correctedPages > 0 && <span>{correctedPages} {lang === "zh" ? "页已校正" : "corrected pages"}</span>}
           {isManual && <span aria-label="manual corrections">✓</span>}
           <span>{tapCount} sync</span>
         </span>}
         {dev && diagnosticMode && analysis && <span className={styles.statusTechnical}>v{ALGO_VERSION} · spatium {analysis.spatium.toFixed(1)}px · conf {confRange} · {analysis.elapsedMs}ms</span>}
       </footer>

    </main>
  );
}
