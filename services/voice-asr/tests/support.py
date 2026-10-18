"""Shared test helpers: settings, an in-process server on an ephemeral port, and a protocol client."""
import asyncio
import hashlib
import json
import os
import struct
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import logging

from websockets.asyncio.client import connect

SILENT = logging.getLogger("tests.client")
SILENT.disabled = True

from voice_asr.config import Settings
from voice_asr.server import VoiceAsrServer
from voice_asr.supervisor import Supervisor
from voice_asr.system import ModelPin
from voice_asr.worker import NativeWorker

FAKE_WORKER = str(Path(__file__).parent / "fixtures" / "fake_worker.py")
GOOD_CPUINFO = "processor\t: 0\nflags\t\t: fpu sse4_2 avx avx2 fma f16c bmi2\n"
START = json.dumps({"type": "start", "version": 1, "sampleRate": 16000, "channels": 1, "format": "pcm_s16le"})


def settings(**overrides) -> Settings:
    values = dict(host="127.0.0.1", port=0, model_path="", worker_path="", token=None, omp_thread_limit=None,
                  start_timeout=2.0, idle_timeout=2.0, recording_timeout=70.0, final_timeout=5.0,
                  native_call_timeout=5.0, cancel_grace=0.5, startup_timeout=10.0, shutdown_timeout=5.0, max_connections=4)
    values.update(overrides)
    return Settings(**values)


def frame(sequence: int, samples: int, value: int = 0) -> bytes:
    return struct.pack("<I", sequence) + struct.pack("<h", value) * samples


class FakeModel:
    """A small file whose size/SHA the test supervisor pins instead of the real model."""

    def __init__(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "model.gguf")
        with open(self.path, "wb") as f:
            f.write(b"fake model bytes")
        self.pin = ModelPin(16, hashlib.sha256(b"fake model bytes").hexdigest())
        self.cpuinfo = os.path.join(self.dir.name, "cpuinfo")
        with open(self.cpuinfo, "w") as f:
            f.write(GOOD_CPUINFO)

    def pids(self) -> list[int]:
        try:
            return [int(line) for line in open(self.path + ".pids")]
        except FileNotFoundError:
            return []


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@asynccontextmanager
async def running_server(mode: str = "ok", wait_ready: bool = True, model: FakeModel | None = None, pin: ModelPin | None = None,
                         cpuinfo: str | None = None, **overrides):
    model = model or FakeModel()
    config = settings(model_path=model.path, **overrides)
    supervisor = Supervisor(config, worker_factory=lambda: NativeWorker([sys.executable, FAKE_WORKER, mode], model.path),
                            cpuinfo_path=cpuinfo or model.cpuinfo, model_pin=pin or model.pin)
    server = VoiceAsrServer(config, supervisor)
    lifecycle = asyncio.create_task(supervisor.run())
    await server.start()
    try:
        if wait_ready:
            for _ in range(200):
                if supervisor.ready:
                    break
                await asyncio.sleep(0.02)
            assert supervisor.ready, "fake worker never became ready"
        yield server, supervisor, model
    finally:
        await server.stop()
        lifecycle.cancel()
        await asyncio.gather(lifecycle, return_exceptions=True)


async def http_get(port: int, path: str, headers: dict | None = None) -> int:
    """Status code of a plain HTTP/1.1 GET (probes and rejected upgrades)."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    lines = [f"GET {path} HTTP/1.1", "Host: localhost", "Connection: close"]
    lines += [f"{k}: {v}" for k, v in (headers or {}).items()]
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
    await writer.drain()
    status = await reader.readline()
    writer.close()
    return int(status.split()[1])


async def wait_idle(supervisor, seconds: float = 5.0) -> None:
    for _ in range(int(seconds / 0.02)):
        if supervisor.idle:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("service did not return to idle")


def stream_url(server) -> str:
    return f"ws://127.0.0.1:{server.port}/v1/stream"


@asynccontextmanager
async def client(server, token: str | None = None):
    headers = {"Authorization": f"Bearer {token}"} if token else None
    async with connect(stream_url(server), additional_headers=headers, max_size=None, open_timeout=5, logger=SILENT) as ws:
        yield ws


async def recv_json(ws, timeout: float = 5.0) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def start_stream(ws) -> dict:
    await ws.send(START)
    return await recv_json(ws)


async def send_audio(ws, frames: list[int], value: int = 0) -> int:
    """Send frames of the given sample counts, respecting the credit window; returns total samples."""
    sizes, acked, sent, total, seq_samples = list(frames), -1, 0, 0, {}
    outstanding = 0
    while sent < len(sizes):
        while sent < len(sizes) and outstanding + sizes[sent] <= 16000:
            await ws.send(frame(sent, sizes[sent], value))
            seq_samples[sent] = sizes[sent]
            outstanding += sizes[sent]
            total += sizes[sent]
            sent += 1
        if sent < len(sizes):
            message = await recv_json(ws)
            assert message["type"] == "ack", message
            for seq in range(acked + 1, message["sequence"] + 1):
                outstanding -= seq_samples[seq]
            acked = message["sequence"]
    return total


async def drain_until_terminal(ws, timeout: float = 10.0) -> tuple[list[dict], int]:
    """Collect messages until the server closes; returns (messages, close code)."""
    messages = []
    try:
        while True:
            messages.append(json.loads(await asyncio.wait_for(ws.recv(), timeout)))
    except Exception:
        pass
    await ws.wait_closed() if hasattr(ws, "wait_closed") else None
    return messages, ws.close_code
