"""Private GPU transport; PCM16 matches the local CREPE WAV round-trip."""
import base64
import json
import os
from pathlib import Path
import urllib.request

import numpy as np

PROTOCOL = "crepe-full-fp32-v1"
MAX_BODY = 20_000_000


def remote_tracks(signals, rate, url):
    try:
        token = Path(os.environ["SCOREFOLLOW_CREPE_TOKEN_FILE"]).read_text().strip()
        if not token:
            raise ValueError("empty token")
        body = json.dumps({"protocol": PROTOCOL, "rate": int(rate), "signals": [
            base64.b64encode((np.clip(s, -1, 1) * 32767).astype('<i2').tobytes()).decode('ascii')
            for s in signals]}).encode()
        if len(body) > MAX_BODY:
            raise ValueError("request too large")
        request = urllib.request.Request(url.rstrip('/') + '/predict', data=body,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        # Private Tailscale traffic must not be routed through an HTTP proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=20) as response:
            raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise ValueError("response too large")
        result = json.loads(raw)
        if result.get('protocol') != PROTOCOL or len(result['tracks']) != len(signals):
            raise ValueError("incompatible GPU response")
        tracks = []
        for signal, item in zip(signals, result['tracks']):
            times, midi, voicing = (np.asarray(item[k], dtype=np.float64)
                                    for k in ('times', 'midi', 'voicing'))
            if (times.ndim != 1 or len(times) < 8
                    or midi.shape != times.shape or voicing.shape != times.shape
                    or not all(np.all(np.isfinite(a)) for a in (times, midi, voicing))
                    or np.any((voicing < 0) | (voicing > 1))
                    or not np.allclose(times, np.arange(len(times)) * 128 / rate, atol=.000051)):
                raise ValueError("invalid GPU track")
            tracks.append((times, midi, voicing))
        return tracks
    except Exception as exc:
        # Never silently fall back to minutes of CPU inference or incomplete scoring.
        raise ValueError("GPU 音高分析暂不可用，请稍后重试。") from exc
