"""Local prototype API: python3 -m analysis_service.server.

Bind to loopback by default. A separate durable queue/storage and ingress controls
are required before exposing this service to the public internet.
"""

import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
import time
from urllib.parse import urlsplit
from uuid import uuid4

from . import vamp_features
from .engine import MAX_FIRST_BEAT_SECONDS, analyze, parse_score, read_wav, validate_measure_sync
from .omr import MAX_PDF, recognize

MAX_BODY = 16_000_000
MAX_OMR_BODY = 21_000_000
TTL = 3600
jobs: dict[str, dict] = {}
lock = threading.Lock()
pool = ThreadPoolExecutor(max_workers=2)
allowed_origins = set(os.getenv(
    "ANALYSIS_ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://150.136.51.61,https://ezmusicstore.com",
).split(","))
# Shared secret for the store relay (X-Analysis-Token header). Empty = open (local dev/tests).
API_TOKEN = os.environ.get("ANALYSIS_API_TOKEN", "")


def run(job_id: str, audio: bytes, xml: str, bpm: float, instrument: str, start_measure: int,
        first_beat_audio_sec: float | None = None, sync_mode: str = "legacy", measure_sync=None) -> None:
    with lock:
        jobs[job_id]["status"] = "analyzing"
    try:
        if instrument == "piano":
            # 钢琴走独立复音通道: 转录即传感器, 不经过单声部 FFT 管道
            from .piano_engine import analyze_piano
            result = analyze_piano(audio, xml, bpm, start_measure)
        else:
            # 有 Vamp 插件就用 pYIN+QM 当耳朵, 没有则引擎退回自研检测(前端无感)
            pitch_notes, onset_hint, beat_map = vamp_features.extract_all(audio)
            result = analyze(audio, xml, bpm, instrument, start_measure, first_beat_audio_sec, sync_mode,
                             pitch_notes=pitch_notes, onset_hint=onset_hint, beat_map=beat_map, measure_sync=measure_sync)
        update = {"status": "completed", "result": result}
    except Exception as exc:
        update = {"status": "failed", "error": str(exc) if isinstance(exc, ValueError) else "分析失败，请检查音频和谱面"}
    with lock:
        jobs[job_id].update(update)


def run_omr(job_id: str, pdf: bytes, filename: str, rest_beats: int | None) -> None:
    def update(status: str, percent: float) -> None:
        with lock:
            jobs[job_id].update(status=status, progress=percent)
    with lock:
        jobs[job_id]["status"] = "uploading"
    try:
        result = recognize(pdf, filename, rest_beats, update)
        change = {"status": "completed", "progress": 100, "result": result}
    except Exception as exc:
        change = {"status": "failed", "error": str(exc) if isinstance(exc, ValueError) else "OMR 识别失败，请稍后重试"}
    with lock:
        jobs[job_id].update(change)


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
        with lock:
            for key in list(jobs):
                if time.time() - jobs[key]["createdAt"] > TTL:
                    del jobs[key]
            pending = sum(j["status"] in ("queued", "analyzing", "uploading", "recognizing") for j in jobs.values())
            if pending >= 4:
                self.respond(429, {"error": "分析队列已满，请稍后重试"})
                return
            job_id = uuid4().hex
            jobs[job_id] = {"id": job_id, "status": "queued", "createdAt": time.time(), "kind": "omr" if path == "/omr/jobs" else "analysis"}
        if path == "/omr/jobs":
            pool.submit(run_omr, job_id, pdf, filename, rest_beats)
        else:
            pool.submit(run, job_id, audio, xml, bpm, instrument, start_measure,
                        float(first_beat) if first_beat is not None else None, sync_mode, measure_sync)
        self.respond(202, {"id": job_id, "status": "queued"})

    def do_GET(self) -> None:
        if not self.cors():
            return
        path = urlsplit(self.path).path
        if path == "/health":
            self.respond(200, {"status": "ok"})
            return
        if not self.authorized():
            self.respond(401, {"error": "未授权"})
            return
        if not path.startswith(("/jobs/", "/omr/jobs/")):
            self.respond(404, {"error": "Not found"})
            return
        kind = "omr" if path.startswith("/omr/") else "analysis"
        with lock:
            job = jobs.get(path.removeprefix("/omr/jobs/").removeprefix("/jobs/"))
            payload = dict(job) if job and job["kind"] == kind and time.time() - job["createdAt"] <= TTL else None
        self.respond(200, payload) if payload else self.respond(404, {"error": "任务不存在或已过期"})


def main() -> None:
    host = os.getenv("ANALYSIS_HOST", "127.0.0.1")
    port = int(os.getenv("ANALYSIS_PORT", "8765"))
    print(f"Analysis API listening on http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
