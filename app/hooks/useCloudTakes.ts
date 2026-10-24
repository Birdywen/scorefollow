"use client";
/** Keeps a signed-in user's takes (audio + report) mirrored to the cloud; local data always wins and works offline. */
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteCloudTake, fetchSnapshot, planMerge, pullTake, pushTake, scoreKeyOf, type CloudTake } from "../../lib/cloud-sync";

export type CloudStatus = "off" | "syncing" | "ok" | "error";
type TakeLike = { id: string; createdAt: number; blob: Blob | null; result?: unknown };
export type PulledTake = { id: string; createdAt: number; meta: Record<string, unknown>; blob: Blob; result: unknown | null };

const RETRY_MS = 30_000;

export function useCloudTakes<T extends TakeLike>({ base, scoreName, takes, max, metaOf, onPull }: {
  base: string;                       // "" when signed out
  scoreName: string;
  takes: T[];
  max: number;
  metaOf: (take: T) => Record<string, unknown>;
  onPull: (take: PulledTake) => void;
}): { status: CloudStatus; remove: (id: string) => void } {
  const [status, setStatus] = useState<CloudStatus>("off");
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);          // re-run the sign-in sync (retry)
  const [pushTick, setPushTick] = useState(0);    // re-check for unsent takes
  const synced = useRef(new Map<string, boolean>());   // take id -> report already in the cloud
  const takesRef = useRef(takes); takesRef.current = takes;
  const onPullRef = useRef(onPull); onPullRef.current = onPull;
  const metaRef = useRef(metaOf); metaRef.current = metaOf;
  const busy = useRef(false);

  // 1) On sign-in: learn what the cloud has and pull what this device lacks.
  useEffect(() => {
    synced.current = new Map();
    setReady(false);
    if (!base) { setStatus("off"); return; }
    let cancelled = false;
    setStatus("syncing");
    (async () => {
      try {
        const snap = await fetchSnapshot(base);
        if (cancelled) return;
        const { pull, known } = planMerge(takesRef.current.map((t) => t.id), snap.takes, max);
        synced.current = new Map(known);
        for (const ct of pull as CloudTake[]) {
          try {
            const got = await pullTake(base, ct);
            if (cancelled) return;
            onPullRef.current({ id: ct.id, createdAt: ct.created, meta: ct.meta, blob: got.blob, result: got.result });
          } catch { synced.current.delete(ct.id); }
        }
        if (!cancelled) { setReady(true); setStatus("ok"); }
      } catch {
        if (!cancelled) { setStatus("error"); setTimeout(() => !cancelled && setTick((n) => n + 1), RETRY_MS); }
      }
    })();
    return () => { cancelled = true; };
  }, [base, max, tick]);

  // 2) Push local takes the cloud lacks (or whose report is newer), one at a time.
  useEffect(() => {
    if (!base || !ready || busy.current) return;
    // Unsent: cloud has no copy, or it has the audio but still lacks this take's report.
    const todo = takes.filter((t) => t.blob && (!synced.current.has(t.id) || (Boolean(t.result) && synced.current.get(t.id) === false)));
    if (!todo.length) return;
    busy.current = true;
    setStatus("syncing");
    let cancelled = false;
    (async () => {
      try {
        for (const t of todo) {
          await pushTake(base, { id: t.id, scoreKey: scoreKeyOf(scoreName), created: t.createdAt, meta: metaRef.current(t),
            blob: t.blob as Blob, result: (t.result ?? null) as { summary?: unknown } | null });
          synced.current.set(t.id, Boolean(t.result));
        }
        if (!cancelled) setStatus("ok");
        setPushTick((n) => n + 1);   // takes may have changed while we were uploading
      } catch {
        if (!cancelled) { setStatus("error"); setTimeout(() => setPushTick((n) => n + 1), RETRY_MS); }
      } finally {
        busy.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [base, ready, takes, scoreName, pushTick]);

  const remove = useCallback((id: string) => {
    synced.current.delete(id);
    if (base) void deleteCloudTake(base, id).catch(() => undefined);
  }, [base]);

  return { status, remove };
}
