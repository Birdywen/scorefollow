// YouTube as a media source, after synpdf's yubvid player (rev194: yubApiReady / setPlayer / yubchk).
// YouTubeMedia wraps the IFrame API player in the small part of HTMLMediaElement the page uses
// (currentTime, paused, playbackRate, play, pause), so follow/sync/loop code works unchanged.

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseStart(v: string | null): number {
  if (!v) return 0;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

/** Video id (+ start seconds) from a bare 11-char id or any common YouTube URL form. */
export function parseYouTube(input: string): { id: string; start: number } | null {
  const s = input.trim();
  if (ID_RE.test(s)) return { id: s, start: 0 };
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] || null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (["embed", "shorts", "live", "v", "e"].includes(parts[0])) id = parts[1] || null;
  }
  if (!id || !ID_RE.test(id)) return null;
  return { id, start: parseStart(u.searchParams.get("t") || u.searchParams.get("start")) };
}

export function youTubeUrl(id: string, start = 0): string {
  return `https://youtu.be/${id}${start > 0 ? `?t=${Math.round(start)}` : ""}`;
}

/* Minimal IFrame API types (no @types/youtube in this repo). */
type YTPlayer = {
  getCurrentTime(): number; getPlayerState(): number; seekTo(t: number, ahead: boolean): void;
  playVideo(): void; pauseVideo(): void; stopVideo(): void; setPlaybackRate(r: number): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void; destroy(): void;
};
type YTNamespace = { Player: new (el: HTMLElement, o: Record<string, unknown>) => YTPlayer };
declare global { interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void } }

let apiPromise: Promise<YTNamespace> | null = null;
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); if (window.YT) resolve(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error("YouTube API failed to load")); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

// YT.PlayerState
const ENDED = 0, PLAYING = 1, PAUSED = 2, BUFFERING = 3, CUED = 5;

export type YouTubeHandlers = {
  onReady?: () => void; onPlay?: () => void; onPause?: () => void; onEnded?: () => void;
  onError?: (code: number) => void;
};

export class YouTubeMedia {
  readonly isYouTube = true;
  private p: YTPlayer | null = null;
  private ready = false;
  private rate = 1;
  private cuedAt: number;
  private gone = false;
  private playWhenReady = false;
  private failed: number | null = null;
  private h: () => YouTubeHandlers;

  constructor(host: HTMLElement, readonly id: string, start: number, h: () => YouTubeHandlers) {
    this.cuedAt = start;
    this.h = h;
    loadYouTubeApi().then((YT) => {
      if (this.gone) return;
      this.p = new YT.Player(host, {
        videoId: id, width: "100%", height: "100%",
        playerVars: { start: Math.floor(start), playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            this.ready = true;
            this.p?.setPlaybackRate(this.rate);
            if (Math.floor(this.cuedAt) !== Math.floor(start)) this.p?.cueVideoById({ videoId: id, startSeconds: this.cuedAt });
            h().onReady?.();
            if (this.playWhenReady) { this.playWhenReady = false; this.p?.playVideo(); }
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === PLAYING) { this.p?.setPlaybackRate(this.rate); h().onPlay?.(); }
            else if (e.data === PAUSED) h().onPause?.();
            else if (e.data === ENDED) h().onEnded?.();
          },
          onError: (e: { data: number }) => { this.failed = e.data; this.playWhenReady = false; h().onError?.(e.data); },
        },
      });
    }).catch(() => { this.failed = -1; h().onError?.(-1); });
  }

  get isReady(): boolean { return this.ready; }

  private state(): number { return this.ready && this.p ? this.p.getPlayerState() : -1; }

  get currentTime(): number {
    const s = this.state();
    // Unstarted/cued players report 0; keep the cue point so the cursor doesn't jump to the start.
    if (s === -1 || s === CUED) return this.cuedAt;
    return this.p!.getCurrentTime();
  }
  set currentTime(t: number) {
    const s = this.state();
    if (!this.ready) { this.cuedAt = t; return; }
    // seekTo on a cued video starts playback; re-cue instead (synpdf skips seek when state==5).
    if (s === -1 || s === CUED) { this.cuedAt = t; this.p!.cueVideoById({ videoId: this.id, startSeconds: t }); }
    else this.p!.seekTo(t, true);
  }
  get paused(): boolean { const s = this.state(); return s !== PLAYING && s !== BUFFERING; }
  get playbackRate(): number { return this.rate; }
  set playbackRate(r: number) {
    this.rate = Math.min(2, Math.max(0.25, r));
    if (this.ready) this.p!.setPlaybackRate(this.rate);
  }
  play(): Promise<void> {
    // YouTube reports an error once; repeat it on later play attempts (async, after the caller's own state update).
    if (this.failed !== null) { const code = this.failed; setTimeout(() => this.h().onError?.(code), 0); return Promise.resolve(); }
    if (!this.ready) { this.playWhenReady = true; return Promise.resolve(); }
    this.p!.playVideo();
    return Promise.resolve();
  }
  pause(): void { this.playWhenReady = false; if (this.ready && !this.paused) this.p!.pauseVideo(); }
  destroy(): void { this.gone = true; try { this.p?.destroy(); } catch { /* noop */ } this.p = null; this.ready = false; }
}

/* ---- Analysis: YouTube audio comes from the analysis service (the browser can't read it). ---- */

/** Longest take the page records, uploads or analyzes (seconds); the service allows 300 s. */
export const TAKE_MAX_SEC = 300;
type Marker = { measure: number; audioSec: number };

/** Excerpt covering B-sync markers (video time), within the take limit; markers shifted to excerpt time. */
export function youTubeExcerpt(markers: Marker[], maxLen = TAKE_MAX_SEC): { startSec: number; lengthSec: number; markers: Marker[] } {
  if (!markers.length) throw new Error("No sync markers / 没有同步点");
  const sorted = [...markers].sort((a, b) => a.audioSec - b.audioSec);
  const gaps = sorted.slice(1).map((m, i) => m.audioSec - sorted[i].audioSec).sort((a, b) => a - b);
  const measureSec = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 2;
  const startSec = Math.max(0, Math.floor(sorted[0].audioSec - 1));
  const end = sorted[sorted.length - 1].audioSec + measureSec + 1;
  const lengthSec = Math.max(1, Math.min(maxLen, Math.ceil(end - startSec)));
  const shifted = sorted.map((m) => ({ measure: m.measure, audioSec: Math.round((m.audioSec - startSec) * 1000) / 1000 }))
    .filter((m) => m.audioSec < lengthSec);
  return { startSec, lengthSec, markers: shifted };
}

/** Ask for this tab's audio (Chrome/Edge desktop: "share tab audio"). Must run from a click. */
export async function captureTabAudio(md: MediaDevices = navigator.mediaDevices): Promise<MediaStream> {
  if (!md?.getDisplayMedia) throw new Error("此浏览器不支持录制标签页声音，请用电脑版 Chrome/Edge / This browser can't record tab audio; use desktop Chrome or Edge");
  const stream = await md.getDisplayMedia({
    video: true, preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "include",
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
  } as DisplayMediaStreamOptions);
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("没有共享声音：请选“此标签页”并勾选“共享标签页音频” / No audio shared: pick this tab and turn on \"Share tab audio\"");
  }
  return stream;
}

type Player = { currentTime: number; paused: boolean; playbackRate: number; play(): Promise<void>; pause(): void };

/**
 * Play [startSec, startSec+lengthSec] of the video and record the captured tab audio.
 * videoAtZero = video time at recording time 0, so a video time v sits at v - videoAtZero in the take.
 */
export async function recordPlayback(stream: MediaStream, media: Player, startSec: number, lengthSec: number,
  opts: { onProgress?: (sec: number) => void; signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void>;
    makeRecorder?: (s: MediaStream) => MediaRecorder } = {}): Promise<{ blob: Blob; videoAtZero: number }> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rate = media.playbackRate;
  const audio = new MediaStream(stream.getAudioTracks());
  const rec = opts.makeRecorder ? opts.makeRecorder(audio) : new MediaRecorder(audio,
    MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus" } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
  try {
    media.pause();
    media.playbackRate = 1;
    media.currentTime = startSec;
    // Wait for the seek to land (a not-yet-loaded player can ignore or delay it).
    for (let i = 0; i < 60 && Math.abs(media.currentTime - startSec) > 0.25; i++) {
      await sleep(100);
      if (i % 10 === 9) media.currentTime = startSec;
    }
    if (Math.abs(media.currentTime - startSec) > 0.25) throw new Error("视频无法跳到开始位置 / The video could not seek to the start");
    await sleep(300);
    rec.start();
    const recStart = now();
    await media.play();
    // A player reports "playing" before its clock (and sound) actually starts, 0.5–1.6 s later
    // while the audio output warms up. So anchor on the clock moving: median of
    // (video time - recording time) over samples taken while the video time advances.
    const from = media.currentTime;
    const offsets: number[] = [];
    let waited = 0;
    while (media.currentTime <= from + 0.05) {
      if (opts.signal?.aborted) throw new Error("已取消 / Cancelled");
      if (++waited > 300) throw new Error("视频没有开始播放 / The video did not start playing");
      await sleep(50);
    }
    const end = startSec + lengthSec;
    let last = -1, stuck = 0;
    while (media.currentTime < end) {
      if (opts.signal?.aborted) throw new Error("已取消 / Cancelled");
      const t = media.currentTime;
      if (t !== last && !media.paused) offsets.push(t - (now() - recStart) / 1000);
      opts.onProgress?.(Math.max(0, t - startSec));
      // Paused by the user or ended early: keep what was recorded.
      stuck = t === last ? stuck + 1 : 0;
      if (media.paused || stuck > 20) break;
      last = t;
      await sleep(100);
    }
    media.pause();
    rec.stop();
    await stopped;
    if (!offsets.length) throw new Error("视频没有播放 / The video did not play");
    offsets.sort((a, b) => a - b);
    return { blob: new Blob(chunks, { type: rec.mimeType || "audio/webm" }), videoAtZero: offsets[Math.floor(offsets.length / 2)] };
  } finally {
    if (rec.state !== "inactive") rec.stop();
    media.playbackRate = rate;
    stream.getTracks().forEach((t) => t.stop());
  }
}


