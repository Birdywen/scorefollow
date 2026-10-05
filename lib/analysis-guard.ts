/** 分析服务响应运行时校验(PerformancePanel 入库前唯一关卡)。
 * 后端版本漂移/异常响应若直接入库, 渲染层解引用即整面板白屏。
 * version/notes/limitations/summary 逐项收紧, 任一项不合即拒收, 面板只显示错误。 */

function numOrNull(v: unknown): boolean {
  return typeof v === "number" || v === null;
}

export function isValidAnalysisResult(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (typeof o.version !== "string" || !o.version) return false;
  if (!Array.isArray(o.notes) || !Array.isArray(o.limitations)) return false;
  if (!o.limitations.every((t) => typeof t === "string")) return false;
  for (const n of o.notes) {
    if (!n || typeof n !== "object") return false;
    const nn = n as Record<string, unknown>;
    if (typeof nn.id !== "string" || typeof nn.measure !== "number") return false;
    if (!numOrNull(nn.expectedSec) || !numOrNull(nn.performedSec)) return false;
    if (!numOrNull(nn.pitchErrorCents) || !numOrNull(nn.timingErrorMs)) return false;
    if (typeof nn.confidence !== "number" || typeof nn.status !== "string") return false;
  }
  const s = o.summary;
  if (!s || typeof s !== "object") return false;
  const ss = s as Record<string, unknown>;
  if (!numOrNull(ss.pitchScore) || !numOrNull(ss.rhythmScore)) return false;
  if (!numOrNull(ss.timingOffsetMs) || !numOrNull(ss.timingSpreadMs)) return false;
  if (typeof ss.noteCount !== "number" || typeof ss.voicedNotes !== "number") return false;
  if (typeof ss.timedNotes !== "number" || typeof ss.confidence !== "string") return false;
  return true;
}

/** job 信封最小校验(id/status 为非空字符串才可入库轮询)。 */
export function isValidJobEnvelope(j: unknown): boolean {
  if (!j || typeof j !== "object") return false;
  const o = j as Record<string, unknown>;
  return typeof o.id === "string" && !!o.id && typeof o.status === "string" && !!o.status;
}
