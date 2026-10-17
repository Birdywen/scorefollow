"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./performance.module.css";

// Wide modal for the full analysis report: the side panel is too narrow for charts.
export default function ReportDialog({ title, zh, onClose, toolbar, children }: {
  title: string;
  zh: boolean;
  onClose: () => void;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`${styles.osmdModal} ${styles.reportModal}`}
      aria-label={title}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className={styles.osmdToolbar}>
        <strong>{title}</strong>
        {toolbar}
        <button ref={closeRef} className={styles.omrButton} onClick={onClose} aria-label={zh ? "关闭报告" : "Close report"}>×</button>
      </div>
      <div className={styles.reportBody}>{children}</div>
    </dialog>
  );
}
