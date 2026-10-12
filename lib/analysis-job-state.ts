/** 演奏分析任务纯状态机（不依赖 React/DOM，可独立测试）。
 * PerformancePanel 的提交/轮询/取消/超时/结果校验全部经由这里的状态转换驱动，
 * 副作用（fetch/定时器/AbortController）由 app/hooks/useAnalysisJob 承担。
 */

export type AnalysisJobState =
  | "idle"
  | "validating"
  | "preparing"
  | "submitting"
  | "polling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type AnalysisJobPhase = "validating" | "preparing" | "submitting" | "polling";

/** 与后端 /jobs 契约兼容的请求体。兼容新旧字段名：
 *  musicxml/scoreXml 二选一，audio/audioWavBase64 二选一。
 */
export type AnalysisRequest = {
  instrument: string;
  bpm: number;
  startMeasure: number;
  syncMode?: string;
  musicxml?: string;
  scoreXml?: string;
  audio?: string;
  audioWavBase64?: string;
} & Record<string, unknown>;

export type AnalysisJobError = {
  /** Server exception class and restart flag; optional (absent on older servers). */
  errorClass?: string; interrupted?: boolean;
  message: string;
  httpStatus: number | null;
  phase: AnalysisJobPhase;
  jobId: string | null;
};

export type JobTransition = { state: AnalysisJobState; at: number };

export type JobStateData = {
  status: AnalysisJobState;
  /** 后端分配的 jobId（validating/preparing/submitting 阶段为 null）。 */
  jobId: string | null;
  /** 0-100，未知为 null。 */
  progress: number | null;
  /** 后端轮询返回的原始 status（如 queued/processing），终端前透出给 UI。 */
  remoteStatus: string | null;
  error: AnalysisJobError | null;
  /** 校验通过后的分析结果（unknown 保持与 analysis-guard 解耦）。 */
  result: unknown | null;
  request: AnalysisRequest | null;
  startedAt: number | null;
  completedAt: number | null;
  elapsedMs: number | null;
  pollCount: number;
  /** 最近一次轮询网络错误的文案（不进入终端态，允许重试）。 */
  lastPollError: string | null;
  lastHttpStatus: number | null;
  lastPhase: AnalysisJobPhase | null;
  /** 每次 SUBMIT 递增；过期响应凭 jobId 不一致被拒绝并计数。 */
  generation: number;
  staleRejectedCount: number;
  transitions: JobTransition[];
};

export type JobAction =
  | { type: "SUBMIT"; request: AnalysisRequest; now?: number }
  | { type: "VALIDATE_OK"; now?: number }
  | { type: "VALIDATE_FAIL"; message: string; now?: number }
  | { type: "PREPARE_DONE"; now?: number }
  | { type: "SUBMIT_SUCCESS"; jobId: string; now?: number }
  | { type: "SUBMIT_FAIL"; message: string; httpStatus?: number | null; now?: number }
  | { type: "POLL_RESPONSE"; jobId: string; status: string; progress?: number | null; now?: number }
  | { type: "POLL_ERROR"; message: string; now?: number }
  | { type: "SUCCESS"; jobId: string; result: unknown; now?: number }
  | { type: "FAIL"; message: string; jobId?: string | null; httpStatus?: number | null; phase?: AnalysisJobPhase; now?: number }
  | { type: "CANCEL"; now?: number }
  | { type: "TIMEOUT"; now?: number }
  | { type: "RESET"; now?: number };

export const initialJobState: JobStateData = {
  status: "idle",
  jobId: null,
  progress: null,
  remoteStatus: null,
  error: null,
  result: null,
  request: null,
  startedAt: null,
  completedAt: null,
  elapsedMs: null,
  pollCount: 0,
  lastPollError: null,
  lastHttpStatus: null,
  lastPhase: null,
  generation: 0,
  staleRejectedCount: 0,
  transitions: [{ state: "idle", at: 0 }],
};

/** 合法状态转换表（回归测试断言用）。 */
export const LEGAL_TRANSITIONS: Record<AnalysisJobState, AnalysisJobState[]> = {
  idle: ["validating"],
  validating: ["preparing", "failed", "cancelled"],
  preparing: ["submitting", "failed", "cancelled"],
  submitting: ["polling", "failed", "cancelled", "timed_out", "validating"],
  polling: ["polling", "succeeded", "failed", "cancelled", "timed_out", "validating"],
  succeeded: ["validating"],
  failed: ["validating"],
  cancelled: ["validating"],
  timed_out: ["validating"],
};

const TERMINAL: ReadonlySet<AnalysisJobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminalState(s: AnalysisJobState): boolean {
  return TERMINAL.has(s);
}

export function getMusicXml(req: AnalysisRequest): string {
  const v = req.musicxml ?? req.scoreXml;
  return typeof v === "string" ? v : "";
}

export function getAudioPayload(req: AnalysisRequest): string {
  const v = req.audio ?? req.audioWavBase64;
  return typeof v === "string" ? v : "";
}

/** 提交前置校验：返回 null 表示通过，否则返回错误文案。 */
export function validateAnalysisRequest(req: AnalysisRequest): string | null {
  if (!req || typeof req !== "object") return "请求体为空 / empty request";
  if (!getMusicXml(req)) return "缺少 MusicXML / missing MusicXML";
  if (!getAudioPayload(req)) return "缺少音频 / missing audio";
  if (typeof req.instrument !== "string" || !req.instrument)
    return "缺少乐器参数 / missing instrument";
  if (!Number.isFinite(req.bpm) || (req.bpm as number) < 30 || (req.bpm as number) > 200)
    return "BPM 须为 30–200 / BPM must be 30–200";
  if (!Number.isInteger(req.startMeasure) || (req.startMeasure as number) < 0)
    return "startMeasure 非法 / invalid startMeasure";
  return null;
}

function stamp(
  state: JobStateData,
  status: AnalysisJobState,
  now: number,
  patch: Partial<JobStateData> = {},
): JobStateData {
  const terminal = TERMINAL.has(status);
  const startedAt = state.startedAt;
  const completedAt = terminal ? now : null;
  return {
    ...state,
    ...patch,
    status,
    completedAt,
    elapsedMs: terminal && startedAt != null ? now - startedAt : null,
    lastPhase: patch.lastPhase ?? state.lastPhase,
    transitions: [...state.transitions, { state: status, at: now }],
  };
}

function err(
  message: string,
  phase: AnalysisJobPhase,
  jobId: string | null,
  httpStatus: number | null = null,
): AnalysisJobError {
  return { message, httpStatus, phase, jobId };
}

function mismatch(state: JobStateData, jobId: string): boolean {
  // jobId 为空的旧数据一律视为过期；未分配 jobId 时也不接受带 jobId 的响应。
  if (!jobId || state.jobId == null) return true;
  return state.jobId !== jobId;
}

export function jobReducer(state: JobStateData, action: JobAction): JobStateData {
  const now = action.now ?? Date.now();
  switch (action.type) {
    case "SUBMIT": {
      // 新任务提交时取消旧任务：任何状态都可重新进入 validating，
      // 旧 jobId 即刻失效，后续过期响应凭 jobId 不一致被拒绝。
      const generation = state.generation + 1;
      return {
        ...initialJobState,
        generation,
        request: action.request,
        startedAt: now,
        lastPhase: "validating",
        transitions: [...state.transitions, { state: "validating", at: now }],
        status: "validating",
      };
    }
    case "VALIDATE_OK": {
      if (state.status !== "validating") return state;
      return stamp(state, "preparing", now, { lastPhase: "preparing" });
    }
    case "VALIDATE_FAIL": {
      if (state.status !== "validating") return state;
      return stamp(state, "failed", now, {
        error: err(action.message, "validating", null),
        lastHttpStatus: null,
        lastPhase: "validating",
      });
    }
    case "PREPARE_DONE": {
      if (state.status !== "preparing") return state;
      return stamp(state, "submitting", now, { lastPhase: "submitting" });
    }
    case "SUBMIT_SUCCESS": {
      if (state.status !== "submitting") return state;
      if (!action.jobId) {
        return stamp(state, "failed", now, {
          error: err("分析服务返回了无效任务 / invalid job", "submitting", null),
          lastPhase: "submitting",
        });
      }
      // 同一 jobId 重复提交成功视为幂等：保持 polling，不重置计数。
      return stamp(state, "polling", now, {
        jobId: action.jobId,
        progress: null,
        remoteStatus: null,
        pollCount: 0,
        lastPollError: null,
        lastPhase: "polling",
      });
    }
    case "SUBMIT_FAIL": {
      if (state.status !== "submitting" && state.status !== "validating" && state.status !== "preparing")
        return state;
      return stamp(state, "failed", now, {
        error: err(action.message, "submitting", null, action.httpStatus ?? null),
        lastHttpStatus: action.httpStatus ?? null,
        lastPhase: "submitting",
      });
    }
    case "POLL_RESPONSE": {
      if (state.status !== "polling") return state;
      if (mismatch(state, action.jobId)) {
        return { ...state, staleRejectedCount: state.staleRejectedCount + 1 };
      }
      const progress =
        typeof action.progress === "number" && Number.isFinite(action.progress)
          ? Math.max(0, Math.min(100, action.progress))
          : state.progress;
      // 终端态由 SUCCESS/FAIL 动作驱动；这里只更新远端状态与进度并计数。
      if (action.status === "failed") {
        return stamp(state, "failed", now, {
          remoteStatus: action.status,
          progress,
          pollCount: state.pollCount + 1,
          error: err("分析任务失败 / job failed", "polling", state.jobId),
          lastPhase: "polling",
        });
      }
      return {
        ...state,
        remoteStatus: action.status,
        progress,
        pollCount: state.pollCount + 1,
        lastPollError: null,
        lastPhase: "polling",
      };
    }
    case "POLL_ERROR": {
      // 网络错误只记录不进入失败，允许下一次轮询重试。
      if (state.status !== "polling") return state;
      return { ...state, lastPollError: action.message, pollCount: state.pollCount + 1, lastPhase: "polling" };
    }
    case "SUCCESS": {
      if (state.status !== "polling") return state;
      if (mismatch(state, action.jobId)) {
        return { ...state, staleRejectedCount: state.staleRejectedCount + 1 };
      }
      return stamp(state, "succeeded", now, {
        result: action.result,
        error: null,
        lastPhase: "polling",
      });
    }
    case "FAIL": {
      if (isTerminalState(state.status)) return state;
      const phase = action.phase ?? (state.status === "polling" ? "polling" : "submitting");
      if (action.jobId != null && state.jobId != null && action.jobId !== state.jobId) {
        return { ...state, staleRejectedCount: state.staleRejectedCount + 1 };
      }
      return stamp(state, "failed", now, {
        error: err(action.message, phase, action.jobId ?? state.jobId, action.httpStatus ?? null),
        lastHttpStatus: action.httpStatus ?? state.lastHttpStatus,
        lastPhase: phase,
      });
    }
    case "CANCEL": {
      if (isTerminalState(state.status) || state.status === "idle") return state;
      return stamp(state, "cancelled", now, { lastPhase: state.lastPhase });
    }
    case "TIMEOUT": {
      if (state.status !== "polling" && state.status !== "submitting") return state;
      return stamp(state, "timed_out", now, {
        error: err("分析任务超时 / job timed out", "polling", state.jobId),
        lastPhase: "polling",
      });
    }
    case "RESET": {
      return {
        ...initialJobState,
        generation: state.generation + 1,
        transitions: [...state.transitions, { state: "idle", at: now }],
      };
    }
    default:
      return state;
  }
}

/** 脱离 React 的最小状态机容器（回归测试/脚本用）。 */
export function createJobStateMachine(seed: Partial<JobStateData> = {}) {
  let current: JobStateData = {
    ...initialJobState,
    ...seed,
    transitions: [...initialJobState.transitions, ...((seed.transitions as JobTransition[] | undefined) ?? [])],
  };
  return {
    getState(): JobStateData {
      return current;
    },
    dispatch(action: JobAction): JobStateData {
      current = jobReducer(current, action);
      return current;
    },
    reset(now?: number): JobStateData {
      current = jobReducer(current, { type: "RESET", now });
      return current;
    },
  };
}
