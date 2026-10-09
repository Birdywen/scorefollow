"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  initialTunerState,
  tunerReducer,
  type TunerReading,
  type TunerStatus,
} from "@/lib/tuner-state";

export type { TunerReading, TunerStatus };

// 与原 TunerPanel 完全一致的常量：改动即跑调/拒噪门限变化，禁止修改。
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const MIN_HZ = 55; // below cello C1-ish floor, reject rumble
export const MAX_HZ = 1400; // above violin E7-ish ceiling, reject hiss
export const IN_TUNE_CENTS = 6;

// 音高检测算法：与原 TunerPanel 逐行一致（自相关 + 抛物线插值 + RMS 静音门）。
export function freqToReading(freq: number): TunerReading {
  const m = 69 + 12 * Math.log2(freq / 440);
  const r = Math.round(m);
  return { note: `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`, cents: Math.round((m - r) * 100), hz: freq };
}

export function detectPitch(buf: Float32Array, sampleRate: number): number | null {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  if (Math.sqrt(sum / buf.length) < 0.01) return null; // silence gate
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxLag = Math.min(buf.length >> 1, Math.ceil(sampleRate / MIN_HZ));
  let bestLag = -1, bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < buf.length; i++) corr += buf[i] * buf[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  if (bestLag < 0) return null;
  // Parabolic interpolation around the peak for sub-sample lag.
  const c = (lag: number) => {
    let v = 0;
    for (let i = 0; i + lag < buf.length; i++) v += buf[i] * buf[i + lag];
    return v;
  };
  const y0 = c(bestLag - 1), y1 = bestCorr, y2 = c(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (y0 - y2) / (2 * denom) : 0;
  const lag = Math.abs(shift) < 1 ? bestLag + shift : bestLag;
  return sampleRate / lag;
}

export type UseTunerConfig = {
  onError?: (error: string) => void;
};

export function useTuner(config: UseTunerConfig = {}) {
  const [state, dispatch] = useReducer(tunerReducer, initialTunerState);

  const stateRef = useRef(state);
  stateRef.current = state;
  const onErrorRef = useRef(config.onError);
  onErrorRef.current = config.onError;

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const smoothRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const cleanupResources = useCallback(async () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    smoothRef.current = [];
    if (ctxRef.current) {
      try {
        await ctxRef.current.close();
      } catch {
        /* noop */
      }
      ctxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  // 组件卸载时自动清理所有资源。
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      smoothRef.current = [];
      if (ctxRef.current) {
        void ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const start = useCallback(async (): Promise<void> => {
    const snap = stateRef.current;
    if (snap.status === "requesting" || snap.status === "running" || snap.status === "stopping") return;
    dispatch({ type: "REQUEST_START" });
    const generation = snap.generation + 1;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("浏览器不支持麦克风 / Microphone not supported");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      // 发起后被 reset/stop：释放刚拿到的流并直接返回，避免过期资源泄漏。
      if (!mountedRef.current || stateRef.current.generation !== generation) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      if (!mountedRef.current || stateRef.current.generation !== generation) {
        stream.getTracks().forEach((t) => t.stop());
        try {
          await ctx.close();
        } catch {
          /* noop */
        }
        return;
      }
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      streamRef.current = stream;
      ctxRef.current = ctx;
      lastRef.current = 0;
      smoothRef.current = [];
      if (!mountedRef.current || stateRef.current.generation !== generation) {
        await cleanupResources();
        return;
      }
      dispatch({ type: "START_SUCCESS" });
      const loop = () => {
        if (!mountedRef.current) return;
        if (stateRef.current.status !== "running") return;
        rafRef.current = requestAnimationFrame(loop);
        const now = performance.now();
        if (now - lastRef.current < 100) return; // 10 fps is plenty for a needle
        lastRef.current = now;
        analyser.getFloatTimeDomainData(buf);
        const f = detectPitch(buf, ctx.sampleRate);
        if (f == null) {
          dispatch({ type: "CLEAR_READING" });
          return;
        }
        const hist = smoothRef.current;
        hist.push(f);
        if (hist.length > 3) hist.shift();
        const med = [...hist].sort((a, b) => a - b)[hist.length >> 1];
        dispatch({ type: "UPDATE_READING", reading: freqToReading(med) });
      };
      loop();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await cleanupResources();
      if (!mountedRef.current) return;
      // 若等待期间已被 reset（generation 变化），不再覆盖新状态。
      if (stateRef.current.generation !== generation) return;
      dispatch({ type: "START_FAIL", message });
      try {
        onErrorRef.current?.(message);
      } catch {
        /* 回调异常不得破坏状态机 */
      }
    }
  }, [cleanupResources]);

  const stop = useCallback(async (): Promise<void> => {
    const snap = stateRef.current;
    if (snap.status === "running" || snap.status === "requesting") {
      dispatch({ type: "STOP" });
    }
    await cleanupResources();
    if (!mountedRef.current) return;
    if (stateRef.current.status === "stopping") {
      dispatch({ type: "STOP_DONE" });
    }
  }, [cleanupResources]);

  const reset = useCallback((): void => {
    void cleanupResources();
    if (!mountedRef.current) return;
    dispatch({ type: "RESET" });
  }, [cleanupResources]);

  return {
    state: state.status,
    reading: state.reading,
    error: state.error,
    start,
    stop,
    reset,
  };
}
