"""Contract tests for the v1 stream protocol against the real server with a fake (test-only) worker."""
import asyncio
import io
import json
import logging
import unittest

from websockets.exceptions import InvalidStatus

from voice_asr.system import ModelPin
from support import (SILENT, START, FakeModel, client, drain_until_terminal, frame, http_get, pid_alive, recv_json,
                     running_server, send_audio, start_stream, wait_idle)


class ContractTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.log = io.StringIO()
        self.handler = logging.StreamHandler(self.log)
        logging.getLogger().addHandler(self.handler)
        logging.getLogger().setLevel(logging.DEBUG)

    async def asyncTearDown(self):
        logging.getLogger().removeHandler(self.handler)

    async def expect_error(self, ws, code: str):
        messages, _ = await drain_until_terminal(ws)
        self.assertEqual(messages[-1], {"type": "error", "code": code}, messages)

    # ------------------------------------------------------------------
    # Probes and admission
    # ------------------------------------------------------------------

    async def test_probes_and_readiness_until_warm(self):
        async with running_server("never_ready", wait_ready=False) as (server, supervisor, _):
            self.assertEqual(await http_get(server.port, "/healthz"), 200)
            self.assertEqual(await http_get(server.port, "/readyz"), 503)
            async with client(server) as ws:
                self.assertEqual(await start_stream(ws), {"type": "error", "code": "UNAVAILABLE"})
        async with running_server("ok") as (server, _, _):
            self.assertEqual(await http_get(server.port, "/readyz"), 200)
            self.assertEqual(await http_get(server.port, "/nope"), 404)

    async def test_auth_header_only(self):
        token = "SENTINEL_TOKEN_0123456789abcdef"
        async with running_server("ok", token=token) as (server, _, _):
            for headers in (None, {"Authorization": "Bearer wrong-token-0123456789"}, {"Authorization": token}):
                with self.assertRaises(InvalidStatus) as caught:
                    async with client(server, None) if headers is None else client_with(server, headers):
                        pass
                self.assertEqual(caught.exception.response.status_code, 401)
            self.assertEqual(await http_get(server.port, f"/v1/stream?token={token}", {"Authorization": f"Bearer {token}"}), 400)
            async with client(server, token) as ws:
                self.assertEqual((await start_stream(ws))["type"], "ready")
        self.assertNotIn("SENTINEL_TOKEN", self.log.getvalue())

    async def test_missing_or_mismatched_model_and_cpu(self):
        model = FakeModel()
        async with running_server("ok", wait_ready=False, model=model, pin=ModelPin(16, "0" * 64)) as (server, supervisor, _):
            await asyncio.sleep(0.3)
            self.assertFalse(supervisor.ready)
            self.assertEqual(supervisor.state, "model_invalid")
            self.assertEqual(await http_get(server.port, "/readyz"), 503)
        bad_cpu = model.cpuinfo + ".bad"
        open(bad_cpu, "w").write("flags\t: sse4_2 avx fma\n")
        async with running_server("ok", wait_ready=False, model=model, cpuinfo=bad_cpu) as (server, supervisor, _):
            await asyncio.sleep(0.2)
            self.assertEqual(supervisor.state, "cpu_unsupported")
            self.assertEqual(model.pids(), [], "no worker may start on an unsupported CPU")

    async def test_busy_second_client(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as first:
                self.assertEqual((await start_stream(first))["type"], "ready")
                async with client(server) as second:
                    self.assertEqual(await start_stream(second), {"type": "error", "code": "BUSY"})

    # ------------------------------------------------------------------
    # Happy path and boundaries
    # ------------------------------------------------------------------

    async def test_final_after_end_barrier_and_acks(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                self.assertEqual(await start_stream(ws), {"type": "ready", "version": 1, "maxSamples": 960000, "maxFrameSamples": 3200, "windowSamples": 16000})
                for seq in range(5):
                    await ws.send(frame(seq, 320))
                await ws.send(frame(5, 37))  # short final frame is retained
                await ws.send(json.dumps({"type": "end", "sequence": 6, "totalSamples": 5 * 320 + 37}))
                messages, code = await drain_until_terminal(ws)
                acks = [m["sequence"] for m in messages if m["type"] == "ack"]
                self.assertEqual(acks, sorted(acks))
                self.assertEqual(acks[-1], 5)
                self.assertEqual(messages[-1], {"type": "final", "text": "SENTINEL_TRANSCRIPT stream 1 samples 1637"})
                self.assertEqual(code, 1000)
        self.assertNotIn("SENTINEL_TRANSCRIPT", self.log.getvalue())

    async def test_zero_audio_end_returns_empty_final(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(json.dumps({"type": "end", "sequence": 0, "totalSamples": 0}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages, [{"type": "final", "text": ""}])
        self.assertIn("empty_shortcut=true", self.log.getvalue())

    async def test_sample_cap_exact_and_plus_one(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await start_stream(ws)
                total = await send_audio(ws, [3200] * 300)
                self.assertEqual(total, 960000)
                await ws.send(json.dumps({"type": "end", "sequence": 300, "totalSamples": 960000}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1]["type"], "final")
            async with client(server) as ws:
                await start_stream(ws)
                await send_audio(ws, [3200] * 300)
                await ws.send(frame(300, 1))
                await self.expect_error(ws, "TOO_LONG")

    async def test_frame_count_cap(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await start_stream(ws)
                await send_audio(ws, [1] * 6000)
                await ws.send(frame(6000, 1))
                await self.expect_error(ws, "TOO_LONG")

    async def test_output_caps(self):
        for mode in ("long_text", "astral_text"):
            async with running_server(mode) as (server, _, _):
                async with client(server) as ws:
                    await start_stream(ws)
                    await ws.send(frame(0, 320))
                    await ws.send(json.dumps({"type": "end", "sequence": 1, "totalSamples": 320}))
                    await self.expect_error(ws, "TOO_LONG")

    # ------------------------------------------------------------------
    # Malformed input
    # ------------------------------------------------------------------

    async def test_malformed_inputs(self):
        cases = [
            ("binary before start", [frame(0, 10)], "INVALID_MESSAGE", False),
            ("bad start", [json.dumps({"type": "start", "version": 2})], "INVALID_MESSAGE", False),
            ("unknown type", [START, '{"type":"pause"}'], "INVALID_MESSAGE", True),
            ("invalid json", [START, "{"], "INVALID_MESSAGE", True),
            ("oversize control", [START, json.dumps({"type": "cancel", "pad": "x" * 1100})], "INVALID_MESSAGE", True),
            ("odd pcm bytes", [START, frame(0, 10)[:-1]], "INVALID_AUDIO", True),
            ("header only", [START, frame(0, 0)], "INVALID_AUDIO", True),
            ("gap", [START, frame(0, 10), frame(2, 10)], "INVALID_SEQUENCE", True),
            ("duplicate", [START, frame(0, 10), frame(0, 10)], "INVALID_SEQUENCE", True),
            ("end sequence mismatch", [START, frame(0, 10), json.dumps({"type": "end", "sequence": 0, "totalSamples": 10})], "INVALID_SEQUENCE", True),
            ("end total mismatch", [START, frame(0, 10), json.dumps({"type": "end", "sequence": 1, "totalSamples": 11})], "INVALID_SEQUENCE", True),
            ("audio after end", [START, json.dumps({"type": "end", "sequence": 0, "totalSamples": 0}), frame(0, 10)], None, True),
            ("second start", [START, START], "INVALID_MESSAGE", True),
        ]
        async with running_server("slow_push") as (server, supervisor, _):
            for name, messages, code, expect_ready in cases:
                await wait_idle(supervisor)
                with self.subTest(name):
                    async with client(server) as ws:
                        for message in messages:
                            await ws.send(message)
                        received, close_code = await drain_until_terminal(ws)
                        if expect_ready:
                            self.assertEqual(received[0]["type"], "ready")
                        if code is not None:
                            self.assertEqual(received[-1], {"type": "error", "code": code})
                            self.assertNotEqual(close_code, 1000)
                        else:
                            self.assertIn(received[-1], ({"type": "error", "code": "INVALID_MESSAGE"}, {"type": "final", "text": ""}))

    async def test_backpressure_window(self):
        async with running_server("slow_push") as (server, _, _):
            async with client(server) as ws:
                await start_stream(ws)
                for seq in range(6):  # 19200 unacknowledged samples > 16000
                    await ws.send(frame(seq, 3200))
                await self.expect_error(ws, "BACKPRESSURE")

    async def test_start_and_idle_timeouts(self):
        async with running_server("ok", start_timeout=0.3, idle_timeout=0.3) as (server, _, _):
            async with client(server) as ws:
                await self.expect_error(ws, "TIMEOUT")
            async with client(server) as ws:
                await start_stream(ws)
                await self.expect_error(ws, "TIMEOUT")

    # ------------------------------------------------------------------
    # Cancel, failures, restart
    # ------------------------------------------------------------------

    async def test_cancel_idle_then_reconnect_without_stale_text(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await start_stream(ws)
                await send_audio(ws, [320] * 10)
                await ws.send('{"type":"cancel"}')
                messages, code = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "cancelled"})
                self.assertNotIn("final", [m["type"] for m in messages])
                self.assertEqual(code, 1000)
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 100))
                await ws.send(json.dumps({"type": "end", "sequence": 1, "totalSamples": 100}))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "final", "text": "SENTINEL_TRANSCRIPT stream 2 samples 100"})

    async def test_cancel_during_slow_native_call_waits_for_quiescence(self):
        async with running_server("slow_push") as (server, supervisor, model):
            pid = model.pids()[-1]
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 320))
                await asyncio.sleep(0.05)  # the push is now inside the native call
                await ws.send('{"type":"cancel"}')
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages, [{"type": "cancelled"}])  # no late ACK after cancel
            self.assertTrue(pid_alive(pid), "a call finishing within grace keeps the warmed worker")
            self.assertTrue(supervisor.ready)

    async def test_cancel_during_hung_call_kills_and_reaps_own_worker(self):
        async with running_server("hang_push", cancel_grace=0.3) as (server, supervisor, model):
            pid = model.pids()[-1]
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 320))
                await asyncio.sleep(0.05)
                await ws.send('{"type":"cancel"}')
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages, [{"type": "cancelled"}])
                self.assertFalse(pid_alive(pid), "cancelled is sent only after the hung worker was reaped")
            for _ in range(100):
                if supervisor.ready and model.pids()[-1] != pid:
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(supervisor.ready, "a replacement worker is warmed before admission")

    async def test_hung_native_call_times_out(self):
        async with running_server("hang_push", native_call_timeout=0.5) as (server, supervisor, model):
            pid = model.pids()[-1]
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 320))
                await self.expect_error(ws, "TIMEOUT")
            self.assertFalse(pid_alive(pid))
            for _ in range(100):
                if supervisor.ready:
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(supervisor.ready)

    async def test_unexpected_worker_exit(self):
        async with running_server("crash_push") as (server, supervisor, model):
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 320))
                await self.expect_error(ws, "UNAVAILABLE")
            self.assertFalse(pid_alive(model.pids()[0]))
            for _ in range(100):
                if supervisor.ready and len(model.pids()) > 1:
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(supervisor.ready)

    async def test_disconnect_holds_lease_until_quiescent(self):
        async with running_server("hang_push", cancel_grace=0.5) as (server, supervisor, model):
            pid = model.pids()[-1]
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 320))
                await asyncio.sleep(0.05)
            async with client(server) as ws:  # abrupt disconnect above; the lease is still held
                self.assertIn((await start_stream(ws))["code"], ("BUSY", "UNAVAILABLE"))
            await asyncio.sleep(0.8)
            self.assertFalse(pid_alive(pid))

    async def test_shutdown_reaps_worker(self):
        model = FakeModel()
        async with running_server("ok", model=model) as (server, supervisor, _):
            pid = model.pids()[-1]
        self.assertFalse(pid_alive(pid))
        self.assertEqual(supervisor.state, "stopped")


def client_with(server, headers):
    from websockets.asyncio.client import connect
    from support import stream_url
    return connect(stream_url(server), additional_headers=headers, open_timeout=5, logger=SILENT)


if __name__ == "__main__":
    unittest.main()


class LifecycleReview(unittest.IsolatedAsyncioTestCase):
    """Targeted fixtures for lifecycle races and log hygiene."""

    async def test_reader_failure_wins_over_simultaneous_final(self):
        from voice_asr import protocol as p
        from voice_asr.session import StreamSession
        from support import settings
        session = StreamSession(connection=None, supervisor=None, settings=settings())

        async def failing_reader():
            raise p.ProtocolFailure(p.INVALID_MESSAGE)

        async def finishing_feeder(_lease):
            return "final text"

        session._read_loop = failing_reader
        session._feed_loop = finishing_feeder
        with self.assertRaises(p.ProtocolFailure):
            await session._stream(lease=None)

    async def test_stop_during_hung_warmup_reaps_child(self):
        model = FakeModel()
        async with running_server("never_ready", wait_ready=False, model=model, startup_timeout=60) as (_, supervisor, _):
            for _ in range(100):
                if model.pids():
                    break
                await asyncio.sleep(0.02)
            pid = model.pids()[-1]
            self.assertTrue(pid_alive(pid))
        self.assertFalse(pid_alive(pid), "shutdown must kill and reap a worker that is still warming")

    async def test_cancelled_cleanup_keeps_lease_until_reaped(self):
        from voice_asr.worker import CMD_PUSH
        async with running_server("hang_push", cancel_grace=0.4) as (_, supervisor, model):
            pid = model.pids()[-1]
            lease = supervisor.try_lease()
            await lease.open_stream(5)
            push = asyncio.ensure_future(lease.worker.call(CMD_PUSH, b"\x00\x00", 30))
            await asyncio.sleep(0.05)
            cleanup = asyncio.ensure_future(lease.cleanup(0.4, 5))
            await asyncio.sleep(0.05)
            cleanup.cancel()
            await asyncio.sleep(0.05)
            self.assertEqual(supervisor.try_lease(), "BUSY", "a cancelled cleanup must not release the lease")
            for _ in range(100):
                if not pid_alive(pid) and supervisor.try_lease() != "BUSY":
                    break
                await asyncio.sleep(0.02)
            self.assertFalse(pid_alive(pid))
            await asyncio.gather(push, return_exceptions=True)

    async def test_empty_token_file_fails_closed(self):
        import tempfile
        from voice_asr.config import ConfigError, Settings
        with tempfile.NamedTemporaryFile("w") as f:
            f.write("  \n")
            f.flush()
            with self.assertRaises(ConfigError):
                Settings.from_env({"VOICE_ASR_MODEL_PATH": "/m", "VOICE_ASR_TOKEN_FILE": f.name})

    async def test_malformed_handshake_and_audio_never_logged(self):
        log = io.StringIO()
        handler = logging.StreamHandler(log)
        root = logging.getLogger()
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            async with running_server("ok", token="SENTINEL_TOKEN_0123456789abcdef") as (server, _, _):
                reader, writer = await asyncio.open_connection("127.0.0.1", server.port)
                writer.write(b"GET /v1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                             b"Sec-WebSocket-Version: 99\r\nAuthorization: Bearer SENTINEL_TOKEN_0123456789abcdef\r\n"
                             b"X-Junk: SENTINEL_HEADER\r\n\r\n")
                await writer.drain()
                await reader.read(1024)
                writer.close()
                async with client(server, "SENTINEL_TOKEN_0123456789abcdef") as ws:
                    await start_stream(ws)
                    await ws.send(frame(0, 8, value=0x4E53) + b"SENTINEL_AUDIO"[:0])
                    await ws.send(b"\x01\x00\x00\x00SENTINEL_AUDIO!")  # odd-length payload is rejected
                    await drain_until_terminal(ws)
        finally:
            root.removeHandler(handler)
        text = log.getvalue()
        for sentinel in ("SENTINEL_TOKEN", "SENTINEL_HEADER", "SENTINEL_AUDIO", "SENTINEL_TRANSCRIPT"):
            self.assertNotIn(sentinel, text)
