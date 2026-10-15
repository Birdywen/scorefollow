"""Analysis API: python3 -m analysis_service.server.

Bind to loopback by default; main initializes private durable job storage.
"""

import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
import logging
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit
from uuid import uuid4

from . import vamp_features
from .engine import MAX_FIRST_BEAT_SECONDS, analyze, parse_score, read_wav, validate_measure_sync
from .omr import MAX_PDF, recognize
from .quality import QUALITY_VERSION, assess_quality
from .engine import VERSION as STRING_VERSION, crepe_backend
from .job_store import JobStore, QueueFull, TERMINAL

MAX_BODY = 16_000_000
MAX_OMR_BODY = 21_000_000
TTL = 3600
jobs: dict[str, dict] = {}
lock = threading.Lock()
pool = ThreadPoolExecutor(max_workers=2)
job_store: JobStore | None = None  # Initialized by main, never during import/test discovery.
allowed_origins = set(os.getenv(
    "ANALYSIS_ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://150.136.51.61,https://ezmusicstore.com",
).split(","))
# Shared secret for the store relay (X-Analysis-Token header). Empty = open (local dev/tests).
API_TOKEN = os.environ.get("ANALYSIS_API_TOKEN", "")
logger = logging.getLogger("scorefollow.analysis")


def log_event(event: str, job_id: str, **fields) -> None:
    # No filenames, audio, XML, tokens or exception messages in structured logs.
    logger.info(json.dumps({"event": event, "analysisId": job_id, **fields}, allow_nan=False))


def update_job(job_id: str, change: dict) -> None:
    with lock:
        if job_store is not None and job_store.contains(job_id):
            job_store.update(job_id, change)
            jobs[job_id].update({key: value for key, value in change.items() if key != "result"})
        else:
            jobs[job_id].update(change)


def fail_job(job_id: str, change: dict) -> None:
    try:
        update_job(job_id, change)
    except Exception:
        # Failed persistence must never publish an uncommitted completed result.
        change.update(status="failed", errorClass="StorageError", error="任务保存失败，请稍后重新提交。")
        with lock:
            jobs[job_id].update(change)


def run(job_id: str, audio: bytes, xml: str, bpm: float, instrument: str, start_measure: int,
        first_beat_audio_sec: float | None = None, sync_mode: str = "legacy", measure_sync=None,
        pitch_tolerance_cents: float = 25.0) -> None:
    started = time.monotonic()
    parameters = json.dumps([bpm, instrument, start_measure, first_beat_audio_sec,
                             sync_mode, measure_sync, pitch_tolerance_cents], sort_keys=True)
    fingerprint = hashlib.sha256(audio + xml.encode("utf-8") + parameters.encode()).hexdigest()
    stage = "preparing"
    stage_ms = {}
    try:
        update_job(job_id, {"status": "analyzing", "stage": stage, "startedAt": time.time(), "inputHash": fingerprint})
        log_event("started", job_id, inputHash=fingerprint)
        if instrument == "piano":
            stage = "transcribing"
            update_job(job_id, {"stage": stage})
            # 钢琴走独立复音通道: 转录即传感器, 不经过单声部 FFT 管道
            from .piano_engine import analyze_piano
            result = analyze_piano(audio, xml, bpm, start_measure)
            # Piano does not depend on vamp plugins; report no vamp degradation.
            summary = result.get("summary", {})
            summary.setdefault("degraded", False)
            summary.setdefault("degradedReasons", [])
        else:
            stage = "extracting_features"
            update_job(job_id, {"stage": stage})
            # 有 Vamp 插件就用 pYIN+QM 当耳朵, 没有则引擎退回自研检测(前端无感)
            t_stage = time.monotonic()
            pitch_notes, onset_hint, beat_map = vamp_features.extract_all(audio)
            stage_ms["features"] = round((time.monotonic() - t_stage) * 1000)
            stage = "aligning_and_scoring"
            update_job(job_id, {"stage": stage})
            t_stage = time.monotonic()
            result = analyze(audio, xml, bpm, instrument, start_measure, first_beat_audio_sec, sync_mode,
                             pitch_notes=pitch_notes, onset_hint=onset_hint, beat_map=beat_map, 
                             measure_sync=measure_sync, pitch_tolerance_cents=pitch_tolerance_cents)
            stage_ms["align"] = round((time.monotonic() - t_stage) * 1000)
            # Defensive overlay: engine already sets summary.degraded from
            # effective availability; keep it, only fill if missing so the
            # job payload always exposes degradation (not logs only).
            summary = result.get("summary", {})
            if "degraded" not in summary or "degradedReasons" not in summary:
                effective_beat = beat_map if summary.get("syncMode") == "vamp-beat" else None
                reasons = vamp_features.degradation_reasons(pitch_notes, onset_hint, effective_beat)
                summary.setdefault("degraded", bool(reasons))
                summary.setdefault("degradedReasons", reasons)
        result["quality"] = assess_quality(result)
        elapsed = round((time.monotonic() - started) * 1000)
        result["diagnostics"] = {"analysisId": job_id, "algorithmVersion": result["version"],
                                 "inputHash": fingerprint, "elapsedMs": elapsed, "stageMs": stage_ms}
        update = {"status": "completed", "stage": "completed", "result": result,
                  "finishedAt": time.time(), "elapsedMs": elapsed}
        stage = "persisting_result"
        update_job(job_id, update)
        log_event("completed", job_id, algorithmVersion=result["version"], elapsedMs=elapsed,
                  outcome=result["quality"]["outcome"], rescueReasons=summary.get("rescueReasons", []),
                  degraded=bool(summary.get("degraded")), degradedReasons=summary.get("degradedReasons") or [],
                  issues=result["quality"].get("issues", []), instrument=instrument, stageMs=stage_ms)
    except Exception as exc:
        elapsed = round((time.monotonic() - started) * 1000)
        update = {"status": "failed", "stage": stage, "errorClass": type(exc).__name__,
                  "finishedAt": time.time(), "elapsedMs": elapsed,
                  "error": str(exc) if isinstance(exc, ValueError) else "分析失败，请检查音频和谱面"}
        log_event("failed", job_id, stage=stage, errorClass=type(exc).__name__, elapsedMs=elapsed, stageMs=stage_ms)
        fail_job(job_id, update)


def run_omr(job_id: str, pdf: bytes, filename: str, rest_beats: int | None) -> None:
    def update(status: str, percent: float) -> None:
        update_job(job_id, {"status": status, "stage": status, "progress": percent})
    try:
        update_job(job_id, {"status": "uploading", "stage": "uploading"})
        result = recognize(pdf, filename, rest_beats, update)
        change = {"status": "completed", "stage": "completed", "progress": 100, "result": result,
                  "finishedAt": time.time()}
        update_job(job_id, change)
    except Exception as exc:
        change = {"status": "failed", "errorClass": type(exc).__name__, "finishedAt": time.time(),
                  "error": str(exc) if isinstance(exc, ValueError) else "OMR 识别失败，请稍后重试"}
        fail_job(job_id, change)


class Handler(BaseHTTPRequestHandler):
    def cors(self) -> bool:
        origin = self.headers.get("Origin")
        if origin and origin not in allowed_origins:
            self.send_error(403, "Origin not allowed")
            return False
        return True

    def authorized(self) -> bool:
        if not API_TOKEN:
            return True
        return self.headers.get("X-Analysis-Token") == API_TOKEN

    def respond(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(code)
        origin = self.headers.get("Origin")
        if origin in allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        if not self.cors():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_POST(self) -> None:
        if not self.cors():
            return
        if not self.authorized():
            self.respond(401, {"error": "未授权"})
            return
        path = urlsplit(self.path).path
        if path not in ("/jobs", "/omr/jobs"):
            self.respond(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= (MAX_OMR_BODY if path == "/omr/jobs" else MAX_BODY):
                raise ValueError("请求过大或缺少内容")
            request = json.loads(self.rfile.read(length))
            if path == "/omr/jobs":
                pdf = base64.b64decode(request["pdfBase64"], validate=True)
                filename = request["filename"]
                if len(pdf) > MAX_PDF or not pdf.startswith(b"%PDF-") or not isinstance(filename, str) or len(filename) > 180 or not filename.lower().endswith(".pdf"):
                    raise ValueError("请上传不超过 15 MB 的 PDF")
                rest_beats = request.get("prependRestBeats")
                if rest_beats is not None and (type(rest_beats) is not int or not 1 <= rest_beats <= 16):
                    raise ValueError("补回整休止需要 1–16 个四分音符拍")
            else:
                audio = base64.b64decode(request["audioWavBase64"], validate=True)
                if len(audio) > 10_000_000:
                    raise ValueError("音频超过 10 MB")
                xml = request["scoreXml"]
                if not isinstance(xml, str):
                    raise ValueError("请上传 MusicXML")
                notes = parse_score(xml)
                bpm = float(request["bpm"])
                instrument = request["instrument"]
                start_measure = request.get("startMeasure", 1)
                # Automatic Vamp beat tracking is the normal path. The user BPM
                # remains the fallback when the optional beat detector is absent.
                sync_mode = request.get("syncMode", "vamp-beat")
                first_beat = request.get("firstBeatAudioSec")
                measure_sync = request.get("measureSync")
                pitch_tolerance_cents = request.get("pitchToleranceCents", 25.0)
                if not isinstance(pitch_tolerance_cents, (int, float)) or not 10 <= pitch_tolerance_cents <= 50:
                    raise ValueError("pitchToleranceCents 须在 10–50 音分之间")
                if instrument not in ("violin", "viola", "cello", "piano") or not 30 <= bpm <= 200:
                    raise ValueError("无效的乐器或 BPM")
                if type(start_measure) is not int or not 0 <= start_measure <= notes[-1]["measure"]:
                    raise ValueError("开始小节没有可演奏音符")
                if start_measure == 0 and (instrument == "piano" or sync_mode == "metronome" or first_beat is not None):
                    raise ValueError("自动定位仅支持未同步的单声部录音")
                if sync_mode not in ("legacy", "metronome", "vamp-beat", "manual-measures"):
                    raise ValueError("无效的同步模式")
                if sync_mode == "manual-measures":
                    if instrument == "piano" or start_measure == 0 or first_beat is not None:
                        raise ValueError("Manual measure sync requires a monophonic instrument, explicit start measure and no metronome anchor")
                    signal, rate = read_wav(audio)
                    validate_measure_sync(measure_sync, xml, len(signal) / rate, start_measure)
                elif measure_sync is not None:
                    raise ValueError("measureSync requires manual-measures mode")
                if first_beat is not None and (not isinstance(first_beat, (int, float)) or
                                               not 0 <= float(first_beat) <= MAX_FIRST_BEAT_SECONDS):
                    raise ValueError(f"firstBeatAudioSec 须在 0–{MAX_FIRST_BEAT_SECONDS} 秒之间")
                if sync_mode == "metronome" and first_beat is None:
                    raise ValueError("metronome 模式需要 firstBeatAudioSec")
                if sync_mode == "legacy" and first_beat is not None:
                    raise ValueError("legacy 模式不应携带 firstBeatAudioSec")
        except (ValueError, KeyError, TypeError, binascii.Error) as exc:
            self.respond(400, {"error": str(exc)})
            return
        kind = "omr" if path == "/omr/jobs" else "analysis"
        try:
            with lock:
                for key in list(jobs):
                    job = jobs[key]
                    if job["status"] in TERMINAL and time.time() - job.get("finishedAt", job.get("createdAt", time.time())) > TTL:
                        del jobs[key]
                if job_store is not None:
                    job_store.expire(TTL)
                    if kind == "omr":
                        inputs = {"input.pdf": pdf}
                        parameters = {"filename": filename, "prependRestBeats": rest_beats}
                        version = "omr-adapter-1"
                    else:
                        from .piano_engine import VERSION as PIANO_VERSION
                        inputs = {"audio.wav": audio, "score.musicxml": xml.encode()}
                        parameters = {"bpm": bpm, "instrument": instrument, "startMeasure": start_measure,
                                      "firstBeatAudioSec": float(first_beat) if first_beat is not None else None,
                                      "syncMode": sync_mode, "measureSync": measure_sync,
                                      "pitchToleranceCents": float(pitch_tolerance_cents)}
                        version = [PIANO_VERSION if instrument == "piano" else STRING_VERSION, QUALITY_VERSION]
                    job, created = job_store.submit(kind, inputs, parameters, version, ttl=TTL)
                    job_id = job["id"]
                    jobs[job_id] = {key: value for key, value in job.items() if key != "result"}
                else:
                    if sum(j["status"] not in TERMINAL for j in jobs.values()) >= 4:
                        raise QueueFull()
                    job_id, created = uuid4().hex, True
                    jobs[job_id] = {"id": job_id, "status": "queued", "createdAt": time.time(), "kind": kind}
            if created:
                if kind == "omr":
                    pool.submit(run_omr, job_id, pdf, filename, rest_beats)
                else:
                    pool.submit(run, job_id, audio, xml, bpm, instrument, start_measure,
                                float(first_beat) if first_beat is not None else None, sync_mode, measure_sync,
                                float(pitch_tolerance_cents))
        except QueueFull:
            self.respond(429, {"error": "分析队列已满，请稍后重试"})
            return
        except Exception:
            if "job_id" in locals() and created:
                fail_job(job_id, {"status": "failed", "stage": "enqueueing", "errorClass": "QueueUnavailable",
                                  "finishedAt": time.time(), "error": "任务未能入队，请稍后重新提交。"})
            self.respond(503, {"error": "任务服务暂不可用，请稍后重新提交。"})
            return
        self.respond(202, {"id": job_id, "status": jobs[job_id]["status"],
                          "cached": not created})

    def do_GET(self) -> None:
        if not self.cors():
            return
        path = urlsplit(self.path).path
        if path == "/health":
            self.respond(200, {"status": "ok", "stringAlgorithmVersion": STRING_VERSION,
                               "qualityVersion": QUALITY_VERSION, "crepeBackend": crepe_backend()})
            return
        if not self.authorized():
            self.respond(401, {"error": "未授权"})
            return
        if not path.startswith(("/jobs/", "/omr/jobs/")):
            self.respond(404, {"error": "Not found"})
            return
        kind = "omr" if path.startswith("/omr/") else "analysis"
        with lock:
            job_id = path.removeprefix("/omr/jobs/").removeprefix("/jobs/")
            memory = jobs.get(job_id)
            try:
                job = job_store.get(job_id, TTL) if job_store is not None else memory
                if memory and memory.get("errorClass") == "StorageError":
                    job = memory
            except Exception:
                self.respond(503, {"error": "任务服务暂不可用，请稍后重试。"})
                return
            expired = job and job["status"] in TERMINAL and time.time() - job.get("finishedAt", job["createdAt"]) > TTL
            payload = dict(job) if job and job["kind"] == kind and not expired else None
        self.respond(200, payload) if payload else self.respond(404, {"error": "任务不存在或已过期"})


def main() -> None:
    global job_store
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    host = os.getenv("ANALYSIS_HOST", "127.0.0.1")
    port = int(os.getenv("ANALYSIS_PORT", "8765"))
    job_store = JobStore(os.getenv("ANALYSIS_DATA_DIR", str(Path.home() / ".local/share/scorefollow-analysis")))
    recovered = job_store.acquire_and_recover()
    logger.info(json.dumps({"event": "startup_recovery", "interruptedJobs": recovered}))
    print(f"Analysis API listening on http://{host}:{port}", flush=True)
    try:
        ThreadingHTTPServer((host, port), Handler).serve_forever()
    finally:
        job_store.close()


if __name__ == "__main__":
    main()
