"use client";

import { useEffect, useMemo, useState } from "react";
import ScoreOsmdPreview from "./ScoreOsmdPreview";
import { measureExcerpt, placeVoiceAt } from "@/lib/score-edit";
import styles from "./performance.module.css";

/** One voice the analyzer re-placed from the recording (summary.voiceFixes, piano-align-0.7). */
export type VoiceFixRecord = { part: number; measure: number; number?: string; staff: string; voice: string; from: number[]; to: number[] };

const beats = (ts: number[], zh: boolean) => ts.map((t) => String(Math.round((t + 1) * 100) / 100)).join(zh ? "、" : ", ");
const staffName = (staff: string, zh: boolean) => staff === "1" ? (zh ? "高音谱表" : "upper staff") : staff === "2" ? (zh ? "低音谱表" : "lower staff") : (zh ? `谱表 ${staff}` : `staff ${staff}`);

/** The places the analyzer filled hidden rests from the recording, each with the measure before and after. */
export default function VoiceFixCompare({ fixes, score, zh }: { fixes: VoiceFixRecord[]; score: Blob | null; zh: boolean }) {
  const groups = useMemo(() => {
    const by = new Map<number, VoiceFixRecord[]>();
    for (const f of fixes) by.set(f.measure, [...(by.get(f.measure) ?? []), f]);
    return [...by].sort((a, b) => a[0] - b[0]);
  }, [fixes]);
  const [open, setOpen] = useState<number | null>(null);
  if (!fixes.length) return null;
  return <details className={styles.fixList} data-testid="voice-fixes">
    <summary>{zh ? `查看补在哪里（${groups.length} 个小节，共 ${fixes.length} 处）` : `See where (${groups.length} measures, ${fixes.length} places)`}</summary>
    <ul>{groups.map(([m, fs]) => <li key={m}>
      <button type="button" className={styles.fixToggle} aria-expanded={open === m} onClick={() => setOpen(open === m ? null : m)}>
        {zh ? `第 ${fs[0].number ?? m} 小节` : `m${fs[0].number ?? m}`} {open === m ? "▾" : "▸"}</button>
      {" "}{fs.map((f) => zh
        ? `${staffName(f.staff, zh)}声部 ${f.voice}：第 ${beats(f.from, zh)} 拍 → 第 ${beats(f.to, zh)} 拍`
        : `${staffName(f.staff, zh)} voice ${f.voice}: beats ${beats(f.from, zh)} → ${beats(f.to, zh)}`).join(zh ? "；" : "; ")}
      {open === m && <Compare fixes={fs} score={score} zh={zh} />}
    </li>)}</ul>
  </details>;
}

function Compare({ fixes, score, zh }: { fixes: VoiceFixRecord[]; score: Blob | null; zh: boolean }) {
  const [xml, setXml] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    score?.text().then((t) => { if (!dead) setXml(t); }, () => { if (!dead) setXml(""); });
    return () => { dead = true; };
  }, [score]);
  const views = useMemo(() => {
    if (xml == null) return null;
    try {
      const mi = fixes[0].measure - 1;
      let after = xml;
      for (const f of fixes) after = placeVoiceAt(after, mi, f.part, f.staff, f.voice, f.from, f.to);
      return { before: measureExcerpt(xml, mi), after: measureExcerpt(after, mi, true) };
    } catch {
      return "mismatch" as const;
    }
  }, [xml, fixes]);
  if (!score || views === "mismatch") return <p className={styles.hint}>{zh
    ? "当前载入的乐谱和分析时用的不一样，无法画出对比；重新分析后即可查看。"
    : "The score loaded now is not the one analyzed, so the comparison can't be drawn; analyze again to see it."}</p>;
  if (!views) return <p className={styles.hint}>{zh ? "正在载入…" : "Loading…"}</p>;
  return <div className={styles.fixCompare}>
    <figure>
      <figcaption>{zh ? "识别结果：这个声部挤在小节开头" : "As recognized: the voice is packed to the start of the bar"}</figcaption>
      <ScoreOsmdPreview musicXml={views.before} zh={zh} zoom={0.8} compact />
    </figure>
    <figure>
      <figcaption>{zh ? "按录音补上后：灰色休止符是谱上省略的（打印的乐谱不变）" : "Filled from the recording: grey rests are the ones the print leaves out (the printed score is unchanged)"}</figcaption>
      <ScoreOsmdPreview musicXml={views.after} zh={zh} zoom={0.8} compact />
    </figure>
  </div>;
}
