"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./performance.module.css";

type Box = { measure: number; left: number; right: number; top: number; bottom: number };
type Shape = { AbsolutePosition: { x: number; y: number }; BorderLeft: number; BorderRight: number; BorderTop: number; BorderBottom: number };
type OsmdSheet = { GraphicSheet?: { MeasureList?: Array<Array<{ PositionAndShape?: Shape } | undefined> | undefined> } };

/** Render OMR MusicXML as clean notation (OpenSheetMusicDisplay, SVG).
 * Mounted only when the user opens the preview, so the OSMD chunk loads
 * on demand and never touches SSR. Dark app theme => notation sits on a
 * white paper card (see .osmdPreview). With onMeasureClick, a click picks
 * the measure under the pointer, and `selected` gets an outline. */
export default function ScoreOsmdPreview({ musicXml, zh, zoom = 1, selected = null, onMeasureClick }: {
  musicXml: string; zh: boolean; zoom?: number; selected?: number | null; onMeasureClick?: (index: number) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  // Staff boxes in OSMD units (10 px at zoom 1) plus the SVG's offset in the frame, from the last render.
  const [layout, setLayout] = useState<{ boxes: Box[]; scale: number; x: number; y: number } | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    let timer = 0;
    const onResize = () => { clearTimeout(timer); timer = window.setTimeout(() => setWidth(window.innerWidth), 250); };
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(timer); window.removeEventListener("resize", onResize); };
  }, []);
  useEffect(() => {
    let dead = false;
    setError("");
    (async () => {
      try {
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (dead || !host.current) return;
        host.current.innerHTML = "";
        const osmd = new OpenSheetMusicDisplay(host.current, { autoResize: false, backend: "svg" });
        await osmd.load(musicXml);
        if (dead) return;
        osmd.Zoom = zoom;
        osmd.render();
        const boxes: Box[] = [];
        ((osmd as unknown as OsmdSheet).GraphicSheet?.MeasureList ?? []).forEach((staves, measure) => staves?.forEach((m) => {
          const s = m?.PositionAndShape;
          if (s) boxes.push({ measure, left: s.AbsolutePosition.x + s.BorderLeft, right: s.AbsolutePosition.x + s.BorderRight,
            top: s.AbsolutePosition.y + s.BorderTop, bottom: s.AbsolutePosition.y + s.BorderBottom });
        }));
        const svg = host.current?.querySelector("svg"), f = frame.current;
        if (!svg || !f) return;
        const a = svg.getBoundingClientRect(), b = f.getBoundingClientRect();
        // CSS fits the SVG to the card width, so scale OSMD's 10 px/unit by the drawn/declared width.
        const declared = Number(svg.getAttribute("width")) || a.width;
        setLayout({ boxes, scale: 10 * zoom * (a.width / declared), x: a.left - b.left, y: a.top - b.top });
      } catch (exc) {
        if (!dead) setError(exc instanceof Error ? exc.message : String(exc));
      }
    })();
    return () => { dead = true; setLayout(null); if (host.current) host.current.innerHTML = ""; };
  }, [musicXml, zoom, width]);

  function pick(e: React.MouseEvent) {
    const f = frame.current;
    if (!onMeasureClick || !layout || !f) return;
    const r = f.getBoundingClientRect();
    const x = (e.clientX - r.left - layout.x) / layout.scale, y = (e.clientY - r.top - layout.y) / layout.scale;
    let best: Box | null = null, bestDist = 6; // about one staff height
    for (const b of layout.boxes) {
      if (x < b.left || x > b.right) continue;
      const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      if (d < bestDist) { best = b; bestDist = d; }
    }
    if (best) onMeasureClick(best.measure);
  }
  const mark = selected != null && layout ? layout.boxes.filter((b) => b.measure === selected) : [];
  const edge = (f: (b: Box) => number, pick: (...n: number[]) => number) => pick(...mark.map(f));
  return <>
    {error && <p className={styles.error} role="alert">{zh ? "乐谱预览渲染失败（可用原 PDF 对照）：" : "Score preview failed (compare with the original PDF): "}{error}</p>}
    <div ref={frame} className={styles.osmdFrame} onClick={pick} data-pickable={onMeasureClick ? "true" : undefined}>
      <div ref={host} className={styles.osmdPreview} aria-label={zh ? "识别乐谱预览" : "Recognized score preview"} />
      {layout && mark.length > 0 && <div className={styles.osmdMark} data-testid="measure-mark" aria-hidden="true" style={{
        left: layout.x + edge((b) => b.left, Math.min) * layout.scale - 4,
        top: layout.y + edge((b) => b.top, Math.min) * layout.scale - 8,
        width: (edge((b) => b.right, Math.max) - edge((b) => b.left, Math.min)) * layout.scale + 8,
        height: (edge((b) => b.bottom, Math.max) - edge((b) => b.top, Math.min)) * layout.scale + 16,
      }} />}
    </div>
  </>;
}
