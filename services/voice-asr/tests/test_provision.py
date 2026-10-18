"""Model provisioning against a local HTTP server: atomic install, cache reuse, and every refusal path."""
import hashlib
import os
import stat
import tempfile
import threading
import time
import unittest
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from voice_asr import provision as module
from voice_asr.provision import LICENSE, ModelSource, ProvisionError, main, provision
from voice_asr.system import ModelPin

MODEL = bytes(range(256)) * 4096  # 1 MiB of known bytes


@dataclass
class Behaviour:
    body: bytes = MODEL
    content_length: bool = True
    delay_s: float = 0.0
    requests: int = 0


class _Handler(BaseHTTPRequestHandler):
    behaviour: Behaviour

    def do_GET(self):  # noqa: N802 - http.server's naming
        self.behaviour.requests += 1
        self.send_response(200)
        if self.behaviour.content_length:
            self.send_header("Content-Length", str(len(self.behaviour.body)))
        self.end_headers()
        for start in range(0, len(self.behaviour.body), 65536):
            if self.behaviour.delay_s:
                time.sleep(self.behaviour.delay_s)
            try:
                self.wfile.write(self.behaviour.body[start:start + 65536])
            except OSError:
                return

    def log_message(self, *args):
        pass


class ProvisionTest(unittest.TestCase):
    def setUp(self):
        self.behaviour = Behaviour()
        handler = type("Handler", (_Handler,), {"behaviour": self.behaviour})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = os.path.join(directory.name, "model.gguf")
        self.source = ModelSource(f"http://127.0.0.1:{self.server.server_port}/model.gguf", "test/model", "0" * 40,
                                  "model.gguf", ModelPin(len(MODEL), hashlib.sha256(MODEL).hexdigest()))

    def run_provision(self, **kwargs):
        return provision(self.path, self.source, deadline_s=kwargs.get("deadline_s", 30.0),
                         read_timeout_s=kwargs.get("read_timeout_s", 5.0))

    def assert_nothing_installed(self):
        self.assertFalse(os.path.exists(self.path))
        self.assertFalse(os.path.exists(self.path + ".partial"))

    def test_installs_a_verified_read_only_model_with_its_notice(self):
        self.assertEqual(self.run_provision(), "installed")
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), MODEL)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o444)
        self.assertFalse(os.path.exists(self.path + ".partial"))
        with open(os.path.join(os.path.dirname(self.path), "NOTICE"), encoding="utf-8") as f:
            self.assertIn("NVIDIA Open Model License", f.read())

    def test_a_verified_cached_copy_is_kept_without_downloading(self):
        self.run_provision()
        self.assertEqual(self.run_provision(), "cached")
        self.assertEqual(self.behaviour.requests, 1)

    def test_a_cached_copy_that_fails_the_check_is_replaced(self):
        with open(self.path, "wb") as f:
            f.write(b"\0" * len(MODEL))
        self.assertEqual(self.run_provision(), "installed")
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), MODEL)

    def test_a_partial_file_from_an_interrupted_attempt_is_discarded(self):
        with open(self.path + ".partial", "wb") as f:
            f.write(b"stale")
        self.assertEqual(self.run_provision(), "installed")
        self.assertFalse(os.path.exists(self.path + ".partial"))

    def test_a_larger_download_is_refused_before_more_than_the_pinned_size_is_kept(self):
        self.behaviour.body = MODEL + b"extra"
        self.behaviour.content_length = False
        with self.assertRaisesRegex(ProvisionError, "larger than the pinned model"):
            self.run_provision()
        self.assert_nothing_installed()

    def test_a_wrong_announced_size_is_refused(self):
        self.behaviour.body = MODEL[:-1]
        with self.assertRaisesRegex(ProvisionError, "wrong size"):
            self.run_provision()
        self.assert_nothing_installed()

    def test_a_short_or_altered_download_is_refused(self):
        for body in (MODEL[:-1], MODEL[:-1] + b"x"):
            self.behaviour.body = body
            self.behaviour.content_length = False
            with self.assertRaisesRegex(ProvisionError, "pinned size and SHA-256"):
                self.run_provision()
            self.assert_nothing_installed()

    def test_a_download_past_its_deadline_is_abandoned(self):
        self.behaviour.delay_s = 0.05
        with self.assertRaisesRegex(ProvisionError, "deadline"):
            self.run_provision(deadline_s=0.2)
        self.assert_nothing_installed()

    def test_a_redirect_from_https_must_stay_on_https(self):
        handler = module._HttpsRedirects()
        request = urllib.request.Request("https://huggingface.co/model")
        with self.assertRaisesRegex(ProvisionError, "away from HTTPS"):
            handler.redirect_request(request, None, 302, "Found", {}, "http://cdn.example/model")
        allowed = handler.redirect_request(request, None, 302, "Found", {}, "https://cdn.example/model")
        self.assertEqual(allowed.full_url, "https://cdn.example/model")

    def test_the_entry_point_requires_the_model_path_and_the_license(self):
        for env in [{}, {"VOICE_ASR_MODEL_PATH": self.path},
                    {"VOICE_ASR_MODEL_PATH": self.path, "VOICE_ASR_MODEL_LICENSE": "yes"},
                    {"VOICE_ASR_MODEL_PATH": self.path, "VOICE_ASR_MODEL_LICENSE": LICENSE,
                     "VOICE_ASR_PROVISION_TIMEOUT_S": "1"}]:
            with self.subTest(env=sorted(env)), self.assertLogs("voice_asr.provision", "ERROR"):
                self.assertEqual(main(env), 2)
        self.assertEqual(self.behaviour.requests, 0)
        self.assert_nothing_installed()

    def test_the_chart_pins_match_the_runtime_check(self):
        source = module.NEMOTRON_EN_Q8_0_SOURCE
        self.assertEqual(source.pin, module.NEMOTRON_EN_Q8_0)
        self.assertEqual(source.pin.size, 699_872_960)
        self.assertEqual(source.pin.sha256, "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d")
        self.assertEqual(source.url, "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/"
                                     "ebe59e5a817142986528bbbee5dba8db7b38ed50/nemotron-speech-streaming-en-0.6b.q8_0.gguf")


if __name__ == "__main__":
    unittest.main()
