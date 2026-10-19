"""Voice streaming wire protocol: constants, safe error codes and message validation.

Version 1 is frozen. Version 2 is version 1 plus `partial` messages, the provisional transcript while
audio streams; a client asks for it with its start message. The upgrade response's versions header
lets a client learn that this service speaks version 2 before it sends start.
"""
import json
import struct

# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

VERSION = 1
LIVE_VERSION = 2               # version 1 plus partial transcripts
VERSIONS = (VERSION, LIVE_VERSION)
VERSIONS_HEADER = "Voice-Stream-Versions"
VERSIONS_HEADER_VALUE = "1, 2"
SAMPLE_RATE = 16000
MAX_SAMPLES = 960_000          # 60 s of 16 kHz mono
MAX_FRAME_SAMPLES = 3200
WINDOW_SAMPLES = 16_000        # unacknowledged queued + in-flight samples
MAX_AUDIO_MESSAGES = 6000
MAX_CONTROL_BYTES = 1024
MAX_BINARY_BYTES = 4 + 2 * MAX_FRAME_SAMPLES
MAX_CONTROL_MESSAGES = 8       # start + end + a few idempotent cancels
MAX_FINAL_UTF16_UNITS = 32_000
MAX_FINAL_UTF8_BYTES = 4 * MAX_FINAL_UTF16_UNITS

CANCELLED_MESSAGE = '{"type":"cancelled"}'

# ---------------------------------------------------------------------------
# Safe error codes (allowlist; never extended with dynamic text)
# ---------------------------------------------------------------------------

INVALID_MESSAGE = "INVALID_MESSAGE"
INVALID_SEQUENCE = "INVALID_SEQUENCE"
INVALID_AUDIO = "INVALID_AUDIO"
TOO_LONG = "TOO_LONG"
BUSY = "BUSY"
UNAVAILABLE = "UNAVAILABLE"
BACKPRESSURE = "BACKPRESSURE"
TIMEOUT = "TIMEOUT"
ERROR_CODES = frozenset({INVALID_MESSAGE, INVALID_SEQUENCE, INVALID_AUDIO, TOO_LONG, BUSY, UNAVAILABLE, BACKPRESSURE, TIMEOUT})


class ProtocolFailure(Exception):
    """A terminal stream failure carrying one allowlisted error code."""

    def __init__(self, code: str):
        if code not in ERROR_CODES:
            raise ValueError("unknown error code")
        super().__init__(code)
        self.code = code


def error_message(code: str) -> str:
    if code not in ERROR_CODES:
        code = UNAVAILABLE
    return json.dumps({"type": "error", "code": code}, separators=(",", ":"))


def ready_message(version: int) -> str:
    """Ready for a stream of the given version, carrying the limits."""
    return json.dumps({
        "type": "ready", "version": version, "maxSamples": MAX_SAMPLES,
        "maxFrameSamples": MAX_FRAME_SAMPLES, "windowSamples": WINDOW_SAMPLES,
    }, separators=(",", ":"))


READY_MESSAGE = ready_message(VERSION)


def ack_message(sequence: int) -> str:
    return json.dumps({"type": "ack", "sequence": sequence}, separators=(",", ":"))


def partial_message(revision: int, text: str) -> str:
    """Version 2: the provisional transcript so far; revisions count up from 1."""
    return json.dumps({"type": "partial", "revision": revision, "text": text}, ensure_ascii=False, separators=(",", ":"))


def final_message(text: str) -> str:
    return json.dumps({"type": "final", "text": text}, ensure_ascii=False, separators=(",", ":"))


def utf16_units(text: str) -> int:
    """Length of text as a JavaScript string (UTF-16 code units)."""
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


def within_text_caps(text: str, utf8_bytes: int) -> bool:
    """Whether a transcript fits the final's caps, which partials share."""
    return utf8_bytes <= MAX_FINAL_UTF8_BYTES and utf16_units(text) <= MAX_FINAL_UTF16_UNITS


# ---------------------------------------------------------------------------
# Inbound messages
# ---------------------------------------------------------------------------

def _reject_duplicates(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def parse_control(message: str) -> dict:
    """Parse one text control message into a validated dict, or raise ProtocolFailure(INVALID_MESSAGE)."""
    if len(message.encode("utf-8")) > MAX_CONTROL_BYTES:
        raise ProtocolFailure(INVALID_MESSAGE)
    try:
        value = json.loads(message, object_pairs_hook=_reject_duplicates)
    except (ValueError, RecursionError):
        raise ProtocolFailure(INVALID_MESSAGE) from None
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise ProtocolFailure(INVALID_MESSAGE)
    kind = value["type"]
    if kind == "start":
        # The version is any one this service speaks; every other field is fixed.
        expected = {"type": "start", "version": value.get("version"), "sampleRate": SAMPLE_RATE, "channels": 1,
                    "format": "pcm_s16le"}
        if set(value) != set(expected) or not _is_int(value["version"]) or value["version"] not in VERSIONS or any(
            (_is_int(expected[key]) and not _is_int(value[key])) or value[key] != expected[key] for key in expected
        ):
            raise ProtocolFailure(INVALID_MESSAGE)
    elif kind == "end":
        if set(value) != {"type", "sequence", "totalSamples"} or not _is_int(value["sequence"]) or not _is_int(value["totalSamples"]):
            raise ProtocolFailure(INVALID_MESSAGE)
    elif kind == "cancel":
        if set(value) != {"type"}:
            raise ProtocolFailure(INVALID_MESSAGE)
    else:
        raise ProtocolFailure(INVALID_MESSAGE)
    return value


def parse_audio(message: bytes) -> tuple[int, bytes]:
    """Split one binary audio message into (sequence, PCM16LE payload) or raise INVALID_AUDIO."""
    if len(message) < 6 or len(message) > MAX_BINARY_BYTES or (len(message) - 4) % 2 != 0:
        raise ProtocolFailure(INVALID_AUDIO)
    (sequence,) = struct.unpack_from("<I", message, 0)
    return sequence, message[4:]
