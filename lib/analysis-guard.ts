/** 分析服务响应运行时校验(PerformancePanel 入库前唯一关卡)。
 * 后端版本漂移/异常响应若直接入库, 渲染层解引用即整面板白屏。
 * version/notes/limitations/summary 逐项收紧, 任一项不合即拒收, 面板只显示错误。 */

function numOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function scoreOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);
}

function countValue(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function measureValue(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/** 面板按整数小节号做 Math.max/onJump；小数字/NaN 会污染 scoreMeasures 并误报对齐错误。 */
function noteMeasure(v: unknown): boolean {
  return measureValue(v);
}

export function isValidAnalysisResult(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (typeof o.version !== "string" || !o.version) return false;
  if (!Array.isArray(o.notes) || !Array.isArray(o.limitations)) return false;
  if (o.measureIntervals !== undefined) {
    if (!Array.isArray(o.measureIntervals)) return false;
    if (!o.measureIntervals.every((v) => v && typeof v === "object" &&
      Number.isInteger(v.measure) && v.measure >= 1 &&
      Number.isFinite(v.startSec) && v.startSec >= 0 &&
      Number.isFinite(v.endSec) && v.endSec > v.startSec)) return false;
  }
  if (!o.limitations.every((t) => typeof t === "string")) return false;
  for (const n of o.notes) {
    if (!n || typeof n !== "object") return false;
    const nn = n as Record<string, unknown>;
    if (typeof nn.id !== "string" || !nn.id || !noteMeasure(nn.measure)) return false;
    if (!numOrNull(nn.expectedSec) || !numOrNull(nn.performedSec)) return false;
    if (!numOrNull(nn.pitchErrorCents) || !numOrNull(nn.timingErrorMs)) return false;
    if (typeof nn.confidence !== "number" || !Number.isFinite(nn.confidence) || nn.confidence < 0) return false;
    if (typeof nn.status !== "string" || !nn.status) return false;
  }
  const s = o.summary;
  if (!s || typeof s !== "object") return false;
  const ss = s as Record<string, unknown>;
  if (!scoreOrNull(ss.pitchScore) || !scoreOrNull(ss.rhythmScore)) return false;
  if (!numOrNull(ss.timingOffsetMs) || !numOrNull(ss.timingSpreadMs)) return false;
  if (!countValue(ss.noteCount) || !countValue(ss.voicedNotes)) return false;
  if (!countValue(ss.timedNotes) || typeof ss.confidence !== "string" || !ss.confidence) return false;
  // 面板用 measureCount 做 PDF/MusicXML 对齐判断(number === number)；字符串会恒为 false 并误报。
  if (ss.measureCount !== undefined && !(typeof ss.measureCount === "number" && Number.isInteger(ss.measureCount) && ss.measureCount >= 0)) return false;
  if (ss.startMeasure !== undefined && !measureValue(ss.startMeasure)) return false;
  if (ss.endMeasure !== undefined && !measureValue(ss.endMeasure)) return false;
  return true;
}

/** job 信封最小校验(id/status 为非空字符串才可入库轮询)。 */
export function isValidJobEnvelope(j: unknown): boolean {
  if (!j || typeof j !== "object") return false;
  const o = j as Record<string, unknown>;
  return typeof o.id === "string" && !!o.id && typeof o.status === "string" && !!o.status;
}
