"""WebSocket server: health/readiness probes, optional bearer auth, bounded connections, graceful shutdown."""
import asyncio
import hmac
import http
import logging
import signal
import sys

from websockets.asyncio.server import serve

from . import protocol as p
from .config import ConfigError, Settings
from .session import StreamSession
from .supervisor import Supervisor

log = logging.getLogger("voice_asr")
# The websockets library logs request headers, frame previews and exception text (handshake failures,
# close reasons). Its connections use this logger, disabled outright, so tokens, audio and transcripts can never
# reach logs; the service logs its own fixed events instead.
transport_log = logging.getLogger("voice_asr.transport")
transport_log.disabled = True
transport_log.propagate = False


class VoiceAsrServer:
    def __init__(self, settings: Settings, supervisor: Supervisor):
        self.settings = settings
        self.supervisor = supervisor
        self._expected_auth = f"Bearer {settings.token}".encode() if settings.token else None
        self._connections = 0
        self._server = None

    def _authorized(self, request) -> bool:
        if self._expected_auth is None:
            return True
        values = request.headers.get_all("Authorization")
        return len(values) == 1 and hmac.compare_digest(values[0].encode("utf-8", "replace"), self._expected_auth)

    def process_request(self, connection, request):
        """Answer probes and reject unauthorized or excess upgrades before any native work. Never raises."""
        path, _, query = request.path.partition("?")
        if path == "/healthz":
            return connection.respond(http.HTTPStatus.OK, "ok\n")
        if path == "/readyz":
            if self.supervisor.ready:
                return connection.respond(http.HTTPStatus.OK, "ready\n")
            return connection.respond(http.HTTPStatus.SERVICE_UNAVAILABLE, "not ready\n")
        if path != "/v1/stream":
            return connection.respond(http.HTTPStatus.NOT_FOUND, "not found\n")
        if query:
            return connection.respond(http.HTTPStatus.BAD_REQUEST, "bad request\n")
        if not self._authorized(request):
            return connection.respond(http.HTTPStatus.UNAUTHORIZED, "unauthorized\n")
        if self._connections >= self.settings.max_connections:
            return connection.respond(http.HTTPStatus.SERVICE_UNAVAILABLE, "busy\n")
        return None

    async def handle(self, connection) -> None:
        self._connections += 1
        try:
            await StreamSession(connection, self.supervisor, self.settings).run()
        except Exception as error:  # never let the library log exception text
            log.error("stream_failed error=%s", type(error).__name__)
        finally:
            self._connections -= 1

    async def start(self) -> None:
        self._server = await serve(
            self.handle, self.settings.host, self.settings.port,
            process_request=self.process_request,
            max_size=p.MAX_BINARY_BYTES, max_queue=32, compression=None,
            open_timeout=self.settings.start_timeout, close_timeout=2, logger=transport_log,
        )

    @property
    def port(self) -> int:
        return self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        """Stop admissions, close streams (sessions clean up their lease), then stop the worker."""
        if self._server is not None:
            self._server.close(close_connections=True)
            try:
                await asyncio.wait_for(self._server.wait_closed(), self.settings.shutdown_timeout)
            except TimeoutError:
                pass
        await self.supervisor.stop()


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    for noisy in ("websockets", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


async def serve_forever(settings: Settings) -> None:
    supervisor = Supervisor(settings)
    server = VoiceAsrServer(settings, supervisor)
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopping.set)
    lifecycle = asyncio.create_task(supervisor.run())
    await server.start()
    if settings.token is None:
        log.warning("auth_disabled private_network_only=true")
    log.info("listening port=%d", server.port)
    await stopping.wait()
    log.info("shutdown_started")
    await server.stop()
    lifecycle.cancel()
    await asyncio.gather(lifecycle, return_exceptions=True)
    log.info("shutdown_complete")


def main() -> None:
    configure_logging()
    try:
        settings = Settings.from_env()
    except ConfigError as error:
        log.error("config_error %s", error)
        raise SystemExit(2) from None
    asyncio.run(serve_forever(settings))
