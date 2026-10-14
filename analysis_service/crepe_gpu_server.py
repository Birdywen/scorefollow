"""Resident authenticated CREPE full/FP32 worker (Windows or Linux CUDA)."""
import argparse
import base64
import hmac
import json
import logging
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

PROTOCOL = "crepe-full-fp32-v1"
MAX_BODY = 20_000_000
MAX_SAMPLES = 7_500_000
LOG = logging.getLogger('crepe-gpu')


class Predictor:
    def __init__(self):
        import torch
        import torchcrepe
        self.torch, self.crepe = torch, torchcrepe
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA unavailable')
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        torchcrepe.load.model('cuda', 'full')
        # Warm CUDA kernels and CPU Viterbi before listening/readiness.
        t = np.arange(22050, dtype=np.float32) / 22050
        self([(.25 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)], 22050)
        self.info = {'gpu': torch.cuda.get_device_name(), 'torch': torch.__version__,
                     'cuda': torch.version.cuda, 'model': 'full', 'precision': 'fp32'}

    def __call__(self, signals, rate):
        tracks = []
        for audio in signals:
            pitch, periodicity = self.crepe.predict(
                self.torch.from_numpy(audio).unsqueeze(0), rate,
                hop_length=128, fmin=50, fmax=2000, model='full',
                batch_size=1024, device='cuda', return_periodicity=True)
            freq = pitch.squeeze(0).cpu().numpy().astype(np.float64)
            voicing = periodicity.squeeze(0).cpu().numpy().astype(np.float64)
            midi = 69 + 12 * np.log2(np.maximum(freq, 1e-6) / 440)
            tracks.append({'times': np.round(np.arange(len(freq)) * 128 / rate, 4).tolist(),
                           'midi': np.round(midi, 3).tolist(),
                           'voicing': np.round(voicing, 3).tolist()})
        return tracks


def make_server(address, token, predictor):
    if len(token) < 32:
        raise ValueError('GPU token must contain at least 32 characters')
    gate = threading.Lock()
    started = time.time()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            LOG.info(fmt, *args)

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def respond(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.respond(401, {'error': 'unauthorized'})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path != '/health':
                self.respond(404, {'error': 'not found'})
                return
            self.respond(200, {'status': 'ready', 'protocol': PROTOCOL,
                               'startedAt': started, **predictor.info})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != '/predict':
                self.respond(404, {'error': 'not found'})
                return
            # Do not build a queue of unbounded GPU work behind a slow request.
            if not gate.acquire(blocking=False):
                self.respond(503, {'error': 'GPU busy'})
                return
            try:
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= MAX_BODY:
                        raise ValueError('invalid body size')
                    data = json.loads(self.rfile.read(length))
                    rate, encoded = data['rate'], data['signals']
                    if (data['protocol'] != PROTOCOL or type(rate) is not int or not 8000 <= rate <= 96000
                            or not isinstance(encoded, list) or not 1 <= len(encoded) <= 512):
                        raise ValueError('invalid request')
                    signals, total = [], 0
                    for item in encoded:
                        pcm = base64.b64decode(item, validate=True)
                        if len(pcm) < 16 or len(pcm) % 2:
                            raise ValueError('invalid PCM16')
                        total += len(pcm) // 2
                        if total > MAX_SAMPLES or total / rate > 300:
                            raise ValueError('too much audio')
                        signals.append(np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768)
                except (ValueError, KeyError, TypeError):
                    self.respond(400, {'error': 'invalid request'})
                    return
                start = time.perf_counter()
                try:
                    tracks = predictor(signals, rate)
                except Exception:
                    LOG.exception('GPU inference failed')
                    self.respond(503, {'error': 'GPU inference unavailable'})
                    return
                elapsed = time.perf_counter() - start
                LOG.info('prediction crops=%d samples=%d seconds=%.3f', len(signals), total, elapsed)
                self.respond(200, {'protocol': PROTOCOL, 'tracks': tracks, 'seconds': elapsed})
            finally:
                gate.release()

    return ThreadingHTTPServer(address, Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=28763)
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--log-file')
    args = parser.parse_args()
    logging.basicConfig(filename=args.log_file, level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s')
    token = Path(args.token_file).read_text().strip()
    predictor = Predictor()
    with make_server((args.host, args.port), token, predictor) as server:
        LOG.info('GPU_READY %s', json.dumps(predictor.info))
        server.serve_forever()


if __name__ == '__main__':
    main()
