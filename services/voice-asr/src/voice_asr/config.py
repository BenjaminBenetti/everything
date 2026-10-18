"""Operator configuration from the environment, with every value bounded."""
import os
from dataclasses import dataclass


class ConfigError(Exception):
    """Invalid operator configuration; the message names the variable, never its value."""


def _number(env, name, default, low, high, kind=float):
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = kind(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number") from None
    if not low <= value <= high:
        raise ConfigError(f"{name} must be between {low} and {high}")
    return value


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    model_path: str
    worker_path: str
    token: str | None
    omp_thread_limit: int | None
    start_timeout: float
    idle_timeout: float
    recording_timeout: float
    final_timeout: float
    native_call_timeout: float
    cancel_grace: float
    startup_timeout: float
    shutdown_timeout: float
    max_connections: int

    @property
    def session_timeout(self) -> float:
        """Whole stream lifetime: start + recording + finalization."""
        return self.start_timeout + self.recording_timeout + self.final_timeout

    @classmethod
    def from_env(cls, env=os.environ) -> "Settings":
        model_path = env.get("VOICE_ASR_MODEL_PATH", "")
        if not model_path:
            raise ConfigError("VOICE_ASR_MODEL_PATH is required")
        token = env.get("VOICE_ASR_TOKEN") or None
        token_file = env.get("VOICE_ASR_TOKEN_FILE")
        if token_file:
            if token:
                raise ConfigError("set VOICE_ASR_TOKEN or VOICE_ASR_TOKEN_FILE, not both")
            try:
                with open(token_file, encoding="utf-8") as f:
                    token = f.read().strip()
            except (OSError, UnicodeDecodeError):
                raise ConfigError("VOICE_ASR_TOKEN_FILE is not readable") from None
            if not token:
                raise ConfigError("VOICE_ASR_TOKEN_FILE is empty")  # fail closed, never silently disable auth
        if token is not None and (len(token) < 16 or len(token) > 512 or not token.isprintable() or " " in token):
            raise ConfigError("the bearer token must be 16-512 printable characters without spaces")
        threads = env.get("VOICE_ASR_OMP_THREAD_LIMIT")
        return cls(
            host=env.get("VOICE_ASR_HOST", "0.0.0.0"),
            port=_number(env, "PORT", 8080, 1, 65535, int),
            model_path=model_path,
            worker_path=env.get("VOICE_ASR_WORKER_PATH", "/opt/voice-asr/bin/voice-asr-worker"),
            token=token,
            omp_thread_limit=_number(env, "VOICE_ASR_OMP_THREAD_LIMIT", None, 1, 8, int) if threads else None,
            start_timeout=_number(env, "VOICE_ASR_START_TIMEOUT_S", 5.0, 1, 30),
            idle_timeout=_number(env, "VOICE_ASR_IDLE_TIMEOUT_S", 5.0, 1, 30),
            recording_timeout=_number(env, "VOICE_ASR_RECORDING_TIMEOUT_S", 75.0, 60, 120),
            final_timeout=_number(env, "VOICE_ASR_FINAL_TIMEOUT_S", 30.0, 5, 120),
            native_call_timeout=_number(env, "VOICE_ASR_NATIVE_CALL_TIMEOUT_S", 10.0, 5, 60),
            cancel_grace=_number(env, "VOICE_ASR_CANCEL_GRACE_S", 2.0, 0.1, 10),
            startup_timeout=_number(env, "VOICE_ASR_STARTUP_TIMEOUT_S", 120.0, 10, 600),
            shutdown_timeout=_number(env, "VOICE_ASR_SHUTDOWN_TIMEOUT_S", 15.0, 1, 60),
            max_connections=_number(env, "VOICE_ASR_MAX_CONNECTIONS", 4, 1, 32, int),
        )
