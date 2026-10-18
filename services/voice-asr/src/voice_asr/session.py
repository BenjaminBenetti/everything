"""One single-utterance stream: start → ready → pipelined audio/ACK → end barrier → final (or cancel/error).

The reader validates and queues every frame in order; the feeder pushes queued PCM to the native worker and
acknowledges cumulatively only after the push and its next() drain returned. Native finish runs exactly once,
behind every accepted frame. Cleanup always makes native work quiescent before the lease is released.
"""
import asyncio
import logging
from collections import deque
from itertools import count

from websockets.exceptions import ConnectionClosed

from . import protocol as p
from .worker import CMD_FINISH, CMD_PUSH, ERR_NO_FINAL, ERR_OUTPUT_LIMIT, WorkerError, WorkerRejected, WorkerTimeout

log = logging.getLogger("voice_asr")
_ids = count(1)
PUSH_MAX_SAMPLES = p.WINDOW_SAMPLES
CLIENT_ERROR_CLOSE = 1008
TRY_AGAIN_CLOSE = 1013
SERVER_ERROR_CLOSE = 1011


class StreamCancelled(Exception):
    """The client sent cancel."""


def _close_code(code: str) -> int:
    if code in (p.BUSY, p.UNAVAILABLE):
        return TRY_AGAIN_CLOSE
    if code == p.TIMEOUT:
        return SERVER_ERROR_CLOSE
    return CLIENT_ERROR_CLOSE


class StreamSession:
    def __init__(self, connection, supervisor, settings):
        self.connection = connection
        self.supervisor = supervisor
        self.settings = settings
        self.id = next(_ids)
        self.queue: deque[tuple[int, bytes]] = deque()
        self.queued_samples = 0
        self.inflight_samples = 0
        self.next_sequence = 0
        self.total_samples = 0
        self.ended = False
        self.work = asyncio.Event()
        self.final_timer = asyncio.timeout(None)
        self.ended_at: float | None = None
        self.empty_shortcut = False
        self.final_sent_at: float | None = None
        self.final_deadline: float | None = None
        self.timer_entered = False

    # ---------------------------------------------------------------------
    # Entry point
    # ---------------------------------------------------------------------

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        started = loop.time()
        lease = None
        outcome = p.UNAVAILABLE
        try:
            try:
                async with asyncio.timeout(self.settings.session_timeout):
                    await self._receive_start()
                    lease = self.supervisor.try_lease()
                    if isinstance(lease, str):
                        code, lease = lease, None
                        raise p.ProtocolFailure(code)
                    try:
                        await lease.open_stream(self.settings.native_call_timeout)
                    except (WorkerError, WorkerRejected):
                        raise p.ProtocolFailure(p.UNAVAILABLE) from None
                    await self.connection.send(p.READY_MESSAGE)
                    text = await self._stream(lease)
                    await self.connection.send(p.final_message(text))
                    self.final_sent_at = loop.time()
                    outcome = "final"
            except TimeoutError:
                raise p.ProtocolFailure(p.TIMEOUT) from None
            if lease is not None:
                await lease.cleanup(self.settings.cancel_grace, self.settings.native_call_timeout)
            await self.connection.close(1000)
        except StreamCancelled:
            outcome = "cancelled"
            if lease is not None:
                await lease.cleanup(self.settings.cancel_grace, self.settings.native_call_timeout)
            await self._send_quietly(p.CANCELLED_MESSAGE)
            await self.connection.close(1000)
        except ConnectionClosed:
            outcome = "disconnected"
        except p.ProtocolFailure as failure:
            outcome = failure.code
            await self._send_quietly(p.error_message(failure.code))
            await self.connection.close(_close_code(failure.code))
        finally:
            if lease is not None:
                await lease.cleanup(self.settings.cancel_grace, self.settings.native_call_timeout)
            tail_ms = int((self.final_sent_at - self.ended_at) * 1000) if self.final_sent_at and self.ended_at else -1
            log.info("stream_closed id=%d outcome=%s frames=%d samples=%d wall_ms=%d end_to_final_send_ms=%d empty_shortcut=%s",
                     self.id, outcome, self.next_sequence, self.total_samples, int((loop.time() - started) * 1000), tail_ms,
                     str(self.empty_shortcut).lower())

    async def _send_quietly(self, message: str) -> None:
        try:
            await self.connection.send(message)
        except ConnectionClosed:
            pass

    async def _receive_start(self) -> None:
        try:
            message = await asyncio.wait_for(self.connection.recv(), self.settings.start_timeout)
        except TimeoutError:
            raise p.ProtocolFailure(p.TIMEOUT) from None
        if not isinstance(message, str) or p.parse_control(message)["type"] != "start":
            raise p.ProtocolFailure(p.INVALID_MESSAGE)

    # ---------------------------------------------------------------------
    # Streaming
    # ---------------------------------------------------------------------

    async def _stream(self, lease) -> str:
        feeder = asyncio.create_task(self._feed_loop(lease))  # first, so it enters the final timer first
        reader = asyncio.create_task(self._read_loop())
        try:
            await asyncio.wait({reader, feeder}, return_when=asyncio.FIRST_COMPLETED)
            # An already-observed cancel or input failure wins over a final that completed in the same turn.
            if reader.done() and not reader.cancelled() and reader.exception() is not None:
                raise reader.exception()
            return feeder.result()
        finally:
            for task in (reader, feeder):
                task.cancel()
            await asyncio.gather(reader, feeder, return_exceptions=True)

    async def _read_loop(self) -> None:
        loop = asyncio.get_running_loop()
        recording_deadline = loop.time() + self.settings.recording_timeout
        controls = 1
        while True:
            if self.ended:
                message = await self.connection.recv()
            else:
                wait = min(self.settings.idle_timeout, recording_deadline - loop.time())
                try:
                    message = await asyncio.wait_for(self.connection.recv(), max(wait, 0))
                except TimeoutError:
                    raise p.ProtocolFailure(p.TIMEOUT) from None
            if isinstance(message, bytes):
                self._accept_audio(message)
                continue
            controls += 1
            if controls > p.MAX_CONTROL_MESSAGES:
                raise p.ProtocolFailure(p.INVALID_MESSAGE)
            control = p.parse_control(message)
            if control["type"] == "cancel":
                raise StreamCancelled()
            if control["type"] != "end" or self.ended:
                raise p.ProtocolFailure(p.INVALID_MESSAGE)
            if control["sequence"] != self.next_sequence or control["totalSamples"] != self.total_samples:
                raise p.ProtocolFailure(p.INVALID_SEQUENCE)
            self.ended = True
            self.ended_at = loop.time()
            self.final_deadline = loop.time() + self.settings.final_timeout
            if self.timer_entered:
                self.final_timer.reschedule(self.final_deadline)
            self.work.set()

    def _accept_audio(self, message: bytes) -> None:
        if self.ended:
            raise p.ProtocolFailure(p.INVALID_MESSAGE)
        sequence, pcm = p.parse_audio(message)
        if sequence != self.next_sequence:
            raise p.ProtocolFailure(p.INVALID_SEQUENCE)
        samples = len(pcm) // 2
        if self.next_sequence >= p.MAX_AUDIO_MESSAGES or self.total_samples + samples > p.MAX_SAMPLES:
            raise p.ProtocolFailure(p.TOO_LONG)
        if self.queued_samples + self.inflight_samples + samples > p.WINDOW_SAMPLES:
            raise p.ProtocolFailure(p.BACKPRESSURE)
        self.queue.append((sequence, pcm))
        self.queued_samples += samples
        self.next_sequence += 1
        self.total_samples += samples
        self.work.set()

    async def _feed_loop(self, lease) -> str:
        timeout = self.settings.native_call_timeout
        try:
            async with self.final_timer:
                self.timer_entered = True
                if self.final_deadline is not None:
                    self.final_timer.reschedule(self.final_deadline)
                while True:
                    if not self.queue and not self.ended:
                        self.work.clear()
                        await self.work.wait()
                        continue
                    if self.queue:
                        batch, samples, last = [], 0, -1
                        while self.queue and samples + len(self.queue[0][1]) // 2 <= PUSH_MAX_SAMPLES:
                            last, pcm = self.queue.popleft()
                            batch.append(pcm)
                            samples += len(pcm) // 2
                        self.queued_samples -= samples
                        self.inflight_samples = samples
                        await lease.worker.call(CMD_PUSH, b"".join(batch), timeout)
                        self.inflight_samples = 0
                        await self.connection.send(p.ack_message(last))
                        continue
                    return await self._finish(lease, timeout)
        except TimeoutError:
            raise p.ProtocolFailure(p.TIMEOUT) from None
        except WorkerTimeout:
            raise p.ProtocolFailure(p.TIMEOUT) from None
        except WorkerRejected as rejected:
            raise p.ProtocolFailure(p.TOO_LONG if rejected.code == ERR_OUTPUT_LIMIT else p.UNAVAILABLE) from None
        except WorkerError:
            raise p.ProtocolFailure(p.UNAVAILABLE) from None

    async def _finish(self, lease, timeout: float) -> str:
        try:
            _, payload = await lease.worker.call(CMD_FINISH, b"", timeout)
        except WorkerRejected as rejected:
            # Documented zero-audio shortcut: a stream with no samples has nothing to finalize.
            if rejected.code == ERR_NO_FINAL and self.total_samples == 0:
                self.empty_shortcut = True
                return ""
            raise
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            raise p.ProtocolFailure(p.UNAVAILABLE) from None
        if p.utf16_units(text) > p.MAX_FINAL_UTF16_UNITS or len(payload) > p.MAX_FINAL_UTF8_BYTES:
            raise p.ProtocolFailure(p.TOO_LONG)
        return text
