// 分析失败可解释化：按服务端 errorClass / interrupted / HTTP 状态区分“可直接重试”与“需改输入”。
// 字段均可选：旧服务不回传时按 HTTP 状态与报错文本兜底。
export type FailureInfo = { errorClass?: string; interrupted?: boolean; httpStatus?: number | null };
export type FailureKind = "retry" | "fix_input";

const INPUT = new Set(["AnalysisError", "AudioValidationError", "ScoreValidationError", "AlignmentError", "ValueError"]);
const TRANSIENT = new Set(["ServiceRestart", "StorageError", "QueueUnavailable", "QueueFull"]);
const GENERIC = "分析失败，请检查音频和谱面";

export function failureKind(info?: FailureInfo): FailureKind {
  if (!info || info.interrupted) return "retry";
  const c = info.errorClass;
  if (c) return INPUT.has(c) ? "fix_input" : "retry";
  const h = info.httpStatus;
  if (typeof h === "number" && h >= 400 && h < 500 && h !== 408 && h !== 429) return "fix_input";
  return "retry";
}

export function describeFailure(message: string, info: FailureInfo | undefined, zh: boolean): string {
  if (failureKind(info) === "fix_input") {
    return message + (zh ? "（请修改谱面、录音或参数后再分析）" : " (change the score, recording or settings, then analyze again)");
  }
  const c = info?.errorClass;
  if (info?.interrupted || (c && TRANSIENT.has(c))) {
    return zh ? "分析被中断（服务重启或繁忙），与输入无关；可直接重新分析。" : "Analysis was interrupted (service restart or busy), not caused by your input. Analyze again.";
  }
  if (c || message === GENERIC) {
    return zh ? "分析服务内部出错，与输入无关；可直接重新分析。若反复失败，请反馈。" : "Internal analysis error, not caused by your input. Analyze again; if it keeps failing, please report it.";
  }
  return message + (zh ? "（可直接重新分析）" : " (you can analyze again)");
}
