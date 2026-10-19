"""Test-only stand-in for voice-asr-worker speaking the same pipe protocol. Never used by the service itself.

usage: fake_worker.py MODE COMMAND_FD REPLY_FD MODEL_PATH
Modes: ok, never_ready, hang_push, crash_push, slow_push, hang_finish, long_text, astral_text, native_error_start,
slow_start, hang_first_start, block_first_ipc ("first" = only the first worker process misbehaves), and for streams
started with the interim flag: stable_partial (the same provisional text every push), bad_partial (invalid UTF-8),
huge_partial (over the transcript caps), rogue_partial (partials even without the flag).
In ok mode a stream started with the interim flag answers every push with a changed provisional transcript.
Each process appends its pid to MODEL_PATH + ".pids" and every received command to MODEL_PATH + ".log"
(an interim START is logged as "Si").
"""
import fcntl
import os
import struct
import sys
import time

mode, command_fd, reply_fd, model_path = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
with open(model_path + ".pids", "a") as f:
    f.write(f"{os.getpid()}\n")
first = not os.path.exists(model_path + ".first")
open(model_path + ".first", "a").close()
if mode == "block_first_ipc" and first:
    fcntl.fcntl(command_fd, fcntl.F_SETPIPE_SZ, 4096)  # a small pipe so the parent's writes back up quickly


def note(kind, payload=b""):
    with open(model_path + ".log", "a") as f:
        f.write(f"{os.getpid()}:{kind.decode()}{'i' if kind == b'S' and payload == b'\x01' else ''}\n")


def read_exact(n):
    data = b""
    while len(data) < n:
        chunk = os.read(command_fd, n - len(data))
        if not chunk:
            sys.exit(0)
        data += chunk
    return data


def reply(kind, payload=b""):
    os.write(reply_fd, struct.pack("<I", len(payload)) + kind + payload)


if mode == "never_ready":
    time.sleep(3600)
time.sleep(0.05)
reply(b"R", b"fake-worker")
stream, samples, streams, interim = False, 0, 0, False
while True:
    length, kind = struct.unpack("<IB", read_exact(5))
    payload = read_exact(length)
    kind = bytes([kind])
    note(kind, payload)
    if kind == b"S":
        if mode == "slow_start":
            time.sleep(1.0)
        if mode == "hang_first_start" and first:
            time.sleep(3600)
        if mode == "native_error_start":
            reply(b"E", bytes([3]))
            continue
        if stream:  # like the C worker: a second START while a stream is open is a state error
            reply(b"E", bytes([2]))
            continue
        if payload not in (b"", b"\x01"):
            reply(b"E", bytes([1]))
            continue
        stream, samples, streams, interim = True, 0, streams + 1, payload == b"\x01"
        reply(b"O")
        if mode == "block_first_ipc" and first:
            time.sleep(3600)  # never read the command pipe again
    elif kind == b"P":
        if mode == "hang_push":
            time.sleep(3600)
        if mode == "crash_push":
            os._exit(5)
        if mode == "slow_push":
            time.sleep(0.3)
        samples += length // 2
        if mode == "rogue_partial" or (interim and mode in ("ok", "slow_push")):
            reply(b"I", f"SENTINEL_PARTIAL stream {streams} samples {samples}".encode())
        elif interim and mode == "stable_partial":
            reply(b"I", b"SENTINEL_PARTIAL steady")
        elif interim and mode == "bad_partial":
            reply(b"I", b"\xff\xfe")
        elif interim and mode == "huge_partial":
            reply(b"I", b"a" * 32001)
        else:
            reply(b"A")
    elif kind == b"F":
        if mode == "hang_finish":
            time.sleep(3600)
        if mode == "long_text":
            reply(b"T", b"a" * 32001)
        elif mode == "astral_text":
            reply(b"T", ("\U0001F600" * 16001).encode())
        elif samples == 0:
            reply(b"E", bytes([5]))
        else:
            reply(b"T", f"SENTINEL_TRANSCRIPT stream {streams} samples {samples}".encode())
    elif kind == b"C":
        stream = False
        reply(b"D")
    elif kind == b"Q":
        sys.exit(0)
    else:
        reply(b"E", bytes([1]))
