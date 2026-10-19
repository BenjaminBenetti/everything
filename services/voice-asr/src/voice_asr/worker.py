"""The isolated native worker process and its private pipe protocol.

One command is in flight at a time. A command runs in a task owned by the worker, so a caller that
gives up (cancel, disconnect) never leaves a reply unread: cleanup waits for that task within a grace
period, and a command that outlives its deadline kills this worker's own process, which is then reaped.
"""
import asyncio
import os
import signal
import struct

CMD_START, CMD_PUSH, CMD_FINISH, CMD_CLOSE, CMD_QUIT = b"S", b"P", b"F", b"C", b"Q"
REPLY_READY, REPLY_OK, REPLY_ACK, REPLY_FINAL, REPLY_CLOSED, REPLY_ERROR = b"R", b"O", b"A", b"T", b"D", b"E"
REPLY_PARTIAL = b"I"           # a push's ACK carrying the changed provisional transcript
START_INTERIM = b"\x01"        # START payload: report provisional transcripts for this stream
ERR_PROTOCOL, ERR_STATE, ERR_NATIVE, ERR_OUTPUT_LIMIT, ERR_NO_FINAL = 1, 2, 3, 4, 5
MAX_REPLY_BYTES = 32_000 * 4


class WorkerError(Exception):
    """The worker cannot serve the stream; it has been (or is being) killed and reaped."""


class WorkerTimeout(WorkerError):
    """A native command outlived its deadline."""


class WorkerRejected(Exception):
    """The worker answered with a protocol-level error byte (it is still alive and consistent)."""

    def __init__(self, code: int):
        super().__init__(code)
        self.code = code


class NativeWorker:
    def __init__(self, argv_prefix: list[str], model_path: str, omp_thread_limit: int | None = None):
        self._argv_prefix = argv_prefix
        self._model_path = model_path
        self._omp_thread_limit = omp_thread_limit
        self._process: asyncio.subprocess.Process | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._inflight: asyncio.Task | None = None
        self._reaped = asyncio.Event()
        self._reap_task: asyncio.Task | None = None
        self._read_transport = None
        self.killed = False
        self.version = ""

    # ---------------------------------------------------------------------
    # Lifecycle
    # ---------------------------------------------------------------------

    async def start(self, timeout: float) -> None:
        loop = asyncio.get_running_loop()
        cmd_read, cmd_write = os.pipe()
        reply_read, reply_write = os.pipe()
        env = {"VOICE_ASR_PARENT_PID": str(os.getpid())}
        if self._omp_thread_limit:
            env["OMP_THREAD_LIMIT"] = str(self._omp_thread_limit)
        try:
            self._process = await asyncio.create_subprocess_exec(
                *self._argv_prefix, str(cmd_read), str(reply_write), self._model_path,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                pass_fds=(cmd_read, reply_write), env=env, close_fds=True,
            )
        except BaseException:
            for fd in (cmd_write, reply_read):
                os.close(fd)
            raise
        finally:
            os.close(cmd_read)
            os.close(reply_write)
        self._reap_task = asyncio.ensure_future(self._reap())
        self._reader = asyncio.StreamReader(limit=MAX_REPLY_BYTES + 16)
        self._read_transport, _ = await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(self._reader), os.fdopen(reply_read, "rb", buffering=0))
        transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, os.fdopen(cmd_write, "wb", buffering=0))
        self._writer = asyncio.StreamWriter(transport, protocol, None, loop)
        try:
            kind, payload = await asyncio.wait_for(self._read_reply(), timeout)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, WorkerError):
            await self.kill()
            raise WorkerError("worker did not become ready") from None
        if kind != REPLY_READY:
            await self.kill()
            raise WorkerError("worker did not become ready")
        self.version = payload.decode("ascii", "replace")[:64]

    async def _reap(self) -> None:
        await self._process.wait()
        self._reaped.set()

    @property
    def alive(self) -> bool:
        return self._process is not None and not self._reaped.is_set()

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process else None

    @property
    def returncode(self) -> int | None:
        return self._process.returncode if self._process else None

    async def wait_exit(self) -> None:
        await self._reaped.wait()

    async def kill(self) -> None:
        """Terminate this worker's own process (never anything else) and wait until it is reaped."""
        self.killed = True
        if self._process is not None and not self._reaped.is_set():
            try:
                self._process.send_signal(signal.SIGKILL)
            except ProcessLookupError:
                pass
        if self._writer is not None:
            self._writer.close()
        if self._process is not None:
            await self._reaped.wait()
        if self._read_transport is not None:
            self._read_transport.close()

    async def quit(self, timeout: float) -> None:
        """Ask the worker to destroy its recognizer and exit; kill it if it does not within timeout."""
        if self.alive and (self._inflight is None or self._inflight.done()):
            try:
                self._write(CMD_QUIT, b"")
                await asyncio.wait_for(self._reaped.wait(), timeout)
            except (asyncio.TimeoutError, ConnectionError, RuntimeError):
                pass
        await self.kill()

    # ---------------------------------------------------------------------
    # Commands
    # ---------------------------------------------------------------------

    def _write(self, kind: bytes, payload: bytes) -> None:
        if self._writer is None or self._writer.is_closing():
            raise WorkerError("worker pipe closed")
        self._writer.write(struct.pack("<I", len(payload)) + kind + payload)

    async def _read_reply(self) -> tuple[bytes, bytes]:
        header = await self._reader.readexactly(5)
        (length,) = struct.unpack_from("<I", header, 0)
        if length > MAX_REPLY_BYTES:
            raise WorkerError("oversized reply")
        return header[4:5], await self._reader.readexactly(length)

    async def _exchange(self, kind: bytes, payload: bytes) -> tuple[bytes, bytes]:
        self._write(kind, payload)
        await self._writer.drain()
        return await self._read_reply()

    async def _roundtrip(self, kind: bytes, payload: bytes, timeout: float) -> tuple[bytes, bytes]:
        # One deadline covers the whole command: queueing the write, draining it into the pipe, and the reply.
        try:
            return await asyncio.wait_for(self._exchange(kind, payload), timeout)
        except asyncio.TimeoutError:
            await self.kill()
            raise WorkerTimeout() from None
        except (asyncio.IncompleteReadError, ConnectionError, WorkerError):
            await self.kill()
            raise WorkerError("worker failed") from None

    async def call(self, kind: bytes, payload: bytes, timeout: float) -> tuple[bytes, bytes]:
        """Run one command; the native work continues to completion (or kill) even if the caller is cancelled."""
        if not self.alive:
            raise WorkerError("worker not running")
        if self._inflight is not None and not self._inflight.done():
            raise WorkerError("command already in flight")
        self._inflight = asyncio.ensure_future(self._roundtrip(kind, payload, timeout))
        self._inflight.add_done_callback(lambda t: t.cancelled() or t.exception())
        # asyncio.wait never cancels the in-flight task when this caller is cancelled.
        await asyncio.wait({self._inflight})
        reply_kind, reply_payload = self._inflight.result()
        if reply_kind == REPLY_ERROR:
            raise WorkerRejected(reply_payload[0] if reply_payload else ERR_PROTOCOL)
        return reply_kind, reply_payload

    async def settle(self, grace: float) -> bool:
        """Wait for any in-flight command to return. False means it did not within grace (caller must kill)."""
        if self._inflight is None or self._inflight.done():
            return True
        done, _ = await asyncio.wait({self._inflight}, timeout=grace)
        return bool(done)
