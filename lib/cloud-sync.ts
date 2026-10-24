/** Cloud copy of takes (audio + report): content-addressed blobs and small records over /api/account/. */
import { accountBase } from "./account";

export type CloudTake = {
  id: string; scoreKey: string; audioSha: string; created: number; updated: number;
  meta: Record<string, unknown>; hasResult: boolean;
};
export type CloudScore = { id: string; title: string; kind: "pdf" | "xml" | "abc"; fileSha: string; updated: number; edits: Record<string, unknown> };
export type Snapshot = { takes: CloudTake[]; scores: CloudScore[]; usedBytes: number; quotaBytes: number };

export class CloudHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable key that groups takes of one piece: file name without extension, lower-cased. */
export function scoreKeyOf(name: string): string {
  return name.trim().replace(/\.(pdf|musicxml|xml|abc)$/i, "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
}

/**
 * Local-first merge. `pull` = cloud takes this device lacks (newest first, capped so the local list
 * never exceeds `max`); the caller uploads whatever it holds that the cloud lacks.
 */
export function planMerge(localIds: string[], cloud: CloudTake[], max: number): { pull: CloudTake[]; known: Map<string, boolean> } {
  const have = new Set(localIds);
  const room = Math.max(0, max - localIds.length);
  const pull = cloud.filter((t) => !have.has(t.id)).sort((a, b) => b.created - a.created).slice(0, room);
  return { pull, known: new Map(cloud.map((t) => [t.id, t.hasResult])) };
}

async function call(base: string, method: string, path: string, body?: Blob | object): Promise<Response> {
  const isBlob = body instanceof Blob;
  const response = await fetch(accountBase(base) + path, {
    method, credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": isBlob ? "application/octet-stream" : "application/json" },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
  });
  return response;
}

async function ok(response: Response): Promise<Response> {
  if (response.ok) return response;
  let data: { error?: string; code?: string } = {};
  try { data = await response.json(); } catch { /* not JSON */ }
  throw new CloudHttpError(data.error || `HTTP ${response.status}`, response.status, data.code || "http");
}

export async function fetchSnapshot(base: string): Promise<Snapshot> {
  return (await ok(await call(base, "GET", "/sync"))).json();
}

async function putBlob(base: string, blob: Blob): Promise<string> {
  const sha = await sha256Hex(blob);
  const head = await call(base, "HEAD", `/blobs/${sha}`);
  if (head.status !== 200) await ok(await call(base, "PUT", `/blobs/${sha}`, blob));
  return sha;
}

export async function pushTake(base: string, take: {
  id: string; scoreKey: string; created: number; meta: Record<string, unknown>; blob: Blob; result?: { summary?: unknown } | null;
}): Promise<void> {
  const audioSha = await putBlob(base, take.blob);
  await ok(await call(base, "PUT", `/takes/${encodeURIComponent(take.id)}`,
    { audioSha, scoreKey: take.scoreKey, created: take.created, meta: take.meta }));
  if (take.result && typeof take.result.summary === "object") {
    try {
      await ok(await call(base, "PUT", `/takes/${encodeURIComponent(take.id)}/result`, { summary: take.result.summary, result: take.result }));
    } catch (e) {
      if (!(e instanceof CloudHttpError && e.status === 413)) throw e;   // report too big: keep the take, skip the report
    }
  }
}

export async function pullTake(base: string, take: CloudTake): Promise<{ blob: Blob; result: unknown | null }> {
  const blob = await (await ok(await call(base, "GET", `/blobs/${take.audioSha}`))).blob();
  if (await sha256Hex(blob) !== take.audioSha) throw new Error("cloud audio failed its integrity check");
  let result: unknown = null;
  if (take.hasResult) {
    const response = await call(base, "GET", `/takes/${encodeURIComponent(take.id)}/result`);
    if (response.ok) result = (await response.json()).result ?? null;
  }
  return { blob, result };
}

/** Upload a score file (PDF) and its record; the id is the content fingerprint, so re-uploads are no-ops. */
export async function pushScore(base: string, score: { title: string; kind: CloudScore["kind"]; blob: Blob; edits?: Record<string, unknown> }): Promise<string> {
  const fileSha = await putBlob(base, score.blob);
  const id = fileSha.slice(0, 32);
  await ok(await call(base, "PUT", `/scores/${id}`, { title: score.title, kind: score.kind, fileSha, edits: score.edits ?? {} }));
  return id;
}

export async function pullScoreBlob(base: string, score: CloudScore): Promise<Blob> {
  const blob = await (await ok(await call(base, "GET", `/blobs/${score.fileSha}`))).blob();
  if (await sha256Hex(blob) !== score.fileSha) throw new Error("cloud score failed its integrity check");
  return blob;
}

export async function deleteCloudScore(base: string, id: string): Promise<void> {
  const response = await call(base, "DELETE", `/scores/${encodeURIComponent(id)}`);
  if (response.status !== 404) await ok(response);
}

export type HistoryPoint = { id: string; t: number; pitch: number | null; rhythm: number | null };

/** Chart series from /history rows: oldest first, scores kept only when they are finite numbers in 0..100. */
export function historySeries(rows: { id: string; created: number; summary?: { pitchScore?: unknown; rhythmScore?: unknown } | null }[]): HistoryPoint[] {
  const score = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
  return rows
    .map((r) => ({ id: r.id, t: r.created, pitch: score(r.summary?.pitchScore), rhythm: score(r.summary?.rhythmScore) }))
    .filter((p) => p.pitch != null || p.rhythm != null)
    .sort((a, b) => a.t - b.t);
}

export async function fetchHistory(base: string, scoreKey: string): Promise<HistoryPoint[]> {
  const data = await (await ok(await call(base, "GET", `/history?scoreKey=${encodeURIComponent(scoreKey)}`))).json();
  return historySeries(data.takes ?? []);
}

export async function deleteCloudTake(base: string, id: string): Promise<void> {
  const response = await call(base, "DELETE", `/takes/${encodeURIComponent(id)}`);
  if (response.status !== 404) await ok(response);
}
