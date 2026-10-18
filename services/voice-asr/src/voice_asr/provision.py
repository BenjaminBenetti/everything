"""Model provisioning, run once before the service starts (the chart's init container): install the ONE pinned
Nemotron GGUF in the model cache, or confirm the cached copy, so the service only ever reads a verified file.

The download is streamed to a private partial file with a byte cap, a per-read timeout and an overall
deadline, checked against the pinned size and SHA-256, made read-only and renamed into place atomically.
The model is licensed under the NVIDIA Open Model License; VOICE_ASR_MODEL_LICENSE must name it to install.
"""
import hashlib
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from .config import ConfigError, _number
from .system import NEMOTRON_EN_Q8_0, ModelPin, model_matches

log = logging.getLogger("voice_asr.provision")

LICENSE = "NVIDIA-Open-Model-License"
LICENSE_URL = "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/"
_BLOCK = 1 << 20


class ProvisionError(Exception):
    """The model could not be installed; the message never includes downloaded data."""


@dataclass(frozen=True)
class ModelSource:
    url: str
    repository: str
    revision: str
    filename: str
    pin: ModelPin

    @property
    def notice(self) -> str:
        return (
            "Licensed by NVIDIA Corporation under the NVIDIA Open Model License\n"
            f"Model: {self.repository} @ {self.revision}, file {self.filename}\n"
            f"Agreement: {LICENSE_URL}\n"
        )


def _hugging_face(repository: str, revision: str, filename: str, pin: ModelPin) -> ModelSource:
    url = f"https://huggingface.co/{repository}/resolve/{revision}/{filename}"
    return ModelSource(url, repository, revision, filename, pin)


# The official file system.NEMOTRON_EN_Q8_0 pins, at a fixed revision. Not operator-overridable.
NEMOTRON_EN_Q8_0_SOURCE = _hugging_face(
    "nvidia/nemotron-speech-streaming-en-0.6b",
    "ebe59e5a817142986528bbbee5dba8db7b38ed50",
    "nemotron-speech-streaming-en-0.6b.q8_0.gguf",
    NEMOTRON_EN_Q8_0,
)


class _HttpsRedirects(urllib.request.HTTPRedirectHandler):
    """Follow the model host's redirects to its download servers, but never from HTTPS to anything else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(req.full_url).scheme == "https" and urllib.parse.urlsplit(newurl).scheme != "https":
            raise ProvisionError("the model host redirected away from HTTPS")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _write_notice(directory: str, source: ModelSource) -> None:
    notice = os.path.join(directory, "NOTICE")
    try:
        with open(notice, encoding="utf-8") as f:
            if f.read() == source.notice:
                return
    except OSError:
        pass
    partial = notice + ".partial"
    with open(partial, "w", encoding="utf-8") as f:
        f.write(source.notice)
    os.chmod(partial, 0o444)
    os.replace(partial, notice)


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _download(url: str, partial: str, pin: ModelPin, deadline: float, read_timeout: float) -> None:
    opener = urllib.request.build_opener(_HttpsRedirects)
    digest, received = hashlib.sha256(), 0
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out, opener.open(url, timeout=read_timeout) as response:
        length = response.headers.get("Content-Length")
        if length is not None and length.isdigit() and int(length) != pin.size:
            raise ProvisionError("the model host offered a file of the wrong size")
        while True:
            if time.monotonic() > deadline:
                raise ProvisionError("the download did not finish before its deadline")
            block = response.read(_BLOCK)
            if not block:
                break
            received += len(block)
            if received > pin.size:
                raise ProvisionError("the download is larger than the pinned model")
            digest.update(block)
            out.write(block)
        out.flush()
        os.fsync(out.fileno())
    if received != pin.size or digest.hexdigest() != pin.sha256:
        raise ProvisionError("the download does not match the pinned size and SHA-256")


def provision(path: str, source: ModelSource, *, deadline_s: float, read_timeout_s: float) -> str:
    """Install the pinned model at path unless a verified copy is already there; returns "cached" or "installed"."""
    directory = os.path.dirname(os.path.abspath(path))
    if model_matches(path, source.pin):
        _write_notice(directory, source)
        return "cached"
    partial = path + ".partial"
    _remove(path)  # a copy that failed the check is never kept
    _remove(partial)  # left by an interrupted attempt
    try:
        _download(source.url, partial, source.pin, time.monotonic() + deadline_s, read_timeout_s)
        os.chmod(partial, 0o444)
        os.replace(partial, path)
    except BaseException:
        _remove(partial)
        raise
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    _write_notice(directory, source)
    return "installed"


def main(env=os.environ) -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        path = env.get("VOICE_ASR_MODEL_PATH", "")
        if not path:
            raise ConfigError("VOICE_ASR_MODEL_PATH is required")
        if env.get("VOICE_ASR_MODEL_LICENSE") != LICENSE:
            raise ConfigError(f"VOICE_ASR_MODEL_LICENSE must be {LICENSE} to install the model under that license")
        deadline = _number(env, "VOICE_ASR_PROVISION_TIMEOUT_S", 1800.0, 60, 7200)
        read_timeout = _number(env, "VOICE_ASR_PROVISION_READ_TIMEOUT_S", 30.0, 5, 300)
    except ConfigError as error:
        log.error("config_error %s", error)
        return 2
    source = NEMOTRON_EN_Q8_0_SOURCE
    log.info("model_check revision=%s file=%s", source.revision, source.filename)
    started = time.monotonic()
    try:
        outcome = provision(path, source, deadline_s=deadline, read_timeout_s=read_timeout)
    except ProvisionError as error:
        log.error("model_provision_failed %s", error)
        return 1
    except urllib.error.HTTPError as error:
        log.error("model_provision_failed http_status=%d", error.code)
        return 1
    except OSError as error:
        # Network and file errors; the only URL involved is the public, pinned one.
        log.error("model_provision_failed %s: %s", type(error).__name__, str(error)[:200])
        return 1
    log.info("model_%s bytes=%d sha256=%s seconds=%.1f", outcome, source.pin.size, source.pin.sha256,
             time.monotonic() - started)
    return 0


if __name__ == "__main__":
    sys.exit(main())
