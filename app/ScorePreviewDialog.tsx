"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ScoreOsmdPreview from "./ScoreOsmdPreview";
import { transposeMusicXml, transposeSuffix } from "@/lib/score-transpose";
import {
  addChordTone, deleteChordTone, fillAllVoiceGaps, fillVoiceGap, impliedAlter, lengthIssues, voiceGaps, measureCount, measureXml, noteToRest, pitchName, readMeasure,
  replaceMeasureXml, restToNote, setNotePitch, type EditNote, type Pitch,
} from "@/lib/score-edit";
import styles from "./performance.module.css";

const SEMITONES = Array.from({ length: 25 }, (_, i) => i - 12);
const ZOOMS = [60, 80, 100, 125, 150, 200];
const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const ALTERS: Array<[number, string]> = [[-2, "𝄫"], [-1, "♭"], [0, "♮"], [1, "♯"], [2, "𝄪"]];
const OCTAVES = [1, 2, 3, 4, 5, 6, 7];
const TYPE_NAMES: Record<string, [string, string]> = {
  breve: ["二全", "breve"], whole: ["全音符", "whole"], half: ["二分", "half"], quarter: ["四分", "quarter"],
  eighth: ["八分", "8th"], "16th": ["十六分", "16th"], "32nd": ["三十二分", "32nd"], "64th": ["六十四分", "64th"],
};
const fmtBeats = (q: number) => String(Math.round(q * 100) / 100);

export default function ScorePreviewDialog({
  musicXml,
  originalXml,
  filename,
  zh,
  onClose,
  onSave,
}: {
  musicXml: string;
  /** The recognition result before any edits (for "Restore"). */
  originalXml?: string;
  filename: string;
  zh: boolean;
  onClose: () => void;
  /** Enables editing; called with the edited MusicXML that analysis should use. */
  onSave?: (xml: string) => void;
}) {
  const [semitones, setSemitones] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [draft, setDraft] = useState(musicXml);
  const [saved, setSaved] = useState(musicXml);
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [raw, setRaw] = useState<{ part: number; text: string } | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const shown = useMemo(() => transposeMusicXml(draft, semitones), [draft, semitones]);
  const editable = !!onSave && semitones === 0;
  const total = useMemo(() => measureCount(draft), [draft]);
  const issues = useMemo(() => (onSave ? lengthIssues(draft) : []), [draft, onSave]);
  // Voices that stop early because the engraving hid a rest; the fix inserts invisible gaps.
  const gaps = useMemo(() => (onSave ? voiceGaps(draft) : []), [draft, onSave]);
  const gapMeasures = useMemo(() => [...new Map(gaps.filter((g) => g.fix).map((g) => [g.index, g])).values()], [gaps]);
  const measure = useMemo(() => (editable && selected != null ? readMeasure(draft, selected) : null), [draft, editable, selected]);
  const dirty = draft !== saved;

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

  function close() {
    if (dirty && !window.confirm(zh ? "修改尚未保存，确定放弃？" : "Discard unsaved changes?")) return;
    onClose();
  }
  function commit(edit: () => string): boolean {
    try {
      const next = edit();
      if (next !== draft) {
        setHistory((h) => [...h.slice(-99), draft]);
        setDraft(next);
      }
      setNotice(null);
      return true;
    } catch (exc) {
      setNotice({ error: true, text: exc instanceof Error ? exc.message : String(exc) });
      return false;
    }
  }
  function undo() {
    const prev = history.at(-1);
    if (prev == null) return;
    setHistory((h) => h.slice(0, -1));
    setDraft(prev);
    setRaw(null);
    setNotice(null);
  }
  function save() {
    onSave?.(draft);
    setSaved(draft);
    setNotice({ error: false, text: zh ? "已保存：分析将使用修改后的乐谱。" : "Saved: analysis will use the edited score." });
  }
  function applyRaw() {
    if (!raw || selected == null) return;
    const ok = commit(() => {
      const next = replaceMeasureXml(draft, selected, raw.part, raw.text);
      const doc = new DOMParser().parseFromString(next, "application/xml");
      if (doc.querySelector("parsererror")) throw new Error(zh ? "XML 格式错误，未应用" : "Not well-formed XML; not applied");
      return next;
    });
    if (ok) setRaw(null);
  }
  function fillAll() {
    let n = 0;
    if (commit(() => { const r = fillAllVoiceGaps(draft); n = r.filled; return r.xml; }))
      setNotice({ error: false, text: zh ? `已在 ${n} 个声部补上隐藏休止符（乐谱外观不变）。` : `Filled hidden rests in ${n} voices (the printed score looks the same).` });
  }
  function go(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= total) return;
    setSelected(index);
    setRaw(null);
  }

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

  function noteRow(pi: number, n: EditNote, nth: number) {
    const mi = selected!;
    const label = (what: string) => zh ? `第 ${nth} 个音 ${what}` : `Note ${nth} ${what}`;
    const set = (p: Partial<Pitch>) => commit(() => setNotePitch(draft, mi, pi, n.index, { ...n.pitch!, ...p }));
    const type = n.type ? (TYPE_NAMES[n.type]?.[zh ? 0 : 1] ?? n.type) : (zh ? "整小节" : "full bar");
    return <tr key={n.index} data-testid="edit-note">
      <td>{nth}</td>
      <td>{n.staff}/{n.voice}</td>
      <td>{type}{"·".repeat(n.dots)}{n.grace ? (zh ? " 倚音" : " grace") : ""}{n.chordSize > 1 ? (zh ? " 和弦" : " chord") : ""}</td>
      <td>{n.pitch ? <span className={styles.editPitch}>
        <select aria-label={label(zh ? "音名" : "step")} value={n.pitch.step}
          onChange={(e) => set({ step: e.target.value, alter: impliedAlter(draft, mi, pi, n.index, e.target.value, n.pitch!.octave) })}>
          {STEPS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select aria-label={label(zh ? "升降" : "accidental")} value={n.pitch.alter} onChange={(e) => set({ alter: Number(e.target.value) })}>
          {ALTERS.map(([a, s]) => <option key={a} value={a}>{s}</option>)}</select>
        <select aria-label={label(zh ? "八度" : "octave")} value={n.pitch.octave} onChange={(e) => set({ octave: Number(e.target.value) })}>
          {[...new Set([...OCTAVES, n.pitch.octave])].sort().map((o) => <option key={o} value={o}>{o}</option>)}</select>
        <b>{pitchName(n.pitch)}</b>
      </span> : n.rest ? (zh ? "休止" : "rest") : (zh ? "无音高" : "unpitched")}</td>
      <td className={styles.editActions}>
        {n.pitch && <button type="button" onClick={() => commit(() => addChordTone(draft, mi, pi, n.index).xml)}>{zh ? "+和弦音" : "+ chord tone"}</button>}
        {n.pitch && n.chordSize > 1 && <button type="button" onClick={() => commit(() => deleteChordTone(draft, mi, pi, n.index))}>{zh ? "删除" : "Delete"}</button>}
        {n.pitch && n.chordSize === 1 && !n.grace && <button type="button" onClick={() => commit(() => noteToRest(draft, mi, pi, n.index))}>{zh ? "改为休止" : "To rest"}</button>}
        {n.rest && <button type="button" onClick={() => commit(() => restToNote(draft, mi, pi, n.index, n.staff === "2" ? { step: "D", alter: 0, octave: 3 } : { step: "B", alter: 0, octave: 4 }))}>{zh ? "改为音符" : "To note"}</button>}
      </td>
    </tr>;
  }

  const title = zh ? "识别乐谱预览" : "Recognized score preview";
  return (
      <dialog
        ref={dialogRef}
        className={styles.osmdModal}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onCancel={(e) => { e.preventDefault(); close(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key !== "Tab") return;
          const controls = e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea, [tabindex="0"]');
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
          {onSave && <>
            <button className={styles.omrButton} onClick={undo} disabled={!history.length}>{zh ? "撤销" : "Undo"}</button>
            {originalXml != null && <button className={styles.omrButton} disabled={draft === originalXml}
              onClick={() => commit(() => originalXml)}>{zh ? "恢复识别原版" : "Restore recognized"}</button>}
            <button className={styles.omrButton} onClick={save} disabled={!dirty}>{zh ? "保存修改用于分析" : "Save edits for analysis"}</button>
          </>}
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
            onClick={close}
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
            {onSave && (zh ? " 回到原调才能修改音符。" : " Switch back to the original key to edit notes.")}
          </p>
        )}
        {editable && <div className={styles.editBar}>
          <span className={styles.hint}>{zh ? "识别有误？点击乐谱中的小节修改音符。" : "Recognition mistake? Click a measure to fix its notes."}</span>
          {issues.length > 0 && <span className={styles.editIssues}>{zh ? "时值不符：" : "Beats don't add up:"}
            {issues.slice(0, 12).map((i) => <button key={i.index} type="button" onClick={() => go(i.index)}
              title={zh ? `${fmtBeats(i.actual)} 拍，应为 ${fmtBeats(i.expected)} 拍` : `${fmtBeats(i.actual)} beats, expected ${fmtBeats(i.expected)}`}>
              {zh ? `第${i.number}小节` : `m${i.number}`}</button>)}
            {issues.length > 12 && "…"}</span>}
          {gapMeasures.length > 0 && <span className={styles.editIssues}>{zh ? "疑似漏写休止符：" : "Likely hidden rests:"}
            {gapMeasures.slice(0, 12).map((g) => <button key={g.index} type="button" onClick={() => go(g.index)}>
              {zh ? `第${g.number}小节` : `m${g.number}`}</button>)}
            {gapMeasures.length > 12 && "…"}
            <button type="button" onClick={fillAll}>{zh ? `全部补上（${gapMeasures.length} 小节）` : `Fill all (${gapMeasures.length} measures)`}</button></span>}
          {notice && <span className={notice.error ? styles.error : styles.hint} role={notice.error ? "alert" : "status"}>{notice.text}</span>}
        </div>}
        <div className={styles.osmdBody}>
          <div style={{ minWidth: 700 }}>
            <ScoreOsmdPreview musicXml={shown} zh={zh} zoom={zoom / 100}
              selected={editable ? selected : null} onMeasureClick={editable ? go : undefined} />
          </div>
        </div>
        {measure && <section className={styles.editPanel} aria-label={zh ? "小节修改" : "Measure editor"}>
          <div className={styles.editHead}>
            <button type="button" onClick={() => go(selected! - 1)} disabled={selected === 0} aria-label={zh ? "上一小节" : "Previous measure"}>‹</button>
            <label>{zh ? "小节" : "Measure"} <input type="number" min={1} max={total} value={selected! + 1}
              onChange={(e) => go(Number(e.target.value) - 1)} aria-label={zh ? "小节序号" : "Measure index"} /> / {total}</label>
            <button type="button" onClick={() => go(selected! + 1)} disabled={selected === total - 1} aria-label={zh ? "下一小节" : "Next measure"}>›</button>
            {measure.number !== String(selected! + 1) && <span className={styles.hint}>{zh ? `谱面编号 ${measure.number}` : `printed number ${measure.number}`}</span>}
            <button type="button" className={styles.editClose} onClick={() => { setSelected(null); setRaw(null); }} aria-label={zh ? "关闭小节修改" : "Close measure editor"}>×</button>
          </div>
          {measure.parts.map((part) => {
            let nth = 0;
            return <div key={part.partIndex}>
              {measure.parts.length > 1 && <b>{zh ? `声部 ${part.partIndex + 1}` : `Part ${part.partIndex + 1}`} ({part.partId})</b>}
              {part.expected != null && Math.abs(part.length - part.expected) > 1e-6 && <p className={styles.error}>
                {zh ? `本小节共 ${fmtBeats(part.length)} 拍，拍号应为 ${fmtBeats(part.expected)} 拍（四分音符计）。可用下方 XML 修改时值。`
                  : `This measure has ${fmtBeats(part.length)} beats; the time signature needs ${fmtBeats(part.expected)} (quarter notes). Fix note values in the XML below.`}</p>}
              {gaps.filter((g) => g.index === selected && g.partIndex === part.partIndex).map((g) => {
                const at = (ts: number[]) => ts.map((t) => fmtBeats(t + 1)).join(zh ? "、" : ", ");
                return <p key={g.staff + "/" + g.voice} className={g.fix ? styles.error : styles.hint}>
                  {zh ? `谱表 ${g.staff} 声部 ${g.voice} 只有 ${fmtBeats(g.actual)} 拍（应为 ${fmtBeats(g.expected)}）。`
                    : `Staff ${g.staff} voice ${g.voice} has ${fmtBeats(g.actual)} beats (needs ${fmtBeats(g.expected)}). `}
                  {g.fix ? <>{zh ? `可能漏写了休止符：音符从第 ${at(g.fix.current)} 拍移到第 ${at(g.fix.onsets)} 拍（对齐其他声部）。`
                    : `Probably a hidden rest: notes move from beats ${at(g.fix.current)} to ${at(g.fix.onsets)} (lined up with the other voices). `}
                    <button type="button" className={styles.omrButton}
                      onClick={() => commit(() => fillVoiceGap(draft, selected!, part.partIndex, g.staff, g.voice))}>
                      {zh ? "补上隐藏休止符" : "Fill hidden rest"}</button></>
                    : zh ? "看不出缺在哪里，按缺在小节末尾处理（不改变任何音的起拍）。" : "No clear spot for the missing time; treated as a rest at the end (no onset changes)."}
                </p>;
              })}
              <table className={styles.editTable}>
                <thead><tr><th>#</th><th>{zh ? "谱表/声部" : "Staff/voice"}</th><th>{zh ? "时值" : "Value"}</th><th>{zh ? "音高" : "Pitch"}</th><th /></tr></thead>
                <tbody>{part.notes.map((n) => noteRow(part.partIndex, n, ++nth))}</tbody>
              </table>
              {raw?.part === part.partIndex ? <div className={styles.editRaw}>
                <textarea value={raw.text} onChange={(e) => setRaw({ part: part.partIndex, text: e.target.value })} spellCheck={false}
                  aria-label={zh ? "本小节 MusicXML" : "This measure's MusicXML"} rows={10} />
                <div><button type="button" className={styles.omrButton} onClick={applyRaw}>{zh ? "应用 XML" : "Apply XML"}</button>
                  <button type="button" className={styles.omrButton} onClick={() => setRaw(null)}>{zh ? "取消" : "Cancel"}</button></div>
              </div> : <button type="button" className={styles.editRawToggle}
                onClick={() => setRaw({ part: part.partIndex, text: measureXml(draft, selected!, part.partIndex) })}>
                {zh ? "编辑本小节 XML（高级：时值、连线等）" : "Edit this measure's XML (advanced: note values, ties…)"}</button>}
            </div>;
          })}
        </section>}
      </dialog>
  );
}
