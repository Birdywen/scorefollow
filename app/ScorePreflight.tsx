"use client";

import { useEffect, useState } from "react";
import { inspectScoreXml, midiName, preflightMessage, type ScorePreflight as Preflight } from "@/lib/analysis-preflight";
import styles from "./performance.module.css";

export default function ScorePreflight({ file, zh }: { file: File | null; zh: boolean }) {
  const [state, setState] = useState<{ file: File; report: Preflight | null } | null>(null);
  useEffect(() => {
    if (!file) return;
    let active = true;
    const oversized = file.size > 1_000_000;
    (oversized ? Promise.resolve("") : file.text()).then((xml) => {
      const report = inspectScoreXml(xml);
      if (oversized) report.errors = ["too_large"];
      if (active) setState({ file, report });
    }).catch(() => { if (active) setState({ file, report: null }); });
    return () => { active = false; };
  }, [file]);
  if (!file) return null;
  const ready = state?.file === file;
  const report = ready ? state.report : null;
  return <section className={styles.quality} aria-label={zh ? "谱面预检" : "Score preflight"} aria-live="polite">
    <h3>{zh ? "谱面预检" : "Score preflight"}</h3>
    {!ready ? <p>{zh ? "正在检查谱面…" : "Checking score…"}</p> : report ? <>
      <p>{report.measures} {zh ? "小节" : "measures"} · {report.notes} {zh ? "音符" : "notes"} · {report.meter ?? "—"}</p>
      <p>{zh ? "音域" : "Pitch range"} {midiName(report.minMidi)}–{midiName(report.maxMidi)}</p>
      {[...report.errors, ...report.warnings].map((code) => <p className={report.errors.includes(code) ? styles.error : styles.hint} key={code}>{preflightMessage(code, zh)}</p>)}
      {!report.errors.length && <p>{zh ? "结构预检通过；音符识别与录音匹配仍需分析确认。" : "Structure check passed; note recognition and audio matching still require analysis."}</p>}
    </> : <p>{zh ? "无法读取文件，请重新上传。" : "Cannot read the file; upload it again."}</p>}
  </section>;
}
