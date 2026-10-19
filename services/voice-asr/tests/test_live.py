"""Version 2 (partial transcripts) against the real server with the test-only fake worker, and that version 1
streams are unchanged beside it."""
import asyncio
import io
import json
import logging
import unittest

from support import START, client, drain_until_terminal, frame, recv_json, running_server, start_stream, wait_idle

START_V2 = json.dumps({"type": "start", "version": 2, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"})


def commands(model) -> list[str]:
    with open(model.path + ".log") as f:
        return [line.strip().split(":", 1)[1] for line in f]


async def stream_frames(ws, count: int, samples: int = 320) -> list[dict]:
    """Send frames one at a time, collecting what arrives for each, then end; returns every message."""
    messages = []
    for seq in range(count):
        await ws.send(frame(seq, samples))
        while True:
            message = await recv_json(ws)
            messages.append(message)
            if message["type"] == "ack":
                break
    await ws.send(json.dumps({"type": "end", "sequence": count, "totalSamples": count * samples}))
    rest, _ = await drain_until_terminal(ws)
    return messages + rest


async def send_window(ws, sizes: list[int]) -> tuple[int, list[dict]]:
    """Send frames as fast as the credit window allows; returns the samples sent and the partials received."""
    acked, sent, total, outstanding, partials = -1, 0, 0, 0, []
    while sent < len(sizes):
        while sent < len(sizes) and outstanding + sizes[sent] <= 16000:
            await ws.send(frame(sent, sizes[sent]))
            outstanding += sizes[sent]
            total += sizes[sent]
            sent += 1
        if sent < len(sizes):
            message = await recv_json(ws)
            if message["type"] == "partial":
                partials.append(message)
                continue
            assert message["type"] == "ack", message
            outstanding -= sum(sizes[acked + 1: message["sequence"] + 1])
            acked = message["sequence"]
    return total, partials


class LiveStreams(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.log = io.StringIO()
        self.handler = logging.StreamHandler(self.log)
        logging.getLogger().addHandler(self.handler)
        logging.getLogger().setLevel(logging.DEBUG)

    async def asyncTearDown(self):
        logging.getLogger().removeHandler(self.handler)

    async def test_upgrade_lists_versions_and_v2_start_is_ready_v2(self):
        async with running_server("ok") as (server, _, model):
            async with client(server) as ws:
                self.assertEqual(ws.response.headers["Voice-Stream-Versions"], "1, 2")
                await ws.send(START_V2)
                self.assertEqual(await recv_json(ws), {"type": "ready", "version": 2, "maxSamples": 960000,
                                                       "maxFrameSamples": 3200, "windowSamples": 16000})
            async with client(server) as ws:
                self.assertEqual((await start_stream(ws))["version"], 1)
            await asyncio.sleep(0.2)
            self.assertEqual([c for c in commands(model) if c.startswith("S")], ["Si", "S"])

    async def test_partials_precede_their_ack_in_order_and_the_final_comes_once(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await ws.send(START_V2)
                await recv_json(ws)
                messages = await stream_frames(ws, 4)
        kinds = [m["type"] for m in messages]
        self.assertEqual(kinds, ["partial", "ack"] * 4 + ["final"])
        partials = [m for m in messages if m["type"] == "partial"]
        self.assertEqual([m["revision"] for m in partials], [1, 2, 3, 4])
        self.assertEqual(partials[-1]["text"], "SENTINEL_PARTIAL stream 1 samples 1280")
        self.assertEqual(messages[-1], {"type": "final", "text": "SENTINEL_TRANSCRIPT stream 1 samples 1280"})
        self.assertNotIn("SENTINEL", self.log.getvalue(), "transcripts are never logged")
        self.assertIn("version=2", self.log.getvalue())
        self.assertIn("partials=4", self.log.getvalue())

    async def test_version_1_stream_gets_no_partials_from_a_live_capable_service(self):
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await start_stream(ws)
                messages = await stream_frames(ws, 3)
        self.assertEqual([m["type"] for m in messages], ["ack"] * 3 + ["final"])

    async def test_unchanged_unreadable_or_oversized_provisional_text_is_not_sent(self):
        for mode, expected in (("stable_partial", 1), ("bad_partial", 0), ("huge_partial", 0)):
            async with running_server(mode) as (server, _, _):
                async with client(server) as ws:
                    await ws.send(START_V2)
                    await recv_json(ws)
                    messages = await stream_frames(ws, 3)
            with self.subTest(mode):
                self.assertEqual(sum(m["type"] == "partial" for m in messages), expected)
                self.assertEqual([m["type"] for m in messages if m["type"] != "partial"], ["ack"] * 3 + ["final"])

    async def test_a_partial_reply_on_a_version_1_stream_is_a_worker_fault(self):
        async with running_server("rogue_partial") as (server, supervisor, _):
            async with client(server) as ws:
                await start_stream(ws)
                await ws.send(frame(0, 320))
                messages, code = await drain_until_terminal(ws)
                self.assertEqual(messages, [{"type": "error", "code": "UNAVAILABLE"}])
                self.assertEqual(code, 1013)
            await wait_idle(supervisor)

    async def test_cancel_drops_late_partials_and_the_next_stream_starts_fresh(self):
        async with running_server("slow_push") as (server, supervisor, _):
            async with client(server) as ws:
                await ws.send(START_V2)
                await recv_json(ws)
                await ws.send(frame(0, 320))
                await ws.send(frame(1, 320))
                await asyncio.sleep(0.05)  # the first push is inside the native call
                await ws.send('{"type":"cancel"}')
                messages, code = await drain_until_terminal(ws)
                self.assertEqual(messages, [{"type": "cancelled"}], "nothing follows a cancel but cancelled")
                self.assertEqual(code, 1000)
            await wait_idle(supervisor)
            async with client(server) as ws:
                await ws.send(START_V2)
                await recv_json(ws)
                messages = await stream_frames(ws, 1)
            self.assertEqual(messages[0], {"type": "partial", "revision": 1, "text": "SENTINEL_PARTIAL stream 2 samples 320"})

    async def test_version_2_keeps_every_version_1_limit(self):
        async with running_server("slow_push") as (server, supervisor, _):
            async with client(server) as ws:
                await ws.send(START_V2)
                await recv_json(ws)
                for seq in range(6):  # 19,200 unacknowledged samples
                    await ws.send(frame(seq, 3200))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "error", "code": "BACKPRESSURE"})
            await wait_idle(supervisor)
            async with client(server) as ws:
                await ws.send(START_V2)
                await recv_json(ws)
                await ws.send(frame(1, 10))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "error", "code": "INVALID_SEQUENCE"})
        async with running_server("ok") as (server, _, _):
            async with client(server) as ws:
                await ws.send(START_V2)
                await recv_json(ws)
                total, partials = await send_window(ws, [3200] * 300)
                self.assertEqual(total, 960000)
                await ws.send(frame(300, 1))
                messages, _ = await drain_until_terminal(ws)
                self.assertEqual(messages[-1], {"type": "error", "code": "TOO_LONG"})
                revisions = [m["revision"] for m in partials + messages if m["type"] == "partial"]
                self.assertEqual(revisions, list(range(1, len(revisions) + 1)))
                self.assertLessEqual(len(revisions), 300, "at most one partial per audio message")


if __name__ == "__main__":
    unittest.main()
