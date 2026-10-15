"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  initialJobState,
  isTerminalState,
  jobReducer,
  validateAnalysisRequest,
  type AnalysisJobError,
  type AnalysisJobState,
  type AnalysisRequest,
} from "@/lib/analysis-job-state";
import { isValidAnalysisResult, isValidJobEnvelope } from "@/lib/analysis-guard";

export type { AnalysisJobState, AnalysisJobError, AnalysisRequest };

type AnalysisResult = Record<string, unknown>;

export type UseAnalysisJobConfig = {
  /** 分析服务根地址，如 http://127.0.0.1:8765（hook 内拼 /jobs）。 */
  endpoint: string;
  /** 轮询间隔毫秒，默认 1500。 */
  pollingInterval?: number;
  /** 最大轮询时长毫秒，默认 120000。 */
  timeout?: number;
  onSuccess?: (result: AnalysisResult) => void;
  onError?: (error: AnalysisJobError) => void;
  /** 测试注入；默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
};

type JobEnvelope = { id: string; status: string; progress?: number; error?: string; result?: unknown;
  errorClass?: string; stage?: string; interrupted?: boolean };

function normalizeBase(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const kind = text.trimStart().startsWith("<") ? "HTML" : "non-JSON data";
    throw new Error(
      `分析服务返回 ${kind}（HTTP ${response.status}），请检查服务地址与访问权限 / Analysis API returned ${kind}; check its URL and access rules`,
    );
  }
}

export function useAnalysisJob(config: UseAnalysisJobConfig) {
  const pollingInterval = config.pollingInterval ?? 1500;
  const timeout = config.timeout ?? 120000;
  const [state, dispatch] = useReducer(jobReducer, initialJobState);

  const endpointRef = useRef(config.endpoint);
  endpointRef.current = config.endpoint;
  const intervalRef = useRef(pollingInterval);
  intervalRef.current = pollingInterval;
  const timeoutRef = useRef(timeout);
  timeoutRef.current = timeout;
  const fetchRef = useRef<typeof fetch | undefined>(config.fetchImpl);
  fetchRef.current = config.fetchImpl;
  const onSuccessRef = useRef(config.onSuccess);
  onSuccessRef.current = config.onSuccess;
  const onErrorRef = useRef(config.onError);
  onErrorRef.current = config.onError;

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (deadlineRef.current) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
  }, []);

  const abortActive = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearTimers();
  }, [clearTimers]);

  // 组件卸载时自动取消未完成任务并清理定时器。
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
      if (deadlineRef.current) clearTimeout(deadlineRef.current);
      timerRef.current = null;
      deadlineRef.current = null;
    };
  }, []);

  const fail = useCallback(
    (message: string, opts: { jobId?: string | null; httpStatus?: number | null; phase?: AnalysisJobError["phase"] } = {}) => {
      const snap = stateRef.current;
      const error: AnalysisJobError = {
        message,
        httpStatus: opts.httpStatus ?? null,
        phase: opts.phase ?? (snap.status === "polling" ? "polling" : "submitting"),
        jobId: opts.jobId ?? snap.jobId,
      };
      if (!mountedRef.current) return error;
      dispatch({ type: "FAIL", message, jobId: error.jobId, httpStatus: error.httpStatus, phase: error.phase });
      try {
        onErrorRef.current?.(error);
      } catch {
        /* 回调异常不得破坏状态机 */
      }
      return error;
    },
    [],
  );

  const cancel = useCallback(() => {
    const snap = stateRef.current;
    if (snap.status === "idle" || isTerminalState(snap.status)) return;
    abortActive();
    if (!mountedRef.current) return;
    dispatch({ type: "CANCEL" });
    // 有意不触发 onError：取消是显式操作，与失败区分。
    if (typeof window !== "undefined" && typeof console !== "undefined") {
      console.log(`[analysis-job] cancelled job=${snap.jobId ?? "-"} polls=${snap.pollCount}`);
    }
  }, [abortActive]);

  const reset = useCallback(() => {
    abortActive();
    if (!mountedRef.current) return;
    dispatch({ type: "RESET" });
  }, [abortActive]);

  const submit = useCallback(
    async (request: AnalysisRequest): Promise<void> => {
      const fetcher = fetchRef.current ?? (globalThis.fetch as typeof fetch | undefined);
      if (!fetcher) {
        fail("fetch 不可用 / fetch unavailable", { phase: "submitting" });
        return;
      }
      // 新任务提交时取消旧任务：先中止旧请求的网络与定时器，
      // 再进入 validating，旧 jobId 的迟到响应会被 reducer 拒绝。
      abortActive();
      const rawEndpoint = endpointRef.current;
      if (!rawEndpoint || !rawEndpoint.trim()) {
        dispatch({ type: "SUBMIT", request });
        dispatch({ type: "VALIDATE_FAIL", message: "请提供分析地址、MusicXML 与录音 / missing API endpoint" });
        fail("请提供分析地址、MusicXML 与录音 / missing API endpoint", { phase: "validating" });
        return;
      }
      dispatch({ type: "SUBMIT", request });
      const invalid = validateAnalysisRequest(request);
      if (invalid) {
        if (!mountedRef.current) return;
        dispatch({ type: "VALIDATE_FAIL", message: invalid });
        fail(invalid, { phase: "validating" });
        return;
      }
      if (!mountedRef.current) return;
      dispatch({ type: "VALIDATE_OK" });
      dispatch({ type: "PREPARE_DONE" });

      const controller = new AbortController();
      abortRef.current = controller;
      const base = normalizeBase(rawEndpoint.trim());
      let jobId: string | null = null;
      try {
        const response = await fetcher(`${base}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const data = await readJson<JobEnvelope>(response);
        if (!response.ok) {
          throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${response.status}`), {
            httpStatus: response.status,
          });
        }
        if (!isValidJobEnvelope(data)) {
          throw new Error("分析服务返回了无效任务 / Analysis service returned an invalid job");
        }
        jobId = data.id;
        if (!mountedRef.current || controller.signal.aborted) return;
        dispatch({ type: "SUBMIT_SUCCESS", jobId });
        if (typeof window !== "undefined" && typeof console !== "undefined") {
          console.log(`[analysis-job] submitted job=${jobId}`);
        }
      } catch (exc) {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (abortRef.current === controller) abortRef.current = null;
        const httpStatus =
          exc && typeof exc === "object" && "httpStatus" in exc && typeof (exc as { httpStatus?: unknown }).httpStatus === "number"
            ? ((exc as { httpStatus: number }).httpStatus as number)
            : null;
        const message = exc instanceof Error ? exc.message : String(exc);
        dispatch({ type: "SUBMIT_FAIL", message, httpStatus });
        try {
          onErrorRef.current?.({ message, httpStatus, phase: "submitting", jobId: null });
        } catch {
          /* noop */
        }
      }
    },
    [abortActive, fail],
  );

  // 轮询副作用：进入 polling 后启动 interval + deadline；离开/卸载时清理。
  // 同一 jobId 只轮询一次：effect 以 jobId 为 key，重复渲染不会重复建 timer。
  useEffect(() => {
    if (state.status !== "polling" || !state.jobId) return;
    const jobId = state.jobId;
    const base = normalizeBase((endpointRef.current || "").trim());
    if (!base) return;
    if (timerRef.current) clearInterval(timerRef.current);
    if (deadlineRef.current) clearTimeout(deadlineRef.current);

    const startedAt = state.startedAt ?? Date.now();
    const remaining = Math.max(0, timeoutRef.current - (Date.now() - startedAt));
    deadlineRef.current = setTimeout(() => {
      const snap = stateRef.current;
      if (snap.status !== "polling" || snap.jobId !== jobId) return;
      abortRef.current?.abort();
      abortRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (!mountedRef.current) return;
      dispatch({ type: "TIMEOUT" });
      try {
        onErrorRef.current?.({ message: "分析任务超时 / job timed out", httpStatus: null, phase: "polling", jobId });
      } catch {
        /* noop */
      }
    }, remaining);

    const tick = async () => {
      const snap = stateRef.current;
      // 新任务已提交（generation 推进但 reducer 世代只增不减，此处凭 jobId 判断）：
      // jobId 不一致即停掉本轮旧 timer，避免旧任务继续轮询。
      if (snap.status !== "polling" || snap.jobId !== jobId) {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      // 超时兜底（deadline 未触发时的时钟偏移保护）。
      if (snap.startedAt != null && Date.now() - snap.startedAt > timeoutRef.current) {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      try {
        const fetcher = fetchRef.current ?? globalThis.fetch;
        const poll = await fetcher(`${base}/jobs/${jobId}`, { signal: abortRef.current?.signal });
        const job = await readJson<JobEnvelope>(poll);
        if (!mountedRef.current) return;
        const latest = stateRef.current;
        if (latest.status !== "polling" || latest.jobId !== jobId) return; // 过期轮询直接丢弃
        if (!poll.ok) {
          dispatch({ type: "FAIL", message: (job as { error?: string }).error || `HTTP ${poll.status}`, jobId, httpStatus: poll.status, phase: "polling" });
          try {
            onErrorRef.current?.({ message: (job as { error?: string }).error || `HTTP ${poll.status}`, httpStatus: poll.status, phase: "polling", jobId });
          } catch {
            /* noop */
          }
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          if (deadlineRef.current) {
            clearTimeout(deadlineRef.current);
            deadlineRef.current = null;
          }
          return;
        }
        if (!isValidJobEnvelope(job)) {
          dispatch({ type: "FAIL", message: "分析服务返回了无效任务 / invalid job", jobId, phase: "polling" });
          try {
            onErrorRef.current?.({ message: "分析服务返回了无效任务 / invalid job", httpStatus: null, phase: "polling", jobId });
          } catch {
            /* noop */
          }
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          if (deadlineRef.current) {
            clearTimeout(deadlineRef.current);
            deadlineRef.current = null;
          }
          return;
        }
        if (job.id !== jobId) return; // 过期结果拒绝：jobId 不匹配
        if (job.status === "completed") {
          if (!isValidAnalysisResult(job.result)) {
            dispatch({ type: "FAIL", message: "分析服务返回了无效结果 / invalid result", jobId, phase: "polling" });
            try {
              onErrorRef.current?.({ message: "分析服务返回了无效结果 / invalid result", httpStatus: null, phase: "polling", jobId });
            } catch {
              /* noop */
            }
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            if (deadlineRef.current) {
              clearTimeout(deadlineRef.current);
              deadlineRef.current = null;
            }
            return;
          }
          dispatch({ type: "SUCCESS", jobId, result: job.result });
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          if (deadlineRef.current) {
            clearTimeout(deadlineRef.current);
            deadlineRef.current = null;
          }
          if (typeof window !== "undefined" && typeof console !== "undefined") {
            console.log(`[analysis-job] succeeded job=${jobId}`);
          }
          try {
            onSuccessRef.current?.(job.result as AnalysisResult);
          } catch {
            /* noop */
          }
          return;
        }
        if (job.status === "failed") {
          dispatch({ type: "FAIL", message: job.error || "分析任务失败 / job failed", jobId, phase: "polling" });
          try {
            onErrorRef.current?.({ message: job.error || "分析任务失败 / job failed", httpStatus: null, phase: "polling", jobId,
              errorClass: typeof job.errorClass === "string" ? job.errorClass : undefined, interrupted: job.interrupted === true });
          } catch {
            /* noop */
          }
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          if (deadlineRef.current) {
            clearTimeout(deadlineRef.current);
            deadlineRef.current = null;
          }
          return;
        }
        dispatch({ type: "POLL_RESPONSE", jobId, status: job.status === "analyzing" && job.stage ? job.stage : job.status, progress: job.progress ?? null });
      } catch (exc) {
        if (!mountedRef.current) return;
        const latest = stateRef.current;
        if (latest.status !== "polling" || latest.jobId !== jobId) return;
        if (exc instanceof DOMException && exc.name === "AbortError") return;
        // 网络错误只记录不立即失败，允许下一次 tick 重试；超时由 deadline 兜底。
        dispatch({ type: "POLL_ERROR", message: exc instanceof Error ? exc.message : String(exc) });
      }
    };

    timerRef.current = setInterval(() => {
      void tick();
    }, intervalRef.current);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (deadlineRef.current) {
        clearTimeout(deadlineRef.current);
        deadlineRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.jobId]);

  const elapsedMs =
    state.elapsedMs ?? (state.startedAt != null ? (state.completedAt ?? Date.now()) - state.startedAt : null);

  return {
    state: state.status as AnalysisJobState,
    jobId: state.jobId,
    remoteStatus: state.remoteStatus,
    progress: state.progress,
    error: state.error,
    result: state.result as AnalysisResult | null,
    submit,
    cancel,
    reset,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    elapsedMs,
    pollCount: state.pollCount,
  };
}
