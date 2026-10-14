import base64
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import numpy as np

from . import engine as E
from .crepe_gpu_server import make_server, PROTOCOL
from .crepe_remote import remote_tracks


class FakePredictor:
    info = {'gpu': 'test', 'model': 'full', 'precision': 'fp32'}

    def __call__(self, signals, rate):
        self.signals = signals
        result = []
        for signal in signals:
            count = 1 + (len(signal) * 16000 // rate) // int(128 * 16000 / rate)
            result.append({'times': (np.arange(count) * 128 / rate).tolist(),
                           'midi': [69.] * count, 'voicing': [.9] * count})
        return result


class RemoteCrepeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.token = 'a' * 48
        self.token_file = Path(self.tmp.name) / 'token'
        self.token_file.write_text(self.token)
        self.predictor = FakePredictor()
        self.server = make_server(('127.0.0.1', 0), self.token, self.predictor)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:%d' % self.server.server_port
        self.env = patch.dict(os.environ, {'SCOREFOLLOW_CREPE_URL': self.url,
                              'SCOREFOLLOW_CREPE_TOKEN_FILE': str(self.token_file),
                              'SCOREFOLLOW_CREPE_PYTHON': '/must/not/run'})
        self.env.start()
        E._CREPE_CACHE.clear()

    def tearDown(self):
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        E._CREPE_CACHE.clear()

    def test_remote_preferred_pcm_parity_and_cache(self):
        signal = np.linspace(-1.2, 1.2, 22050, dtype=np.float32)
        with patch('subprocess.run', side_effect=AssertionError('no CPU fallback')):
            self.assertTrue(E._crepe_enabled())
            tracks = E._crepe_tracks([signal], 22050)
            self.assertEqual(len(tracks[0][0]), 174)
            expected = (np.clip(signal, -1, 1) * 32767).astype('<i2').astype(np.float32) / 32768
            np.testing.assert_array_equal(self.predictor.signals[0], expected)
            with patch('analysis_service.crepe_remote.remote_tracks', side_effect=AssertionError('cache miss')):
                E._crepe_tracks([signal], 22050)

    def test_auth_failure_degrades_to_pyin_without_cpu_or_cache(self):
        self.token_file.write_text('wrong')
        with patch('subprocess.run', side_effect=AssertionError('no CPU fallback')):
            tracks = E._crepe_tracks([np.zeros(22050, dtype=np.float32)], 22050)
        self.assertEqual(tracks, [None])
        self.assertFalse(E._CREPE_CACHE)
        # The transport itself still fails loudly (bounded), engine decides to degrade.
        with self.assertRaisesRegex(ValueError, 'GPU'):
            remote_tracks([np.zeros(22050)], 22050, self.url)

    def test_health_requires_authentication(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.url + '/health')
        self.assertEqual(caught.exception.code, 401)
        request = urllib.request.Request(self.url + '/health', headers={'Authorization': 'Bearer ' + self.token})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(json.load(response)['status'], 'ready')

    def test_invalid_protocol_and_rate_rejected(self):
        for protocol, rate in [('old', 22050), (PROTOCOL, 0), (PROTOCOL, True)]:
            body = json.dumps({'protocol': protocol, 'rate': rate,
                               'signals': [base64.b64encode(b'\0' * 32).decode()]}).encode()
            req = urllib.request.Request(self.url + '/predict', data=body,
                                         headers={'Authorization': 'Bearer ' + self.token})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(req)
            self.assertEqual(caught.exception.code, 400)

    def test_invalid_gpu_track_rejected(self):
        with patch.object(FakePredictor, '__call__', return_value=[
                {'times': [0], 'midi': [float('nan')], 'voicing': [2]}]):
            with self.assertRaisesRegex(ValueError, 'GPU'):
                remote_tracks([np.zeros(22050)], 22050, self.url)

    def test_transport_timeout_is_bounded(self):
        with patch('urllib.request.OpenerDirector.open', side_effect=TimeoutError) as opened:
            with self.assertRaisesRegex(ValueError, 'GPU'):
                remote_tracks([np.zeros(22050)], 22050, self.url)
            self.assertEqual(opened.call_args.kwargs['timeout'], 20)


if __name__ == '__main__':
    unittest.main()
