"""Follow-up safety tests: interrupted START, blank auth config, process hardening, blocked IPC under full credit."""
import asyncio
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from voice_asr.config import ConfigError, Settings
from voice_asr.hardening import HardeningError, harden_process
from websockets.asyncio.client import connect

from support import (SILENT, FakeModel, client, drain_until_terminal, frame, http_get, pid_alive, recv_json,
                     running_server, start_stream, stream_url)

SRC = str(Path(__file__).resolve().parents[1] / "src")


def commands(model: FakeModel) -> list[str]:
    try:
        return [line.strip() for line in open(model.path + ".log")]
    except FileNotFoundError:
        return []


async def until(predicate, seconds: float = 10.0):
    for _ in range(int(seconds / 0.02)):
        if predicate():
            return True
        await asyncio.sleep(0.02)
    return predicate()


class InterruptedStart(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_during_start_closes_native_stream_before_release(self):
        async with running_server("slow_start") as (server, supervisor, model):
            pid = model.pids()[-1]
            async with client(server) as ws:
                await ws.send(json.dumps({"type": "start", "version": 1, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"}))
                await asyncio.sleep(0.2)  # START is now inside the (slow) native call
            async with client(server) as other:
                self.assertEqual(await start_stream(other), {"type": "error", "code": "BUSY"}, "lease held during START")
            self.assertTrue(await until(lambda: supervisor.idle))
            self.assertEqual(commands(model), [f"{pid}:S", f"{pid}:C"], "the interrupted stream was closed natively")
            self.assertTrue(pid_alive(pid), "a START that settles keeps the warmed worker")
            async with client(server) as ws:
                self.assertEqual((await start_stream(ws))["type"], "ready")
                await ws.send(frame(0, 50))
                await ws.send(json.dumps({"type": "end", "sequence": 1, "totalSamples": 50}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "final", "text": "SENTINEL_TRANSCRIPT stream 2 samples 50"})

    async def test_session_deadline_during_start_still_closes_native_stream(self):
        # The session's wall-clock deadline (0.7 s) cancels the caller while the 1 s native START is in flight.
        async with running_server("slow_start", start_timeout=0.5, recording_timeout=0.1, final_timeout=0.1) as (server, supervisor, model):
            pid = model.pids()[-1]
            async with client(server) as ws:
                await ws.send(json.dumps({"type": "start", "version": 1, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages, [{"type": "error", "code": "TIMEOUT"}])
            self.assertTrue(await until(lambda: supervisor.idle))
            self.assertEqual(commands(model), [f"{pid}:S", f"{pid}:C"], "START settled, then the stream was closed")

    async def test_hung_start_is_killed_and_reaped_before_admission(self):
        async with running_server("hang_first_start", native_call_timeout=0.6) as (server, supervisor, model):
            hung = model.pids()[-1]
            async with client(server) as ws:
                await ws.send(json.dumps({"type": "start", "version": 1, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"}))
                await asyncio.sleep(0.1)
            async with client(server) as other:
                self.assertIn((await start_stream(other))["code"], ("BUSY", "UNAVAILABLE"))
            self.assertTrue(await until(lambda: not pid_alive(hung)), "the hung worker is killed and reaped")
            self.assertTrue(await until(lambda: supervisor.idle and len(model.pids()) == 2))
            async with client(server) as ws:
                self.assertEqual((await start_stream(ws))["type"], "ready")
                await ws.send(frame(0, 10))
                await ws.send(json.dumps({"type": "end", "sequence": 1, "totalSamples": 10}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "final", "text": "SENTINEL_TRANSCRIPT stream 1 samples 10"})

    async def test_shutdown_during_start_closes_then_quits(self):
        model = FakeModel()
        async with running_server("slow_start", model=model) as (server, supervisor, _):
            pid = model.pids()[-1]
            ws_task = asyncio.create_task(self._start_and_wait(server))
            await asyncio.sleep(0.2)
        self.assertFalse(pid_alive(pid))
        self.assertEqual(commands(model), [f"{pid}:S", f"{pid}:C", f"{pid}:Q"])
        await asyncio.gather(ws_task, return_exceptions=True)

    async def _start_and_wait(self, server):
        async with client(server) as ws:
            await ws.send(json.dumps({"type": "start", "version": 1, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"}))
            await drain_until_terminal(ws)


class FullWindowBlockedIpc(unittest.IsolatedAsyncioTestCase):
    """A full, legal credit window while the worker stops consuming IPC (small own test pipe + low watermark)."""

    async def fill_window(self, server, supervisor):
        # Low write watermark on this test's own worker pipe so drain() itself blocks.
        supervisor._worker._writer.transport.set_write_buffer_limits(high=1024, low=0)
        ws = await connect(stream_url(server), logger=SILENT, open_timeout=5)
        self.assertEqual((await start_stream(ws))["type"], "ready")
        for seq in range(5):  # 5 x 3200 = exactly the 16,000-sample window: legal, not BACKPRESSURE
            await ws.send(frame(seq, 3200))
        await asyncio.sleep(0.3)
        transport = supervisor._worker._writer.transport
        self.assertGreater(transport.get_write_buffer_size(), 1024, "drain is blocked on the full pipe")
        return ws

    async def test_cancel_with_full_window_and_blocked_drain(self):
        async with running_server("block_first_ipc", native_call_timeout=30, cancel_grace=0.3) as (server, supervisor, model):
            blocked = model.pids()[-1]
            ws = await self.fill_window(server, supervisor)
            started = time.monotonic()
            self.assertEqual(await http_get(server.port, "/healthz"), 200, "the parent stays responsive")
            self.assertLess(time.monotonic() - started, 1.0)
            await ws.send('{"type":"cancel"}')
            message = await recv_json(ws, timeout=5)
            self.assertEqual(message, {"type": "cancelled"})
            self.assertFalse(pid_alive(blocked), "cancelled only after the blocked worker was killed and reaped")
            await ws.close()
            self.assertTrue(await until(lambda: supervisor.idle and len(model.pids()) == 2))
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 3200))
                await ws.send(json.dumps({"type": "end", "sequence": 1, "totalSamples": 3200}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1]["type"], "final")

    async def test_watchdog_covers_blocked_drain(self):
        # Long idle/recording deadlines: only the whole-command native watchdog (0.8 s) can end this stream quickly.
        async with running_server("block_first_ipc", native_call_timeout=0.8, idle_timeout=30, cancel_grace=0.3) as (server, supervisor, model):
            blocked = model.pids()[-1]
            ws = await self.fill_window(server, supervisor)
            started = time.monotonic()
            messages, _ = await drain_until_terminal(ws, timeout=5)
            self.assertEqual(messages[-1:], [{"type": "error", "code": "TIMEOUT"}])
            self.assertLess(time.monotonic() - started, 3.0, "the watchdog fired while drain() was blocked")
            self.assertTrue(await until(lambda: not pid_alive(blocked)))
            self.assertTrue(await until(lambda: supervisor.idle and len(model.pids()) == 2))

    async def test_full_window_pipelined_success_keeps_every_sample(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await start_stream(ws)
                sizes = [3200, 3200, 3200, 3200, 3200, 1, 2999, 320, 7]
                sent, acked, outstanding, seq_sizes = 0, -1, 0, {}
                for seq, size in enumerate(sizes):
                    while outstanding + size > 16000:
                        ack = await recv_json(ws)
                        for s in range(acked + 1, ack["sequence"] + 1):
                            outstanding -= seq_sizes[s]
                        acked = ack["sequence"]
                    await ws.send(frame(seq, size))
                    seq_sizes[seq] = size
                    outstanding += size
                    sent += size
                await ws.send(json.dumps({"type": "end", "sequence": len(sizes), "totalSamples": sent}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "final", "text": f"SENTINEL_TRANSCRIPT stream 1 samples {sent}"})


class BlankAuthConfig(unittest.TestCase):
    def test_unset_is_the_only_optional_form(self):
        self.assertIsNone(Settings.from_env({"VOICE_ASR_MODEL_PATH": "/m"}).token)
        with tempfile.TemporaryDirectory() as d:
            blank = os.path.join(d, "blank")
            Path(blank).write_text(" \n")
            good = os.path.join(d, "good")
            Path(good).write_text("SENTINEL_TOKEN_0123456789abcdef\n")
            for env in [{"VOICE_ASR_TOKEN": ""}, {"VOICE_ASR_TOKEN": "   "}, {"VOICE_ASR_TOKEN_FILE": ""},
                        {"VOICE_ASR_TOKEN_FILE": "  "}, {"VOICE_ASR_TOKEN_FILE": blank},
                        {"VOICE_ASR_TOKEN_FILE": os.path.join(d, "missing")},
                        {"VOICE_ASR_TOKEN": "", "VOICE_ASR_TOKEN_FILE": good},
                        {"VOICE_ASR_TOKEN": "SENTINEL_TOKEN_0123456789abcdef", "VOICE_ASR_TOKEN_FILE": ""}]:
                with self.assertRaises(ConfigError, msg=sorted(env)) as caught:
                    Settings.from_env({"VOICE_ASR_MODEL_PATH": "/m", **env})
                self.assertNotIn("SENTINEL", str(caught.exception))
            self.assertEqual(Settings.from_env({"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_TOKEN_FILE": good}).token,
                             "SENTINEL_TOKEN_0123456789abcdef")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def core_limit(pid: int) -> str:
    for line in open(f"/proc/{pid}/limits"):
        if line.startswith("Max core file size"):
            return " ".join(line.split()[4:6])
    return ""


def non_dumpable(pid: int) -> bool:
    """Non-dumpable processes have their /proc/<pid> entries owned by root (procfs semantics)."""
    return os.getuid() != 0 and os.stat(f"/proc/{pid}/environ").st_uid == 0


class ProcessHardening(unittest.TestCase):
    def test_failure_raises(self):
        class FailingLibc:
            @staticmethod
            def prctl(*_):
                return -1
        script = ("import resource, voice_asr.hardening as h\n"
                  "class L:\n    @staticmethod\n    def prctl(*a): return -1\n"
                  "try:\n    h.harden_process(L())\nexcept h.HardeningError:\n    print('refused')\n")
        out = subprocess.run([sys.executable, "-I", "-c", f"import sys; sys.path.insert(0, {SRC!r})\n" + script],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.stdout.strip(), "refused")

    def test_service_process_is_hardened_before_secrets(self):
        port = free_port()
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": SRC, "PORT": str(port), "VOICE_ASR_HOST": "127.0.0.1",
               "VOICE_ASR_MODEL_PATH": "/nonexistent/model.gguf", "VOICE_ASR_WORKER_PATH": "/bin/false",
               "VOICE_ASR_TOKEN": "SENTINEL_TOKEN_0123456789abcdef"}
        process = subprocess.Popen([sys.executable, "-m", "voice_asr"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    if asyncio.run(http_get(port, "/healthz")) == 200:
                        break
                except OSError:
                    time.sleep(0.1)
            self.assertEqual(core_limit(process.pid), "0 0")
            self.assertTrue(non_dumpable(process.pid), "the service process is non-dumpable")
        finally:
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(20), 0)
        logs = process.stderr.read().decode()
        self.assertIn("model_invalid", logs)
        self.assertNotIn("SENTINEL", logs)

    def test_service_refuses_to_start_without_hardening(self):
        script = (f"import sys; sys.path.insert(0, {SRC!r})\n"
                  "import voice_asr.hardening as h\nh.PR_SET_DUMPABLE = 999999\n"
                  "from voice_asr.server import main\nmain()\n")
        out = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True, timeout=30,
                             env={"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_TOKEN": "SENTINEL_TOKEN_0123456789abcdef"})
        self.assertEqual(out.returncode, 3)
        self.assertIn("process_hardening_failed", out.stderr)
        self.assertNotIn("SENTINEL", out.stderr + out.stdout)


@unittest.skipUnless(os.environ.get("VOICE_ASR_NATIVE_WORKER"), "needs the built native worker (no model is loaded)")
class NativeWorkerHardening(unittest.TestCase):
    """The C worker hardens itself after exec and before touching the model: probe it with a FIFO model path."""

    def test_worker_hardened_before_model(self):
        with tempfile.TemporaryDirectory() as d:
            fifo = os.path.join(d, "model.gguf")
            os.mkfifo(fifo)
            cmd_r, cmd_w = os.pipe()
            rep_r, rep_w = os.pipe()
            worker = subprocess.Popen([os.environ["VOICE_ASR_NATIVE_WORKER"], str(cmd_r), str(rep_w), fifo],
                                      pass_fds=(cmd_r, rep_w), env={"VOICE_ASR_PARENT_PID": str(os.getpid())},
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                time.sleep(0.5)
                if worker.poll() is not None:
                    self.skipTest(f"worker exited before reaching the model open (code {worker.returncode})")
                self.assertEqual(core_limit(worker.pid), "0 0")
                self.assertTrue(non_dumpable(worker.pid))
            finally:
                worker.kill()
                worker.wait(10)
                for fd in (cmd_r, cmd_w, rep_r, rep_w):
                    os.close(fd)


if __name__ == "__main__":
    unittest.main()


class SecondConnectionIsolation(unittest.IsolatedAsyncioTestCase):
    """A rejected, unauthenticated, malformed or dropped second connection never touches the first lease."""

    async def test_second_connection_failures_leave_first_stream_intact(self):
        from websockets.exceptions import InvalidStatus
        token = "SENTINEL_TOKEN_0123456789abcdef"
        start = json.dumps({"type": "start", "version": 1, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"})
        async with running_server("ok", token=token) as (server, supervisor, model):
            pid = model.pids()[-1]
            first = await connect(stream_url(server), additional_headers={"Authorization": f"Bearer {token}"}, logger=SILENT)
            self.assertEqual((await start_stream(first))["type"], "ready")
            owner = supervisor._lease
            self.assertIsNotNone(owner)
            sent, seq = 0, 0

            async def first_sends(count):
                nonlocal sent, seq
                for _ in range(count):
                    await first.send(frame(seq, 320))
                    seq += 1
                    sent += 320
                    ack = await recv_json(first)
                    self.assertEqual(ack, {"type": "ack", "sequence": seq - 1})

            def still_owner():
                self.assertIs(supervisor._lease, owner, "the first stream still owns the lease")
                self.assertTrue(owner.stream_open)
                self.assertIs(owner.worker, supervisor._worker)
                self.assertEqual(owner.worker.pid, pid)

            await first_sends(3)
            headers = {"Authorization": f"Bearer {token}"}
            # BUSY, then the second client cancels and closes.
            async with connect(stream_url(server), additional_headers=headers, logger=SILENT) as second:
                await second.send(start)
                await second.send('{"type":"cancel"}')
                messages, _ = await drain_until_terminal(second)
                self.assertEqual(messages, [{"type": "error", "code": "BUSY"}])
            still_owner()
            await first_sends(2)
            # BUSY, then an abrupt close without reading the reply.
            second = await connect(stream_url(server), additional_headers=headers, logger=SILENT)
            await second.send(start)
            second.transport.abort()
            await asyncio.sleep(0.1)
            still_owner()
            await first_sends(2)
            # Unauthenticated upgrade (rejected before any WebSocket exists).
            with self.assertRaises(InvalidStatus):
                async with connect(stream_url(server), logger=SILENT):
                    pass
            still_owner()
            # Malformed first message, then close.
            async with connect(stream_url(server), additional_headers=headers, logger=SILENT) as second:
                await second.send(frame(0, 10))
                messages, _ = await drain_until_terminal(second)
                self.assertEqual(messages, [{"type": "error", "code": "INVALID_MESSAGE"}])
            still_owner()
            # Connect and drop without sending anything.
            second = await connect(stream_url(server), additional_headers=headers, logger=SILENT)
            await second.close()
            await asyncio.sleep(0.1)
            still_owner()
            await first_sends(2)
            await first.send(json.dumps({"type": "end", "sequence": seq, "totalSamples": sent}))
            messages, code = await drain_until_terminal(first)
            self.assertEqual(messages[-1], {"type": "final", "text": f"SENTINEL_TRANSCRIPT stream 1 samples {sent}"})
            self.assertEqual(code, 1000)
            self.assertTrue(await until(lambda: supervisor.idle))
            self.assertTrue(pid_alive(pid))
            self.assertEqual([c.split(":")[1] for c in commands(model)], ["S"] + ["P"] * 9 + ["F", "C"],
                             "only the first stream's commands reached the worker")
