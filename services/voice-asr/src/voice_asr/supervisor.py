"""Native worker lifecycle, readiness and the single global stream lease."""
import asyncio
import logging
from collections.abc import Callable

from . import system
from .worker import CMD_CLOSE, CMD_START, NativeWorker, WorkerError, WorkerRejected

log = logging.getLogger("voice_asr")


class Lease:
    """Exclusive use of the warmed worker for one stream. Released only after native work is quiescent."""

    def __init__(self, supervisor: "Supervisor", worker: NativeWorker):
        self._supervisor = supervisor
        self.worker = worker
        self.stream_open = False
        self._cleanup: asyncio.Future | None = None

    async def open_stream(self, timeout: float) -> None:
        # Intent first: if the caller is interrupted while START is in flight, the native stream may still be
        # created, so cleanup must settle the call and CLOSE (a CLOSE without a stream is a no-op in the worker).
        self.stream_open = True
        await self.worker.call(CMD_START, b"", timeout)

    async def cleanup(self, grace: float, native_timeout: float) -> None:
        """Make native work quiescent, then release the lease. Idempotent.

        The work runs in its own task: cancelling the caller (shutdown, disconnect) never releases the lease
        early. The lease is released only after a verified native close or after the worker was killed and reaped.
        """
        if self._cleanup is None:
            self._cleanup = asyncio.ensure_future(self._quiesce(grace, native_timeout))
        await asyncio.wait({self._cleanup})
        self._cleanup.result()

    async def _quiesce(self, grace: float, native_timeout: float) -> None:
        try:
            if self.worker.alive and not await self.worker.settle(grace):
                await self.worker.kill()
            if self.worker.alive and self.stream_open:
                try:
                    await self.worker.call(CMD_CLOSE, b"", native_timeout)
                except WorkerRejected:
                    await self.worker.kill()
                except WorkerError:
                    pass
        except Exception:
            await self.worker.kill()
        if not self.worker.alive:
            await self.worker.wait_exit()
        self.stream_open = False
        self._supervisor._release(self)


class Supervisor:
    def __init__(self, settings, worker_factory: Callable[[], NativeWorker] | None = None,
                 cpuinfo_path: str = "/proc/cpuinfo", model_pin: system.ModelPin = system.NEMOTRON_EN_Q8_0):
        self._settings = settings
        self._worker_factory = worker_factory or (lambda: NativeWorker([settings.worker_path], settings.model_path, settings.omp_thread_limit))
        self._cpuinfo_path = cpuinfo_path
        self._model_pin = model_pin
        self._worker: NativeWorker | None = None
        self._lease: Lease | None = None
        self._lease_released = asyncio.Event()
        self._lease_released.set()
        self._stopping = False
        self._ready = False
        self._warming: NativeWorker | None = None
        self.state = "starting"

    @property
    def ready(self) -> bool:
        return self._ready and not self._stopping and self._worker is not None and self._worker.alive

    @property
    def idle(self) -> bool:
        """Ready with no lease held (used by tests and diagnostics)."""
        return self.ready and self._lease is None

    def try_lease(self) -> Lease | str:
        """A lease on the warmed worker, or the safe error code explaining why none is available."""
        if self._lease is not None:
            return "BUSY"
        if not self.ready:
            return "UNAVAILABLE"
        self._lease = Lease(self, self._worker)
        self._lease_released.clear()
        return self._lease

    def _release(self, lease: Lease) -> None:
        if self._lease is lease:
            self._lease = None
            self._lease_released.set()

    def _set_state(self, state: str) -> None:
        if state != self.state:
            self.state = state
            log.info("worker_state state=%s", state)

    # ---------------------------------------------------------------------
    # Lifecycle
    # ---------------------------------------------------------------------

    async def run(self) -> None:
        """Start, warm and keep one native worker running until stop()."""
        if not system.cpu_supported(self._cpuinfo_path):
            self._set_state("cpu_unsupported")
            return
        backoff = 1.0
        while not self._stopping:
            await self._lease_released.wait()
            self._set_state("verifying_model")
            if not await asyncio.to_thread(system.model_matches, self._settings.model_path, self._model_pin):
                self._set_state("model_invalid")
                await self._sleep(backoff)
                backoff = min(backoff * 2, 60.0)
                continue
            self._set_state("warming")
            worker = self._worker_factory()
            self._warming = worker
            try:
                await worker.start(self._settings.startup_timeout)
            except (WorkerError, OSError):
                await worker.kill()
                log.info("worker_exit code=%s", worker.returncode)
                self._set_state("worker_failed")
                await self._sleep(backoff)
                backoff = min(backoff * 2, 60.0)
                continue
            finally:
                self._warming = None
            if self._stopping:
                await worker.quit(self._settings.shutdown_timeout)
                break
            self._worker = worker
            self._ready = True
            backoff = 1.0
            self._set_state("ready")
            await worker.wait_exit()
            self._ready = False
            self._worker = None
            if not self._stopping:
                self._set_state("restarting")
                await self._sleep(0.5)

    async def _sleep(self, seconds: float) -> None:
        deadline = asyncio.get_running_loop().time() + seconds
        while not self._stopping and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(min(0.1, seconds))

    async def stop(self) -> None:
        """Stop admissions, wait boundedly for the active lease, then quit or kill and reap the worker."""
        self._stopping = True
        self._ready = False
        try:
            await asyncio.wait_for(self._lease_released.wait(), self._settings.shutdown_timeout)
        except asyncio.TimeoutError:
            pass
        if self._warming is not None:
            await self._warming.kill()  # a hung or slow warmup is this service's own child
        worker = self._worker
        if worker is not None:
            await worker.quit(self._settings.shutdown_timeout)
        self._set_state("stopped")
