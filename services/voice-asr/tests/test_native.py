"""Real-native stream tests: the pinned Nemotron model through the new server (or an external one, e.g. the image).

Skipped unless these are set:
  VOICE_ASR_AUDIO_DIR      public 16 kHz mono PCM16 WAVs + manifest.json (ls_05s, ls_10s, ls_20s, ls_30s, silence_03s)
  and either VOICE_ASR_TEST_URL (an already running service, e.g. the container)
  or VOICE_ASR_NATIVE_WORKER + VOICE_ASR_NATIVE_MODEL (start the server in-process with the real worker).
VOICE_ASR_RESULTS optionally names a JSON file for the measured timings and transcripts.
"""
import asyncio
import json
import os
import re
import signal
import struct
import subprocess
import sys
import time
import unittest
import wave

from websockets.asyncio.client import connect

from support import SILENT, START, http_get, settings

AUDIO = os.environ.get("VOICE_ASR_AUDIO_DIR")
URL = os.environ.get("VOICE_ASR_TEST_URL")
WORKER = os.environ.get("VOICE_ASR_NATIVE_WORKER")
MODEL = os.environ.get("VOICE_ASR_NATIVE_MODEL")
RESULTS = os.environ.get("VOICE_ASR_RESULTS")
ENABLED = bool(AUDIO and (URL or (WORKER and MODEL)))


def pcm(name: str) -> bytes:
    with wave.open(os.path.join(AUDIO, name + ".wav"), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        return w.readframes(w.getnframes())


def words(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9' ]+", " ", text.lower().replace("-", " ")).split()


def word_edits(ref: list[str], hyp: list[str]) -> int:
    row = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, row[0] = row[0], i
        for j, h in enumerate(hyp, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (r != h))
    return row[-1]


START_V2 = json.dumps({**json.loads(START), "version": 2})


async def run_stream(url, audio: bytes, frame_samples=320, realtime=True, cancel_after_s=None, extra_frame=None, odd=False,
                     version=1):
    """Stream audio with the given protocol version. Arrival is paced by sample time when realtime; the credit window is
    respected in both modes. Returns the terminal message plus timings, and every partial with when it arrived."""
    loop = asyncio.get_running_loop()
    for busy_retries in range(50):  # the single lease stays held until a previous stream's native cleanup is done
        ws = await connect(url, max_size=None, open_timeout=10, logger=SILENT)
        await ws.send(START_V2 if version == 2 else START)
        ready = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if ready != {"type": "error", "code": "BUSY"}:
            break
        await ws.close()
        await asyncio.sleep(0.1)
    async with ws:
        assert ready["type"] == "ready", ready
        n = len(audio) // 2
        frames = [audio[2 * i: 2 * min(i + frame_samples, n)] for i in range(0, n, frame_samples)]
        sizes, acked, outstanding = {}, -1, 0
        credit = asyncio.Condition()
        result = {"partials": [], "versions_header": ws.response.headers.get("Voice-Stream-Versions")}

        async def receive():
            nonlocal acked, outstanding
            async for message in ws:
                data = json.loads(message)
                if data["type"] == "partial":
                    result["partials"].append((loop.time(), data))
                elif data["type"] == "ack":
                    async with credit:
                        for seq in range(acked + 1, data["sequence"] + 1):
                            outstanding -= sizes[seq]
                        acked = data["sequence"]
                        credit.notify_all()
                else:
                    result["terminal"], result["at"] = data, loop.time()
                    return

        receiver = asyncio.create_task(receive())
        t0 = result["t0"] = loop.time()
        max_late, sent_samples = 0.0, 0
        for seq, payload in enumerate(frames):
            samples = len(payload) // 2
            due = t0 + (sent_samples + samples) / 16000
            if realtime and loop.time() < due:
                await asyncio.sleep(due - loop.time())
            if cancel_after_s is not None and sent_samples >= cancel_after_s * 16000:
                await ws.send('{"type":"cancel"}')
                break
            async with credit:
                await credit.wait_for(lambda: outstanding + samples <= 16000 or receiver.done())
                if receiver.done():
                    break
                sizes[seq] = samples
                outstanding += samples
            if realtime:
                max_late = max(max_late, loop.time() - due)
            body = payload[:-1] if odd and seq == len(frames) - 1 else payload
            await ws.send(struct.pack("<I", seq) + body)
            sent_samples += samples
        else:
            if extra_frame is not None:
                await ws.send(struct.pack("<I", len(frames)) + extra_frame)
            release = t0 + n / 16000
            await ws.send(json.dumps({"type": "end", "sequence": len(frames), "totalSamples": n}))
            result["end_sent_at"], result["release_at"] = loop.time(), release
        await asyncio.wait_for(receiver, 120)
        result["max_send_lateness_s"] = max_late
        result["busy_retries"] = busy_retries
        return result


@unittest.skipUnless(ENABLED, "set VOICE_ASR_AUDIO_DIR and VOICE_ASR_TEST_URL or VOICE_ASR_NATIVE_WORKER/MODEL")
class NativeStreams(unittest.IsolatedAsyncioTestCase):
    async def test_native_streams(self):
        with open(os.path.join(AUDIO, "manifest.json")) as f:
            manifest = {m["clip"]: m for m in json.load(f)}
        records = {}
        server = lifecycle = None
        if URL:
            url = URL
        else:
            from voice_asr.server import VoiceAsrServer
            from voice_asr.supervisor import Supervisor
            config = settings(model_path=MODEL, worker_path=WORKER, startup_timeout=180, native_call_timeout=10,
                              final_timeout=30, idle_timeout=5, start_timeout=5, cancel_grace=2)
            supervisor = Supervisor(config)
            server = VoiceAsrServer(config, supervisor)
            lifecycle = asyncio.create_task(supervisor.run())
            await server.start()
            began = time.monotonic()
            while not supervisor.ready:
                self.assertLess(time.monotonic() - began, 180, "native worker did not become ready")
                await asyncio.sleep(0.1)
            records["startup_to_ready_s"] = round(time.monotonic() - began, 3)
            url = f"ws://127.0.0.1:{server.port}/v1/stream"
        try:
            async def check_final(name, clip, **kwargs):
                r = await run_stream(url, pcm(clip), **kwargs)
                self.assertEqual(r["terminal"]["type"], "final", (name, r["terminal"]))
                ref, hyp = words(manifest[clip]["reference"]), words(r["terminal"]["text"])
                records[name] = {
                    "clip": clip, "text": r["terminal"]["text"], "ref_words": len(ref), "hyp_words": len(hyp),
                    "word_edits": word_edits(ref, hyp) if ref else None,
                    # scheduled arrival of the last real sample -> final (meaningful only for real-time replay)
                    "release_to_final_s": round(r["at"] - r["release_at"], 3) if kwargs.get("realtime", True) else None,
                    "end_sent_to_final_s": round(r["at"] - r["end_sent_at"], 3),
                    "max_send_lateness_s": round(r["max_send_lateness_s"], 3), "realtime": kwargs.get("realtime", True),
                }
                return ref, hyp

            for clip in ("ls_10s", "ls_30s"):
                ref, hyp = await check_final(f"realtime_{clip}", clip)
                self.assertEqual(hyp[-2:], ref[-2:], f"tail words of {clip}")
            ref, hyp = await check_final("realtime_ls_10s_repeat", "ls_10s")
            self.assertEqual(hyp[-1], ref[-1])
            _, hyp = await check_final("silence", "silence_03s", realtime=False, frame_samples=3200)
            self.assertEqual(hyp, [])
            ref, hyp = await check_final("short_last_frame", "ls_05s", realtime=False, frame_samples=3200)  # 25 x 3200 + 240
            self.assertEqual(hyp[-2:], ref[-2:])

            r = await run_stream(url, pcm("ls_05s"), realtime=False, frame_samples=3200, odd=True)
            self.assertEqual(r["terminal"], {"type": "error", "code": "INVALID_AUDIO"})
            r = await run_stream(url, b"", realtime=False)
            self.assertEqual(r["terminal"], {"type": "final", "text": ""})
            records["immediate_end"] = r["terminal"]

            # Version 2: the native provisional transcript arrives while real-time audio streams, before end, and
            # the final replaces it once. A version 1 stream on the same service gets no partials.
            r = await run_stream(url, pcm("ls_10s"), version=2)
            self.assertEqual(r["versions_header"], "1, 2")
            self.assertEqual(r["terminal"]["type"], "final")
            partials = [data for _, data in r["partials"]]
            before_end = [data for at, data in r["partials"] if at < r["end_sent_at"]]
            self.assertEqual([data["revision"] for data in partials], list(range(1, len(partials) + 1)))
            self.assertGreater(len(before_end), 3, "partials arrive while audio streams")
            ref, hyp = words(manifest["ls_10s"]["reference"]), words(r["terminal"]["text"])
            self.assertEqual(hyp[-2:], ref[-2:], "the final keeps the tail")
            self.assertLessEqual(word_edits(ref, hyp), 3, "the final is the transcript once, with no repeated tail")
            self.assertTrue(set(words(before_end[-1]["text"])) & set(ref), "partials are the clip's words")
            records["live_ls_10s"] = {
                "partials": len(partials), "partials_before_end": len(before_end),
                "first_partial_after_start_s": round(r["partials"][0][0] - r["t0"], 3),
                "last_partial_before_end": before_end[-1]["text"], "final": r["terminal"]["text"],
                "release_to_final_s": round(r["at"] - r["release_at"], 3), "word_edits": word_edits(ref, hyp),
            }
            r = await run_stream(url, pcm("ls_05s"), realtime=False, frame_samples=3200)
            self.assertEqual((r["terminal"]["type"], r["partials"]), ("final", []), "version 1 gets only the final")

            r = await run_stream(url, pcm("ls_30s"), realtime=False, frame_samples=3200, cancel_after_s=10)
            self.assertEqual(r["terminal"], {"type": "cancelled"})
            ref, hyp = await check_final("after_cancel_ls_05s", "ls_05s", realtime=False, frame_samples=3200)
            self.assertFalse({"linnell's", "pictures", "jingo"} & set(hyp), "no words from the cancelled stream")

            # 60 s boundary: labelled concatenation of public clips + zero padding; fast credit-obeying feed
            # (NOT a release-latency replay, NOT natural speech).
            concat = pcm("ls_30s") + pcm("ls_20s") + pcm("ls_10s")
            concat += b"\x00\x00" * (960000 - len(concat) // 2)
            began = time.monotonic()
            r = await run_stream(url, concat, realtime=False, frame_samples=3200)
            self.assertEqual(r["terminal"]["type"], "final")
            hyp = words(r["terminal"]["text"])
            for word in ("pictures", "laments", "ithaca"):
                self.assertIn(word, hyp, "each concatenated segment is transcribed")
            records["cap_960000_fast"] = {"wall_s": round(time.monotonic() - began, 3), "hyp_words": len(hyp),
                                          "end_sent_to_final_s": round(r["at"] - r["end_sent_at"], 3)}
            r = await run_stream(url, concat, realtime=False, frame_samples=3200, extra_frame=b"\x00\x00")
            self.assertEqual(r["terminal"], {"type": "error", "code": "TOO_LONG"})
        finally:
            if server is not None:
                await server.stop()
                lifecycle.cancel()
                await asyncio.gather(lifecycle, return_exceptions=True)
            if RESULTS:
                with open(RESULTS, "w") as f:
                    json.dump(records, f, indent=1)


@unittest.skipUnless(AUDIO and WORKER and MODEL and not URL, "needs the native worker and model")
class NativeProcessLifecycle(unittest.TestCase):
    """The real service process: SIGTERM drains and reaps; SIGKILL of the parent takes the worker with it."""

    def start_service(self):
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": os.path.join(os.path.dirname(__file__), "..", "src"),
               "VOICE_ASR_MODEL_PATH": MODEL, "VOICE_ASR_WORKER_PATH": WORKER, "VOICE_ASR_HOST": "127.0.0.1", "PORT": "0"}
        port = 18000 + os.getpid() % 1000
        env["PORT"] = str(port)
        process = subprocess.Popen([sys.executable, "-m", "voice_asr"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                if asyncio.run(http_get(port, "/readyz")) == 200:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        else:
            process.kill()
            self.fail("service did not become ready")
        children = open(f"/proc/{process.pid}/task/{process.pid}/children").read().split()
        self.assertEqual(len(children), 1, "exactly one native worker")
        return process, int(children[0])

    @staticmethod
    def gone(pid, seconds=10.0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                with open(f"/proc/{pid}/stat") as f:
                    if f.read().split()[2] == "Z":
                        return True
            except FileNotFoundError:
                return True
            time.sleep(0.05)
        return False

    def test_sigterm_and_parent_death(self):
        process, worker = self.start_service()
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(30), 0)
        logs = process.stderr.read().decode()
        self.assertIn("shutdown_complete", logs)
        self.assertTrue(self.gone(worker), "SIGTERM shutdown reaps the worker")
        process, worker = self.start_service()
        process.kill()
        process.wait(10)
        self.assertTrue(self.gone(worker), "parent death kills the worker (PR_SET_PDEATHSIG)")


if __name__ == "__main__":
    unittest.main()
