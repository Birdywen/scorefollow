import styles from "./performance.module.css";

export type Quality = {
  version: string; outcome: "complete" | "complete_with_rescue" | "partial" | "insufficient_evidence" | "score_audio_mismatch" | "score_unreliable";
  issues: string[]; pitchCoverage: number; timingCoverage: number; followReady: boolean;
  overallScore?: number | null; pitchMatchRate?: number | null; overallWeights?: { pitch: number; rhythm: number };
  overallReliability?: "full" | "reference" | null; unheardRatio?: number;
};

type Summary = {
  pitchScore: number | null; rhythmScore: number | null; noteCount: number; voicedNotes: number;
  timedNotes: number; scoredPitchNotes?: number; timingCandidateNotes?: number; confidence: string;
  startMeasure?: number; endMeasure?: number; coveredSec?: number; syncAdvice?: string | null;
  autoMeasureSync?: boolean; rescueReasons?: string[]; degraded?: boolean; clipped?: boolean;
  detectedBpm?: number | null; takeBeyondScoreAfterSec?: number | null;
};

export default function AnalysisQuality({ summary: s, quality, diagnostics, version, zh }: {
  summary: Summary; quality?: Quality;
  diagnostics?: { analysisId: string; elapsedMs: number }; version: string; zh: boolean;
}) {
  const status = quality?.outcome ?? (s.pitchScore == null && s.rhythmScore == null ? "insufficient_evidence"
    : s.syncAdvice ? "partial"
    : s.pitchScore == null || s.rhythmScore == null || s.confidence === "low" ? "partial"
    : s.autoMeasureSync ? "complete_with_rescue" : "complete");
  // 只录了一段 (唯一原因是 range) 不等于出了问题: 用中性措辞, 不催用户手动同步
  const rangeOnly = status === "partial" && s.pitchScore != null && s.rhythmScore != null
    && !(quality?.issues ?? []).some((i) => i === "alignment_unverified" || i === "low_coverage" || i === "pitch_tracking_unreliable" || i === "tempo_timing_unreliable")
    && !!s.rescueReasons?.includes("range");
  const labels = {
    complete: ["结果可用", "Results available"], complete_with_rescue: ["已自动补救，请核对", "Auto-corrected; review alignment"],
    partial: rangeOnly ? [`已评第 ${s.startMeasure ?? "—"}–${s.endMeasure ?? "—"} 小节`, `Scored measures ${s.startMeasure ?? "—"}–${s.endMeasure ?? "—"}`] : ["部分结果，需要核对", "Partial results; review needed"], insufficient_evidence: ["证据不足，未能评分", "Insufficient evidence to score"],
    score_audio_mismatch: ["输入可能不匹配", "Score and recording may not match"],
    score_unreliable: ["谱面不可靠，未评分", "Score unreliable; not graded"],
  };
  const reasons: Record<string, [string, string]> = {
    octave: ["八度修正", "Octave correction"], tempo: ["速度修正", "Tempo correction"],
    pause: ["停顿分段", "Pause segmentation"], offset: ["起点修正", "Start correction"], range: ["片段范围调整", "Excerpt range adjustment"],
  };
  const pitchRatio = quality?.pitchCoverage ?? (s.noteCount ? (s.scoredPitchNotes ?? s.voicedNotes) / s.noteCount : 0);
  const candidates = s.timingCandidateNotes ?? Math.max(0, s.noteCount - 1);
  const timingRatio = quality?.timingCoverage ?? (candidates ? s.timedNotes / candidates : 0);
  const percent = (value: number) => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return <section className={styles.quality} aria-label={zh ? "分析质量" : "Analysis quality"} aria-live="polite">
    <h3>{zh ? "分析质量" : "Analysis quality"}</h3>
    <strong>{labels[status][zh ? 0 : 1]}</strong>
    {status === "score_audio_mismatch" && <p role="status">{zh
      ? `录音与谱面大多对不上${quality?.pitchMatchRate != null ? `（音高命中 ${Math.round(quality.pitchMatchRate * 100)}%）` : ""}。请确认是同一首曲子，谱面八度与起始小节正确；本次不评分。`
      : `Most of the take does not match the score${quality?.pitchMatchRate != null ? ` (pitch match ${Math.round(quality.pitchMatchRate * 100)}%)` : ""}. Check that it is the same piece and the score octave and start measure are right; this take is not graded.`}</p>}
    <p>{zh ? "音高可判比例" : "Scorable pitch coverage"} {percent(pitchRatio)} · {zh ? "起音可判比例" : "Timing coverage"} {percent(timingRatio)}</p>
    <p>{zh ? "录音时长" : "Recording duration"} {s.coveredSec == null ? "—" : `${s.coveredSec}s`} · {zh ? "分析小节" : "Analyzed measures"} {s.startMeasure ?? "—"}–{s.endMeasure ?? "—"}</p>
    {!!s.rescueReasons?.length && <p>{zh ? "补救" : "Corrections"}：{s.rescueReasons.map((code) => reasons[code]?.[zh ? 0 : 1] ?? code).join(" · ")}</p>}
    {s.takeBeyondScoreAfterSec != null && <p>{zh ? `录音超出谱面：${s.takeBeyondScoreAfterSec.toFixed(1)}s 之后的内容未评分（第 ${s.endMeasure ?? "—"} 小节之后），谱面可能缺页。` : `Take runs past the score: audio after ${s.takeBeyondScoreAfterSec.toFixed(1)}s was not graded (after m.${s.endMeasure ?? "—"}); the score may be missing pages.`}</p>}
    {s.detectedBpm != null && <p>{zh ? "实测速度" : "Detected tempo"} ≈ {s.detectedBpm} BPM</p>}
    {s.clipped && <p>{zh ? "录音存在削波，请降低输入音量。" : "Clipping detected; reduce the recording input level."}</p>}
    {(quality?.issues ?? []).includes("pitch_tracking_unreliable") && <p>{zh ? "部分音高没有测准（偏差过大的音已灰显，不计入音准分），建议回听这些小节或重录。" : "Some pitches could not be measured reliably (extreme deviations are greyed out and not scored); replay those measures or record again."}</p>}
    {(quality?.issues ?? []).includes("tempo_timing_unreliable") && <p>{zh ? "录音中速度变化较大，后段时间对不上，节奏分仅供参考；可用下方手动小节同步后重分析。" : "Tempo varied a lot in this take, so later notes drift off the timeline and the rhythm score is indicative only. Use manual measure sync below and analyze again."}</p>}
    {(quality?.issues ?? []).includes("score_unreliable") && <p role="status">{zh ? "谱面（多为 PDF 识别结果）有明显错误，相应分数已拒绝给出；具体依据见下方钢琴报告的“谱面检查”。" : "The score (often a PDF recognition result) has clear errors, so the affected scores were withheld; see “Score check” in the piano report for the evidence."}</p>}
    <p>{(status === "partial" && !rangeOnly) || status === "insufficient_evidence" || status === "score_unreliable"
      ? (zh ? "请核对谱面、乐器和起始小节；必要时使用下方手动小节同步后重分析。" : "Check the score, instrument and starting measure; use manual measure sync below and analyze again if needed.")
      : (zh ? "分数不代表对齐质量；走谱前请回听首尾小节，确认时间边界。" : "Scores do not prove alignment quality; replay the first and last measures before following the take.")}</p>
    {quality && <p>{quality.followReady ? (zh ? "已有可用走谱时间轴，请先核对。" : "A follow timeline is available; verify it first.") : (zh ? "走谱时间轴尚未可靠确认，请先同步小节。" : "The follow timeline needs confirmation; sync the measures first.")}</p>}
    <details><summary>{zh ? "诊断信息" : "Diagnostics"}</summary>
      <p>{zh ? "算法版本" : "Algorithm version"}：{version}</p>
      {diagnostics && <p>{zh ? "分析编号" : "Analysis ID"}：{diagnostics.analysisId}<br />{zh ? "处理耗时" : "Processing time"}：{(diagnostics.elapsedMs / 1000).toFixed(1)}s</p>}
    </details>
  </section>;
}
