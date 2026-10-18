"""Unit tests: wire parsing, configuration bounds, host checks and the native ISA guard."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from voice_asr import protocol as p
from voice_asr.config import ConfigError, Settings
from voice_asr.system import ModelPin, cpu_supported, model_matches

START = {"type": "start", "version": 1, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"}


class ControlParsing(unittest.TestCase):
    def failure(self, message) -> str:
        with self.assertRaises(p.ProtocolFailure) as caught:
            p.parse_control(message if isinstance(message, str) else json.dumps(message))
        return caught.exception.code

    def test_valid_controls(self):
        self.assertEqual(p.parse_control(json.dumps(START))["type"], "start")
        self.assertEqual(p.parse_control('{"type":"end","sequence":3,"totalSamples":9600}')["sequence"], 3)
        self.assertEqual(p.parse_control('{"type":"cancel"}')["type"], "cancel")

    def test_invalid_controls(self):
        for message in [
            "not json", "[]", '{"type":1}', {"type": "ping"},
            {**START, "version": 2}, {**START, "version": True}, {**START, "version": 1.0}, {**START, "sampleRate": 48000},
            {**START, "extra": 1}, {k: v for k, v in START.items() if k != "format"},
            {"type": "end", "sequence": "3", "totalSamples": 1}, {"type": "end", "sequence": 1}, {"type": "cancel", "x": 1},
            '{"type":"cancel","type":"cancel"}', json.dumps({"type": "cancel", "pad": "x" * 1100}),
        ]:
            self.assertEqual(self.failure(message), p.INVALID_MESSAGE, message)

    def test_audio_lengths(self):
        self.assertEqual(p.parse_audio(b"\x05\x00\x00\x00\x01\x00"), (5, b"\x01\x00"))
        self.assertEqual(len(p.parse_audio(b"\x00" * p.MAX_BINARY_BYTES)[1]), 2 * p.MAX_FRAME_SAMPLES)
        for size in (0, 4, 5, 7, p.MAX_BINARY_BYTES + 2):
            with self.assertRaises(p.ProtocolFailure) as caught:
                p.parse_audio(b"\x00" * size)
            self.assertEqual(caught.exception.code, p.INVALID_AUDIO)

    def test_messages_and_codes(self):
        self.assertEqual(json.loads(p.READY_MESSAGE), {"type": "ready", "version": 1, "maxSamples": 960000, "maxFrameSamples": 3200, "windowSamples": 16000})
        self.assertEqual(json.loads(p.error_message("not-a-code")), {"type": "error", "code": "UNAVAILABLE"})
        self.assertEqual(p.ERROR_CODES, {"INVALID_MESSAGE", "INVALID_SEQUENCE", "INVALID_AUDIO", "TOO_LONG", "BUSY", "UNAVAILABLE", "BACKPRESSURE", "TIMEOUT"})
        self.assertEqual(p.utf16_units("a\U0001F600"), 3)


class SettingsBounds(unittest.TestCase):
    def test_defaults(self):
        s = Settings.from_env({"VOICE_ASR_MODEL_PATH": "/m"})
        self.assertEqual((s.port, s.start_timeout, s.idle_timeout, s.final_timeout, s.native_call_timeout), (8080, 5.0, 5.0, 30.0, 10.0))
        self.assertIsNone(s.token)
        self.assertEqual(s.session_timeout, 5.0 + 75.0 + 30.0)

    def test_rejections(self):
        for env in [{}, {"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_NATIVE_CALL_TIMEOUT_S": "0"},
                    {"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_FINAL_TIMEOUT_S": "inf"},
                    {"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_TOKEN": "short"},
                    {"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_OMP_THREAD_LIMIT": "64"},
                    {"VOICE_ASR_MODEL_PATH": "/m", "PORT": "70000"}]:
            with self.assertRaises(ConfigError, msg=env):
                Settings.from_env(env)

    def test_error_text_never_contains_values(self):
        with self.assertRaises(ConfigError) as caught:
            Settings.from_env({"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_TOKEN": "SENTINEL bad token"})
        self.assertNotIn("SENTINEL", str(caught.exception))


class HostChecks(unittest.TestCase):
    def test_cpu_flags(self):
        with tempfile.TemporaryDirectory() as d:
            good, bad = os.path.join(d, "good"), os.path.join(d, "bad")
            Path(good).write_text("flags\t: sse4_2 avx avx2 fma f16c bmi2\nflags\t: sse4_2 avx avx2 fma f16c bmi2 avx512f\n")
            Path(bad).write_text("flags\t: sse4_2 avx fma f16c\n")
            self.assertTrue(cpu_supported(good))
            self.assertFalse(cpu_supported(bad))
            self.assertFalse(cpu_supported(os.path.join(d, "missing")))

    def test_model_pin(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "m")
            Path(path).write_bytes(b"abc")
            sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            self.assertTrue(model_matches(path, ModelPin(3, sha)))
            self.assertFalse(model_matches(path, ModelPin(4, sha)))
            self.assertFalse(model_matches(path, ModelPin(3, "0" * 64)))
            self.assertFalse(model_matches(os.path.join(d, "missing"), ModelPin(3, sha)))


@unittest.skipUnless(shutil.which("cc") and shutil.which("objdump"), "needs a C compiler and binutils")
class IsaGuard(unittest.TestCase):
    """The build's AVX-512 detector must flag AVX-512 code and pass AVX2-only code."""

    def build(self, d, name, asm):
        src = os.path.join(d, name + ".c")
        Path(src).write_text(f'void f(void) {{ __asm__ volatile("{asm}"); }}\n')
        out = os.path.join(d, name + ".so")
        subprocess.run(["cc", "-shared", "-fPIC", "-o", out, src], check=True)
        return out

    def test_detector(self):
        guard = str(Path(__file__).resolve().parents[1] / "native" / "check-isa.sh")
        with tempfile.TemporaryDirectory() as d:
            avx2 = self.build(d, "avx2", "vaddps %ymm1, %ymm2, %ymm3")
            avx512 = self.build(d, "avx512", "vaddps %zmm1, %zmm2, %zmm3")
            self.assertEqual(subprocess.run([guard, avx2], capture_output=True).returncode, 0)
            self.assertEqual(subprocess.run([guard, avx512], capture_output=True).returncode, 1)
            self.assertEqual(subprocess.run([guard, avx2, avx512], capture_output=True).returncode, 1)


if __name__ == "__main__":
    unittest.main()
