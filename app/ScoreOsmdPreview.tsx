"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./performance.module.css";

/** Render OMR MusicXML as clean notation (OpenSheetMusicDisplay, SVG).
 * Mounted only when the user opens the preview, so the OSMD chunk loads
 * on demand and never touches SSR. Dark app theme => notation sits on a
 * white paper card (see .osmdPreview). */
export default function ScoreOsmdPreview({ musicXml, zh, zoom = 1 }: { musicXml: string; zh: boolean; zoom?: number }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let dead = false;
    setError("");
    (async () => {
      try {
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (dead || !host.current) return;
        host.current.innerHTML = "";
        const osmd = new OpenSheetMusicDisplay(host.current, { autoResize: true, backend: "svg" });
        await osmd.load(musicXml);
        if (dead) return;
        osmd.Zoom = zoom;
        osmd.render();
      } catch (exc) {
        if (!dead) setError(exc instanceof Error ? exc.message : String(exc));
      }
    })();
    return () => { dead = true; if (host.current) host.current.innerHTML = ""; };
  }, [musicXml, zoom]);
  return <>{error && <p className={styles.error} role="alert">{zh ? "乐谱预览渲染失败（可用原 PDF 对照）：" : "Score preview failed (compare with the original PDF): "}{error}</p>}<div ref={host} className={styles.osmdPreview} aria-label={zh ? "识别乐谱预览" : "Recognized score preview"} /></>;
}
