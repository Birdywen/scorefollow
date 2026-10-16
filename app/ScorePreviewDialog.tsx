"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ScoreOsmdPreview from "./ScoreOsmdPreview";
import { transposeMusicXml, transposeSuffix } from "@/lib/score-transpose";
import styles from "./performance.module.css";

const SEMITONES = Array.from({ length: 25 }, (_, i) => i - 12);
const ZOOMS = [60, 80, 100, 125, 150, 200];

export default function ScorePreviewDialog({
  musicXml,
  filename,
  zh,
  onClose,
}: {
  musicXml: string;
  filename: string;
  zh: boolean;
  onClose: () => void;
}) {
  const [semitones, setSemitones] = useState(0);
  const [zoom, setZoom] = useState(100);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const shown = useMemo(() => transposeMusicXml(musicXml, semitones), [musicXml, semitones]);

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function download() {
    const url = URL.createObjectURL(new Blob([shown], { type: "application/vnd.recordare.musicxml+xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.replace(/\.pdf$/i, "") + transposeSuffix(semitones) + ".musicxml";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const title = zh ? "识别乐谱预览" : "Recognized score preview";
  return (
      <dialog
        ref={dialogRef}
        className={styles.osmdModal}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onCancel={(e) => { e.preventDefault(); onClose(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key !== "Tab") return;
          const controls = e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]');
          const first = controls[0], last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}
      >
        <div className={styles.osmdToolbar}>
          <strong>{title}</strong>
          <label className={styles.osmdTool}>
            {zh ? "转调（半音）" : "Transpose (semitones)"}
            <select
              value={semitones}
              onChange={(e) => setSemitones(Number(e.target.value))}
              aria-label={zh ? "转调半音数" : "Transposition in semitones"}
            >
              {SEMITONES.map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? (zh ? "原调" : "Original") : `${s > 0 ? "+" : ""}${s}`}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.osmdTool}>
            {zh ? "缩放" : "Zoom"}
            <select
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label={zh ? "预览缩放" : "Preview zoom"}
            >
              {ZOOMS.map((z) => (
                <option key={z} value={z}>
                  {z}%
                </option>
              ))}
            </select>
          </label>
          <button
            className={styles.omrButton}
            onClick={download}
            aria-label={zh ? "下载当前预览的 MusicXML" : "Download the previewed MusicXML"}
          >
            {zh ? "下载 MusicXML" : "Download MusicXML"}
          </button>
          <button
            ref={closeRef}
            className={styles.omrButton}
            onClick={onClose}
            aria-label={zh ? "关闭预览" : "Close preview"}
          >
            ×
          </button>
        </div>
        {semitones !== 0 && (
          <p className={styles.hint} role="note">
            {zh
              ? `已整体移调 ${semitones > 0 ? "+" : ""}${semitones} 半音（仅音符，调号不变）；下载会保存移调后的版本。`
              : `Shifted ${semitones > 0 ? "+" : ""}${semitones} semitones (notes only, key signature unchanged); download saves the shifted version.`}
          </p>
        )}
        <div className={styles.osmdBody}>
          <div style={{ minWidth: 700 }}>
            <ScoreOsmdPreview musicXml={shown} zh={zh} zoom={zoom / 100} />
          </div>
        </div>
      </dialog>
  );
}
