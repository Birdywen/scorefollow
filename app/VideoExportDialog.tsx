"use client";
/** Export the followed take as an MP4: title card, score with the moving shade, closing card. */
import { useEffect, useRef, useState } from "react";
import styles from "./video-export.module.css";
import { exportScoreVideo, previewFrame, videoSupported, type VideoInput, type VideoLayout, type VideoMeta } from "../lib/score-video";

export type VideoExportSource = {
  title: string;
  performer: string;
  scores?: [string, string][];
  /** Bars of the active bar loop (1-based), when one is on. */
  loopBars?: [number, number];
  build: (layout: VideoLayout, onlyLoop: boolean, meta: VideoMeta) => VideoInput | string;
};

const PERFORMER_KEY = "sf-video-performer";

export default function VideoExportDialog({ lang, source, onClose }: { lang: "zh" | "en"; source: VideoExportSource; onClose: () => void }) {
  const zh = lang === "zh";
  const [title, setTitle] = useState(source.title);
  const [performer, setPerformer] = useState(() => {
    try { return localStorage.getItem(PERFORMER_KEY) ?? source.performer; } catch { return source.performer; }
  });
  const [closing, setClosing] = useState(zh ? "感谢聆听" : "Thanks for listening");
  const [showScores, setShowScores] = useState(Boolean(source.scores?.length));
  const [layout, setLayout] = useState<VideoLayout>("landscape");
  const [onlyLoop, setOnlyLoop] = useState(false);
  const [preview, setPreview] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; name: string; mb: string; codec: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const supported = videoSupported();

  const meta = (): VideoMeta => ({
    title: title.trim() || (zh ? "我的演奏" : "My performance"),
    subtitle: performer.trim(),
    date: new Date().toLocaleDateString(zh ? "zh-CN" : "en-US", { year: "numeric", month: "long", day: "numeric" }),
    scores: showScores ? source.scores : undefined,
    closing: closing.trim(),
    footer: "mega-metro.online",
  });

  // Preview one score frame whenever the look changes.
  useEffect(() => {
    if (!supported) return;
    const id = setTimeout(() => {
      const inp = source.build(layout, onlyLoop, meta());
      if (typeof inp === "string") { setError(inp); setPreview(""); return; }
      setError("");
      try {
        const c = previewFrame(inp, 3 + Math.min(2, (inp.b - inp.a) / 3));
        const s = document.createElement("canvas");
        s.width = c.width / 3; s.height = c.height / 3;
        s.getContext("2d")!.drawImage(c, 0, 0, s.width, s.height);
        setPreview(s.toDataURL("image/jpeg", 0.85));
      } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    }, 150);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, onlyLoop, title, performer, supported]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);

  async function run() {
    const inp = source.build(layout, onlyLoop, meta());
    if (typeof inp === "string") { setError(inp); return; }
    try { localStorage.setItem(PERFORMER_KEY, performer.trim()); } catch { /* private mode */ }
    setError(""); setResult(null); setProgress(0);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const out = await exportScoreVideo(inp, setProgress, ac.signal);
      const safe = (title.trim() || "performance").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
      setResult({ url: URL.createObjectURL(out.blob), name: `${safe}.mp4`, mb: (out.blob.size / 1e6).toFixed(1), codec: out.videoCodec });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setError(zh ? "已取消导出" : "Export cancelled");
      else if (e instanceof Error && e.message === "NO_VIDEO_CODEC") setError(zh ? "这个浏览器不能编码视频，请用电脑上的 Chrome、Edge 或 Safari" : "This browser cannot encode video; use desktop Chrome, Edge or Safari");
      else setError((zh ? "导出失败：" : "Export failed: ") + (e instanceof Error ? e.message : String(e)));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }

  const busy = progress != null;
  return <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={zh ? "导出演奏视频" : "Export performance video"}>
    <div className={styles.dialog}>
      <div className={styles.head}><strong>{zh ? "导出演奏视频 (MP4)" : "Export performance video (MP4)"}</strong>
        <button onClick={() => { abortRef.current?.abort(); onClose(); }} aria-label={zh ? "关闭" : "Close"}>×</button></div>
      {!supported ? <p className={styles.error}>{zh ? "这个浏览器不支持导出视频，请用电脑上的 Chrome、Edge 或 Safari。" : "This browser cannot export video; use desktop Chrome, Edge or Safari."}</p> : <>
        <p className={styles.hint}>{zh ? "视频直接用谱面和录音合成，页面上的按钮、面板都不会出现在画面里。" : "The video is drawn from the score and the recording; no page buttons or panels appear in it."}</p>
        <div className={styles.grid}>
          <label>{zh ? "标题" : "Title"}<input value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>{zh ? "演奏者 / 说明" : "Performer / note"}<input value={performer} disabled={busy} placeholder={zh ? "例如：小明 · 小提琴" : "e.g. Alex · violin"} onChange={(e) => setPerformer(e.target.value)} /></label>
          <label>{zh ? "片尾文字" : "Closing text"}<input value={closing} disabled={busy} onChange={(e) => setClosing(e.target.value)} /></label>
          <div className={styles.row}>
            <span>{zh ? "画面" : "Frame"}</span>
            <label><input type="radio" checked={layout === "landscape"} disabled={busy} onChange={() => setLayout("landscape")} />{zh ? "横屏 16:9" : "Landscape 16:9"}</label>
            <label><input type="radio" checked={layout === "portrait"} disabled={busy} onChange={() => setLayout("portrait")} />{zh ? "竖屏 9:16（手机）" : "Portrait 9:16 (phone)"}</label>
          </div>
          {source.loopBars && <label className={styles.check}><input type="checkbox" checked={onlyLoop} disabled={busy} onChange={(e) => setOnlyLoop(e.target.checked)} />
            {zh ? `只导出循环的第 ${source.loopBars[0]}–${source.loopBars[1]} 小节` : `Only the looped bars ${source.loopBars[0]}–${source.loopBars[1]}`}</label>}
          {source.scores?.length ? <label className={styles.check}><input type="checkbox" checked={showScores} disabled={busy} onChange={(e) => setShowScores(e.target.checked)} />
            {zh ? `片尾显示分数（${source.scores.map(([l, v]) => `${l} ${v}`).join(" · ")}）` : `Show scores on the closing card (${source.scores.map(([l, v]) => `${l} ${v}`).join(" · ")})`}</label> : null}
        </div>
        {preview && <img className={styles.preview} data-layout={layout} src={preview} alt={zh ? "画面预览" : "Frame preview"} />}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {busy && <div className={styles.progress}><div style={{ width: `${Math.round(progress * 100)}%` }} /><span>{zh ? `正在生成… ${Math.round(progress * 100)}%（请保持本页在前台）` : `Rendering… ${Math.round(progress * 100)}% (keep this tab in front)`}</span></div>}
        {result && <div className={styles.done}>
          <video src={result.url} controls playsInline data-layout={layout} />
          <a className={styles.primary} href={result.url} download={result.name}>{zh ? `下载 MP4（${result.mb} MB）` : `Download MP4 (${result.mb} MB)`}</a>
          {result.codec !== "avc" && <p className={styles.hint}>{zh ? `这个浏览器用的是 ${result.codec} 编码，部分手机相册可能打不开；换电脑版 Chrome 可得到 H.264。` : `Encoded as ${result.codec}; some phone galleries may not open it. Desktop Chrome gives H.264.`}</p>}
        </div>}
        <div className={styles.actions}>
          {busy ? <button onClick={() => abortRef.current?.abort()}>{zh ? "取消" : "Cancel"}</button>
            : <button className={styles.primary} onClick={() => void run()}>{result ? (zh ? "重新生成" : "Render again") : (zh ? "生成视频" : "Render video")}</button>}
        </div>
      </>}
    </div>
  </div>;
}
