/** 调音器纯状态机（不依赖 React/DOM，可独立测试）。
 * TunerPanel 的麦克风请求/启动/停止/读数更新全部经由这里的状态转换驱动，
 * 副作用（getUserMedia/AudioContext/rAF）由 app/hooks/useTuner 承担。
 */

export type TunerStatus =
  | "idle"
  | "requesting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type TunerReading = {
  note: string;
  cents: number;
  hz: number;
};

export type TunerState = {
  status: TunerStatus;
  error: string | null;
  reading: TunerReading | null;
  startedAt: number | null;
  stoppedAt: number | null;
  generation: number;
};

export type TunerAction =
  | { type: "REQUEST_START"; now?: number }
  | { type: "START_SUCCESS"; now?: number }
  | { type: "START_FAIL"; message: string; now?: number }
  | { type: "STOP"; now?: number }
  | { type: "STOP_DONE"; now?: number }
  | { type: "UPDATE_READING"; reading: TunerReading; now?: number }
  | { type: "CLEAR_READING"; now?: number }
  | { type: "RESET"; now?: number };

export const initialTunerState: TunerState = {
  status: "idle",
  error: null,
  reading: null,
  startedAt: null,
  stoppedAt: null,
  generation: 0,
};

/** 合法状态转换表（回归测试断言用）。 */
export const LEGAL_TRANSITIONS: Record<TunerStatus, TunerStatus[]> = {
  idle: ["requesting"],
  requesting: ["running", "failed", "stopping"],
  running: ["running", "stopping"],
  stopping: ["stopped"],
  stopped: ["requesting", "idle"],
  failed: ["requesting", "idle"],
};

export function tunerReducer(state: TunerState, action: TunerAction): TunerState {
  const now = action.now ?? Date.now();
  switch (action.type) {
    case "REQUEST_START": {
      // 仅 idle / stopped / failed 可发起新一轮请求；进行中忽略，避免重复申请麦克风。
      if (state.status !== "idle" && state.status !== "stopped" && state.status !== "failed") {
        return state;
      }
      return {
        ...state,
        status: "requesting",
        error: null,
        reading: null,
        startedAt: null,
        stoppedAt: null,
        generation: state.generation + 1,
      };
    }
    case "START_SUCCESS": {
      if (state.status !== "requesting") return state;
      return {
        ...state,
        status: "running",
        error: null,
        startedAt: now,
        stoppedAt: null,
      };
    }
    case "START_FAIL": {
      if (state.status !== "requesting") return state;
      return {
        ...state,
        status: "failed",
        error: action.message,
        reading: null,
      };
    }
    case "STOP": {
      // 运行中或请求中可取消；其余状态忽略。
      if (state.status !== "running" && state.status !== "requesting") return state;
      return { ...state, status: "stopping" };
    }
    case "STOP_DONE": {
      if (state.status !== "stopping") return state;
      return { ...state, status: "stopped", stoppedAt: now };
    }
    case "UPDATE_READING": {
      // 仅运行中接受读数；静默/未启动时的迟到帧一律忽略。
      if (state.status !== "running") return state;
      return { ...state, reading: action.reading };
    }
    case "CLEAR_READING": {
      // 静音门限触发时清空读数；非运行态忽略。
      if (state.status !== "running") return state;
      if (state.reading === null) return state;
      return { ...state, reading: null };
    }
    case "RESET": {
      return {
        ...initialTunerState,
        generation: state.generation + 1,
      };
    }
    default:
      return state;
  }
}

/** 脱离 React 的最小状态机容器（回归测试/脚本用）。 */
export function createTunerStateMachine(seed: Partial<TunerState> = {}) {
  let current: TunerState = { ...initialTunerState, ...seed };
  return {
    getState(): TunerState {
      return current;
    },
    dispatch(action: TunerAction): TunerState {
      current = tunerReducer(current, action);
      return current;
    },
    reset(now?: number): TunerState {
      current = tunerReducer(current, { type: "RESET", now });
      return current;
    },
  };
}
