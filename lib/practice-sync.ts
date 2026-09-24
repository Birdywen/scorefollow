// PracticeSession: single clock shared by metronome, recorder, cursor, analysis.
// scoreTimeSec = (performance.now() - firstBeatAt) / 1000 + scoreOffsetSec
// firstBeatAt = performance.now() timestamp of startMeasure beat 1.
// firstBeatAudioSec = (firstBeatAt - recordingStartedAt) / 1000 in the saved Blob.

export type PracticeState = "idle" | "arming" | "counting-in" | "recording" | "stopping";

export interface PracticeSession {
  id: string;
  startMeasure: number;
  bpm: number;
  beatsPerMeasure: number;
  countInBeats: number;
  scheduledAt: number;
  firstBeatAt: number;
  recordingStartedAt: number | null;
  firstBeatAudioSec: number | null;
  state: PracticeState;
}

export interface TakeMeta {
  id: string;
  name: string;
  createdAt: number;
  durationSec: number;
  startMeasure: number;
  bpm: number;
  beatsPerMeasure: number;
  countInBeats: number;
  firstBeatAudioSec: number;
  sessionId: string;
}

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function createSession(opts: {
  startMeasure: number; bpm: number; beatsPerMeasure: number; countInBeats: number;
}): PracticeSession {
  const now = performance.now();
  const beatSec = 60 / opts.bpm;
  const scheduledAt = now + 120; // small arm window for mic + metro to settle
  return {
    id: newSessionId(),
    startMeasure: opts.startMeasure,
    bpm: opts.bpm,
    beatsPerMeasure: opts.beatsPerMeasure,
    countInBeats: opts.countInBeats,
    scheduledAt,
    firstBeatAt: scheduledAt + opts.countInBeats * beatSec * 1000,
    recordingStartedAt: null,
    firstBeatAudioSec: null,
    state: "arming",
  };
}

export function attachRecordingStart(session: PracticeSession, recordingStartedAt: number): PracticeSession {
  const firstBeatAudioSec = Math.max(0, (session.firstBeatAt - recordingStartedAt) / 1000);
  return { ...session, recordingStartedAt, firstBeatAudioSec, state: "counting-in" };
}

export function markRecording(session: PracticeSession): PracticeSession {
  return { ...session, state: "recording" };
}

export function scoreTimeAt(session: Pick<PracticeSession, "firstBeatAt">, now: number): number {
  return (now - session.firstBeatAt) / 1000;
}

export function beatIndexAt(session: Pick<PracticeSession, "firstBeatAt" | "bpm">, now: number): number {
  return Math.floor((now - session.firstBeatAt) / ((60 / session.bpm) * 1000));
}

export function measureAndBeatAt(
  session: Pick<PracticeSession, "firstBeatAt" | "bpm" | "beatsPerMeasure" | "startMeasure">,
  now: number,
): { measure: number; beat: number; elapsedSec: number } {
  const elapsedSec = (now - session.firstBeatAt) / 1000;
  const beatDur = 60 / session.bpm;
  const totalBeats = Math.max(0, Math.floor(elapsedSec / beatDur));
  return {
    measure: session.startMeasure + Math.floor(totalBeats / session.beatsPerMeasure),
    beat: (totalBeats % session.beatsPerMeasure) + 1,
    elapsedSec,
  };
}

export function validateTakeSync(firstBeatAudioSec: number | null): string | null {
  if (firstBeatAudioSec == null || !Number.isFinite(firstBeatAudioSec)) return "缺少节拍器第一拍时间戳，无法做同步分析";
  if (firstBeatAudioSec < 0 || firstBeatAudioSec > 10) return "第一拍时间戳超出 0–10 秒范围";
  return null;
}

// IndexedDB blob store: metadata lives in React state, audio lives here.
const DB = "scorefollow-practice";
const STORE = "takes";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTakeBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadTakeBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteTakeBlob(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
