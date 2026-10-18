"""Test-only stand-in for voice-asr-worker speaking the same pipe protocol. Never used by the service itself.

usage: fake_worker.py MODE COMMAND_FD REPLY_FD MODEL_PATH
Modes: ok, never_ready, hang_push, crash_push, slow_push, hang_finish, long_text, astral_text, native_error_start.
Each process appends its pid to MODEL_PATH + ".pids" so tests can check it was reaped.
"""
import os
import struct
import sys
import time

mode, command_fd, reply_fd, model_path = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
with open(model_path + ".pids", "a") as f:
    f.write(f"{os.getpid()}\n")


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
stream, samples, streams = False, 0, 0
while True:
    length, kind = struct.unpack("<IB", read_exact(5))
    payload = read_exact(length)
    kind = bytes([kind])
    if kind == b"S":
        if mode == "native_error_start":
            reply(b"E", bytes([3]))
            continue
        stream, samples, streams = True, 0, streams + 1
        reply(b"O")
    elif kind == b"P":
        if mode == "hang_push":
            time.sleep(3600)
        if mode == "crash_push":
            os._exit(5)
        if mode == "slow_push":
            time.sleep(0.3)
        samples += length // 2
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
