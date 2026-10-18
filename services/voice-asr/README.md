# voice-asr

Internal, CPU-only streaming speech-to-text sidecar for Everything's hold-to-talk voice input. It runs NVIDIA's English **Nemotron Speech Streaming 0.6B (Q8_0)** model through the public C ABI of NVIDIA **NeMo-Speech.cpp**. It speaks the frozen **voice streaming v1** WebSocket protocol to the Everything gateway.

- **Network position.** The service sits behind the authenticated Everything gateway on a private network. The gateway owns user/Keycloak/teammate/Origin checks and admission. This service only checks an optional operator bearer token.
- **No public exposure.** Do not expose it publicly without auth, TLS and network controls.
- **Local only.** No hosted inference and no persistence: audio, transcripts and tokens are never logged or stored.

## Architecture

```
gateway ──WebSocket /v1/stream──▶ python -m voice_asr (asyncio, websockets 17.2)
                                     │  private pipes (fd-numbered), single command in flight
                                     ▼
                                  voice-asr-worker (C, public NeMo-Speech.cpp C ABI only)
                                     └─ one resident recognizer, warmed before readiness
```

- **Why a separate native process.** Source inspection of the pinned runtime found:
  - no cooperative cancel (`NEMO_SPEECH_ASR_ERROR_CANCELLED` is never produced on the ASR path);
  - no locking around `stream_close`/`destroy`, which are plain deletes;
  - no warmup call in the C ABI.

  So every native call runs on the worker's single thread. The parent bounds each call with a deadline. A hung call is ended by killing and **reaping this service's own worker** (never anything else), which is then restarted and rewarmed before readiness returns.
- **Why Python.** Python stdlib asyncio plus exactly one pinned dependency (`websockets`) keeps the sidecar self-contained. It writes no monorepo package locks, and the native side stays a ~300-line C program over the public ABI. It is not a custom ASR engine.
- **Isolation.**
  - The worker starts with stdin/stdout/stderr on `/dev/null`, so native logging can't reach IPC or logs. It gets a clean environment (no token) and uses `PR_SET_PDEATHSIG` (it dies if the parent dies).
  - IPC frames are bounded in both directions.

## Wire protocol (v1, frozen; see the canonical STREAMING_PROTOCOL agreed with the gateway owner)

### Transport

- `GET /v1/stream` WebSocket.
- If `VOICE_ASR_TOKEN`/`VOICE_ASR_TOKEN_FILE` is set, exactly one `Authorization: Bearer <token>` header is required. It is compared in constant time and checked **before upgrade**; failure gives HTTP 401. Any query string gives 400, so tokens never go in URLs.
- When more than `VOICE_ASR_MAX_CONNECTIONS` connections are open, the upgrade gets HTTP 503.
- No compression. Messages over 6404 bytes are refused by the transport (close 1009).

### Client → service

- **Start**, text, first message only: `{"type":"start","version":1,"sampleRate":16000,"channels":1,"format":"pcm_s16le"}`. Fields are exact: no extras, no duplicate keys, integers not booleans or floats.
- **Audio**, binary: a `uint32` little-endian sequence (starting at 0, strictly consecutive) followed by 1..3200 PCM16LE mono 16 kHz samples, so 6..6404 bytes with an even payload.
  - At most 6000 audio messages and **960,000 samples (60 s) total** per stream, counted by the service.
  - At most **16,000 unacknowledged samples** (queued + in flight) at any time. The window is pipelined, not stop-and-wait.
- **End**, text: `{"type":"end","sequence":<next expected sequence>,"totalSamples":<samples sent>}`. It must match the service's counters exactly. It is a barrier: every accepted frame is pushed first, then native `finish` runs exactly once.
- **Cancel**, text: `{"type":"cancel"}`.
- Control messages are capped at 1024 UTF-8 bytes. At most 8 control messages per stream, and only start/end/cancel in valid states.

### Service → client

- **Ready**: `{"type":"ready","version":1,"maxSamples":960000,"maxFrameSamples":3200,"windowSamples":16000}`. Sent only after the global lease is held and the native stream is open.
- **Ack**: `{"type":"ack","sequence":N}`. Cumulative. Sent only after the native `push` and the `next()` drain for every frame through N have returned. An ACK means ingested, not that the corresponding words are stable.
- **Final**: `{"type":"final","text":"..."}`.
  - Exactly one, after end → native `finish` → the explicit `is_final` result.
  - At most 32,000 JavaScript (UTF-16) characters, and at most 128,000 UTF-8 bytes. The worker enforces the same caps.
  - Interim text is never sent; partials are not part of v1. The socket then closes with code 1000.
- **Cancelled**: `{"type":"cancelled"}`. Sent only after native work is quiescent: the in-flight call returned and the stream was closed, or the worker was killed and reaped. Then close 1000.
- **Error**: `{"type":"error","code":CODE}`, then close. `CODE` is one of:

| code | when | close |
|---|---|---|
| `INVALID_MESSAGE` | bad JSON/fields, oversize control, wrong state (binary before start, audio after end, second start/end), too many controls | 1008 |
| `INVALID_SEQUENCE` | gap / duplicate / out-of-order audio, end counters mismatch | 1008 |
| `INVALID_AUDIO` | binary < 6 bytes, odd payload length, > 3200 samples | 1008 |
| `TOO_LONG` | > 960,000 samples, > 6000 audio messages, transcript over the caps | 1008 |
| `BACKPRESSURE` | the peer sends beyond 16,000 unacknowledged samples (a full window is not an error) | 1008 |
| `BUSY` | another stream holds the single native lease | 1013 |
| `UNAVAILABLE` | not ready (CPU/model/warmup/restart), worker failure, any internal error | 1013 |
| `TIMEOUT` | start, idle, recording, finalization, whole-session or native-call deadline | 1011 |

### Zero audio

`end` with `sequence:0,totalSamples:0` still calls native finish once. If native returns no explicit final for an empty stream, the service returns `{"type":"final","text":""}`. This **documented empty shortcut** applies only when the sample count is 0, and is logged as `empty_shortcut=true`. A nonzero stream without a native final returns `UNAVAILABLE`, never a fabricated final.

### Capacity

There is exactly one native stream globally, with no wait queue. The lease is held until native work is quiescent, even after an error message, a transport close or a cancel. A busy service therefore says `BUSY`/`UNAVAILABLE` rather than queueing.

## Deadlines (seconds; env name, default, allowed range)

| | env | default | range |
|---|---|---|---|
| first message after connect | `VOICE_ASR_START_TIMEOUT_S` | 5 | 1-30 |
| idle between valid inputs while recording | `VOICE_ASR_IDLE_TIMEOUT_S` | 5 | 1-30 |
| recording wall clock (ready → end) | `VOICE_ASR_RECORDING_TIMEOUT_S` | 75 | 60-120 |
| finalization (end → final) | `VOICE_ASR_FINAL_TIMEOUT_S` | 30 | 5-120 |
| any single native call (watchdog; the known benchmark stall was 3.247 s, with a 2.02 s single call) | `VOICE_ASR_NATIVE_CALL_TIMEOUT_S` | 10 | 5-60 |
| cancel grace: wait for an in-flight call before killing the worker | `VOICE_ASR_CANCEL_GRACE_S` | 2 | 0.1-10 |
| worker startup + warm | `VOICE_ASR_STARTUP_TIMEOUT_S` | 120 | 10-600 |
| graceful shutdown | `VOICE_ASR_SHUTDOWN_TIMEOUT_S` | 15 | 1-60 |

The whole stream lifetime is bounded by start + recording + finalization (110 s by default). Pings and extra controls do not extend it. Out-of-range values stop startup with a config error naming only the variable.

## Configuration

| env | meaning |
|---|---|
| `VOICE_ASR_MODEL_PATH` | **required**; read-only path of the pinned GGUF (see [MODEL_LICENSE.md](MODEL_LICENSE.md)) |
| `PORT` (8080), `VOICE_ASR_HOST` (0.0.0.0) | listen address |
| `VOICE_ASR_TOKEN` or `VOICE_ASR_TOKEN_FILE` | optional bearer token, 16-512 printable characters without spaces. An empty or unreadable token file fails closed (startup error). Without a token the service logs `auth_disabled private_network_only=true` |
| `VOICE_ASR_MAX_CONNECTIONS` (4, 1-32) | concurrent WebSocket connections (only one can hold the native lease) |
| `VOICE_ASR_OMP_THREAD_LIMIT` (unset, 1-8) | optional standard OpenMP thread cap for the worker. The C ABI itself always uses min(8, hardware threads) |
| `VOICE_ASR_WORKER_PATH` | worker binary; the image sets `/opt/voice-asr/bin/voice-asr-worker` |

### Probes

- `GET /healthz` returns 200 while the parent is alive.
- `GET /readyz` returns 200 only after the CPU check, the model size/SHA check, a live worker and a completed warmup. Warmup is a disposable native stream of 4 s generated silence that must produce an explicit final; its output is discarded.
- `/readyz` is 503 while restarting or rewarming. Busy capacity is not readiness.

## CPU and native build

- **Requirements.** x86-64 with SSE4.2, AVX, AVX2, FMA, F16C and BMI2 (for example the Threadripper 2970WX this was validated on). There is no AVX-512, VNNI, AMX or GPU path.
- **CPU gate.** The parent reads `/proc/cpuinfo` and refuses readiness (state `cpu_unsupported`) **before** starting the worker that loads the AVX2 library.
- **Build.** `native/build.sh` builds the pinned sources (`native/pins.env`) with `GGML_NATIVE=OFF` and explicit `GGML_SSE42/AVX/AVX2/FMA/F16C/BMI2=ON`. All AVX-512, VNNI and AMX options are OFF, as are CUDA, HIP, Vulkan, Metal, SYCL, OpenCL, RPC, BLAS and ZenDNN. Parallelism is capped at 4.
- **Build verification.** `native/check-isa.sh` scans the full disassembly of every shipped object and fails on any AVX-512 register (`zmm`, `k1-k7`) or GPU library dependency. A unit test proves it flags an AVX-512 object.
- **Image.** `container/Dockerfile` is a multi-stage build (native build on `debian:trixie-slim`, hash-locked pip install, runtime `python:3.14.8-slim-trixie`). The runtime has no compilers, runs as nonroot uid 10001 under `tini`, and has no model and no secrets.

```bash
docker build -f services/voice-asr/container/Dockerfile -t voice-asr .        # from the repository root
docker run --rm -p 127.0.0.1:8080:8080 -v /models:/models:ro \
  -e VOICE_ASR_MODEL_PATH=/models/nemotron-speech-streaming-en-0.6b.q8_0.gguf voice-asr
```

## Tests

```bash
cd services/voice-asr
PYTHONPATH=src:tests python -m unittest tests.test_units tests.test_contract   # no model needed (test-only fake worker)
VOICE_ASR_AUDIO_DIR=<public clips + manifest.json> VOICE_ASR_NATIVE_WORKER=<prefix>/bin/voice-asr-worker \
VOICE_ASR_NATIVE_MODEL=<pinned gguf> PYTHONPATH=src:tests python -m unittest tests.test_native    # real native
VOICE_ASR_AUDIO_DIR=... VOICE_ASR_TEST_URL=ws://127.0.0.1:<port>/v1/stream PYTHONPATH=src:tests python -m unittest tests.test_native.NativeStreams  # e.g. the container
```

- **Fake-worker suites.** `tests/fixtures/fake_worker.py` is a separate test-only process speaking the pipe protocol, with hang, crash, slow, oversized-text and never-ready modes. The service has no mock or fallback inference mode. These suites cover:
  - message validation, sequencing, the end barrier, ACKs and the credit window;
  - the 60 s and 6000-frame caps, transcript caps, zero audio, busy and readiness;
  - auth headers only and fail-closed token files;
  - CPU and model gates;
  - hung-call timeout with kill and reap, crash and restart, and cancel while idle, in flight and hung;
  - stale-text isolation, cleanup that can't release the lease early, shutdown during a hung warmup;
  - and log hygiene with token, header, audio and transcript sentinels.
- **Real-native suite.** It covers:
  - 9.9 s and 29.4 s public clips replayed on a real-time arrival schedule, with tail words checked;
  - silence, a short last frame, odd bytes, immediate end, cancel then reconnect;
  - a 960,000-sample boundary input fed as fast as credit allows (a labelled concatenation of public clips plus zero padding; **not** a release-latency measurement), and +1 sample;
  - the process lifecycle: SIGTERM reaps the worker, and parent SIGKILL takes the worker with it.

## Validation results (2026-10-18, this repository's worker host: Threadripper 2970WX, 7.75 GiB worker memory limit, shared CPU, no quota)

Two independent runs of `tests/test_native.py`: the in-process server with the portable native worker (`host`), and the packaged image `voice-asr-local:feature3-dev` (sha256:33d78be6…, 191 MB, uid 10001, no compilers) run with the model mounted read-only and a 3 GiB container memory cap (`image`). Both used the pinned model and the public LibriSpeech dev-clean clips (speaker 1272).

- Real-time rows: 320-sample (20 ms) frames on an absolute monotonic arrival schedule; the release reference is t0 + audio duration and is never reset; the pipelined credit window is respected; `end` is sent right after the last frame. Max send lateness ≤ 0.004 s, so no backlog.
- Fast rows: the credit-obeying feed is as fast as possible, so release latency is N/A.

| stream | host: scheduled last sample → final / end sent → final (s) | image: same (s) | word edits (host = image) |
|---|---|---|---|
| 9.9 s clip, real time | 0.203 / 0.202 | 0.217 / 0.216 | 0 / 24 ref, 24 hyp |
| 9.9 s clip, real time, repeat | 0.211 / 0.209 | 0.205 / 0.202 | 0 / 24 ref, 24 hyp |
| 29.4 s clip, real time | 0.197 / 0.195 | 0.207 / 0.205 | 7 / 68 ref, 67 hyp |
| 5.0 s clip, 3200-sample frames + 240-sample last frame | N/A (fast feed) / 0.128 | N/A (fast feed) / 0.473 | 0 / 12 ref, 12 hyp |
| 5.0 s clip right after a cancelled 29.4 s stream | N/A (fast feed) / 0.134 | N/A (fast feed) / 0.481 | 0 / 12 ref, 12 hyp |

Behaviour (identical on host and image):
- **Tails:** complete transcripts with tail words kept ("…rocky Ithaca", "…Turkish bath next man"). The 29.4 s edits include one "Mr." vs MISTER normalization.
- **Silence and immediate end:** 3 s silence gives `""` (native explicit final). Immediate end (sequence 0, 0 samples) gives `""`.
- **Errors:** odd-byte frame gives `INVALID_AUDIO`.
- **Cancel:** cancel mid-stream gives `cancelled`, and the next stream contains no words from the cancelled one.
- **60 s cap (policy test, not accuracy):** a labelled concatenation of the public clips 29.4 s + 18.29 s + 9.9 s plus 2.41 s of zero samples, exactly 960,000 samples. Fed credit-obeying as fast as possible; this is not a release-latency replay.
  - Result: final with 134 native words vs 135 concatenated reference words (68 + 43 + 24); 26.0 s wall in the image (25.0 s host).
  - 960,001 samples gives `TOO_LONG`.
- **Lifecycle (host process):** SIGTERM drains, reaps the worker and exits 0. SIGKILL of the parent kills the worker (`PR_SET_PDEATHSIG`). Image `docker stop` exited 0 in 0.64 s with no OOM.

Resources and timing:
- **Startup:** host startup → ready 3.435 s; image `/readyz` 200 after 4.2 s (SHA-256 check 0.5 s, worker start + warm 2.7 s).
- **Image usage:** container memory peak ≈ 950 MiB of 3 GiB, 13 PIDs. CPU ≈ 7.5 cores busy while feeding the 60 s input as fast as possible.
- **Earlier benchmark (same runtime):** process RSS ≈ 0.92 GiB with 10 OS threads at the default.
- **Log hygiene:** container logs contained no token, transcript or audio text.
- **Fake-worker suites:** `tests.test_units` + `tests.test_contract`: 34/34 OK.

## Limitations

- **Measured latency scope.** Latency is measured from the scheduled arrival of the last real sample to receipt of the final at a local WebSocket client on the same host. It **includes** the loopback WebSocket, the parent↔worker IPC and the service overhead. It **excludes** real browser capture/AudioWorklet, the Everything gateway and any external network. There is **no browser or last-phoneme SLO claim**.
- **Outlier.** The earlier benchmark of this runtime recorded one 3.247 s release tail outlier (a 2.02 s single native call, cause undetermined) among otherwise ~0.2 s tails. It can recur. The 10 s native-call watchdog is set above it.
- **Trailing quiet.** The public LibriSpeech clips end with short trailing quiet, which may let their last words settle before release. It does not guarantee that.
  - In the earlier benchmark's 3.247 s outlier, the last word ("Ithaca") was still missing at release and appeared only in the final.
  - v1 exposes no partials, so the service makes no claim about what was decoded before release.
  - Speech ending abruptly at release depends more on the native flush and is not validated here.
- **Narrow data.** English only; one LibriSpeech reader; no accents, noise, spontaneous speech, concurrency > 1 or audio over 60 s validated. Word-edit counts on 4 clips are not a WER claim.
- **Credit window.** Filling the 16,000-sample window is **not** an error. A compliant pipelined sender pauses enqueueing when its credit is used up and holds audio in its own bounded capture buffer.
  - The service answers `BACKPRESSURE` only if the peer **exceeds** 16,000 unacknowledged samples, or another stated bound.
  - On a shared host a long native stall can hold the window full long enough that the stream later fails with `TIMEOUT` (idle, recording, finalization or native-call deadline). This is the known risk behind the earlier 3.247 s spike, which can recur.
  - The service never buffers beyond the window and never drops audio.
- **Thread count.** Threads are the C ABI default min(8, hardware). The optional `OMP_THREAD_LIMIT` is a standard OpenMP cap, not ABI control. 8 compute threads plus 2 unattributed auxiliary threads were observed earlier.
- **Integration ownership.** Gateway, frontend, Helm and CI integration are owned by the voice integration owner and are not part of this component.
