import styles from "./performance.module.css";

export type Quality = {
  version: string; outcome: "complete" | "complete_with_rescue" | "partial" | "insufficient_evidence" | "score_audio_mismatch";
  issues: string[]; pitchCoverage: number; timingCoverage: number; followReady: boolean;
  overallScore?: number | null; pitchMatchRate?: number | null; overallWeights?: { pitch: number; rhythm: number };
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
  const labels = {
    complete: ["结果可用", "Results available"], complete_with_rescue: ["已自动补救，请核对", "Auto-corrected; review alignment"],
    partial: ["部分结果，需要核对", "Partial results; review needed"], insufficient_evidence: ["证据不足，未能评分", "Insufficient evidence to score"],
    score_audio_mismatch: ["输入可能不匹配", "Score and recording may not match"],
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
    <p>{status === "partial" || status === "insufficient_evidence"
      ? (zh ? "请核对谱面、乐器和起始小节；必要时使用下方手动小节同步后重分析。" : "Check the score, instrument and starting measure; use manual measure sync below and analyze again if needed.")
      : (zh ? "分数不代表对齐质量；走谱前请回听首尾小节，确认时间边界。" : "Scores do not prove alignment quality; replay the first and last measures before following the take.")}</p>
    {quality && <p>{quality.followReady ? (zh ? "已有可用走谱时间轴，请先核对。" : "A follow timeline is available; verify it first.") : (zh ? "走谱时间轴尚未可靠确认，请先同步小节。" : "The follow timeline needs confirmation; sync the measures first.")}</p>}
    <details><summary>{zh ? "诊断信息" : "Diagnostics"}</summary>
      <p>{zh ? "算法版本" : "Algorithm version"}：{version}</p>
      {diagnostics && <p>{zh ? "分析编号" : "Analysis ID"}：{diagnostics.analysisId}<br />{zh ? "处理耗时" : "Processing time"}：{(diagnostics.elapsedMs / 1000).toFixed(1)}s</p>}
    </details>
  </section>;
}
