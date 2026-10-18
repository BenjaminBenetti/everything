# Voice input

Voice input lets the owner dictate into a teammate's message composer. On a desktop, holding Space in the composer for 3 seconds starts recording. On any device, holding the microphone button records immediately. Releasing ends the recording, and its final transcript goes into the draft where the caret or selection was when recording began. Nothing is sent to the teammate until the owner sends the message.

There are two lanes, both self-hosted:

- **Streaming** (`VOICE_STREAM_URL`): audio leaves the browser while the microphone is held, through Everything to the `services/voice-asr` speech service (NVIDIA's Nemotron Speech Streaming English 0.6B on the CPU). On release, the last audio is flushed, the stream ends, and the service's single final transcript is inserted. The composer prefers this lane when the browser supports audio worklets. **The chart deploys the speech service and connects Everything to it by default**; see [streaming lane](#streaming-lane).
- **Upload** (`VOICE_ASR_URL`): the browser records with MediaRecorder and uploads the finished recording once, to a generic OpenAI-compatible transcription endpoint. Nothing is processed while the button is held. It is off until an operator sets `VOICE_ASR_URL`; the chart deploys no service for it.

## Configuration

Everything reads these variables; add them under `services.everything.env` in the chart's values. Nothing here is visible to browsers, and nothing a request contains can change where audio is sent.

| Variable                 | Default  | Meaning                                                                                                                                                                                                                                                                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VOICE_ASR_URL`          | empty    | Complete transcription endpoint of the self-hosted service, for example `http://speech.<namespace>.svc.cluster.local:8000/v1/audio/transcriptions`. Empty leaves the upload lane unavailable; streaming is configured separately. Credentials in the URL, fragments, and non-HTTP schemes are rejected at startup. |
| `VOICE_ASR_TOKEN`        | empty    | Bearer token sent to the service. Supply it from a Secret (`{ secretName, key }`), never a literal in values files.                                                                                                                                                                                                |
| `VOICE_ASR_MODEL`        | empty    | Model identifier sent as the `model` field; empty sends none.                                                                                                                                                                                                                                                      |
| `VOICE_ASR_TIMEOUT_MS`   | `120000` | Deadline for one transcription by the service (1 s to 15 min). Set it from the chosen model's measured time for a 60-second recording on the target hardware.                                                                                                                                                      |
| `VOICE_CONCURRENCY`      | `1`      | Transcriptions Everything runs at once across all owners.                                                                                                                                                                                                                                                          |
| `VOICE_QUEUE_LIMIT`      | `4`      | Further transcriptions that may wait for a slot.                                                                                                                                                                                                                                                                   |
| `VOICE_QUEUE_TIMEOUT_MS` | `60000`  | Longest a transcription waits for a slot before it is refused.                                                                                                                                                                                                                                                     |

At startup Everything checks that its decoder runs. If `VOICE_ASR_URL` is set but the decoder can't start, the upload lane is reported unavailable and a warning is logged. `GET /v1/voice/capabilities` tells the browser whether voice input is available and which limits apply; when it isn't, the composer shows no microphone.

### The speech service contract

Everything sends `POST {VOICE_ASR_URL}` as `multipart/form-data`, the request shape of OpenAI-compatible transcription servers:

- `file`: `recording.wav`, 16 kHz, mono, 16-bit PCM WAVE, at most 60 seconds.
- `model`: `VOICE_ASR_MODEL`, when set.
- `response_format`: `json`.

It expects `200` with a JSON body containing a string `text`, at most 32,000 characters; other fields are ignored. The request is never retried and redirects are refused. Any other answer, a body larger than about 256 KiB, or a missing `text` is reported to the caller as a failed transcription, without the service's response. The service must be self-hosted: Everything has no hosted or browser speech-recognition fallback.

## Streaming lane

| Variable                        | Default | Meaning                                                                                                                                                                                                                          |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOICE_STREAM_URL`              | the chart's `voice-asr` Service | WebSocket URL of the streaming service's endpoint. The chart sets `ws://voice-asr.<namespace>.svc.cluster.local:8080/v1/stream` while `services.voice-asr` is enabled, and empty otherwise. Only `ws:` and `wss:`; credentials and fragments are rejected. Empty leaves streaming unavailable. |
| `VOICE_STREAM_TOKEN`            | unset                           | Bearer token sent to the service in the Authorization header, never the URL. Supply it from a Secret.                                                                                                                                                                                      |
| `VOICE_STREAM_FINAL_TIMEOUT_MS` | `30000`                         | Longest to wait for the final transcript after the stream ends (1 s to 5 min).                                                                                                                                                                                                             |
| `VOICE_STREAM_CONCURRENCY`      | `1`                             | Streams Everything runs at once across all owners; `services/voice-asr` allows one native stream.                                                                                                                                                                                          |

**The chart's speech service.** `services.voice-asr` in `deployment/helm/values.yaml` is enabled by default and needs no operator step:

- **One private pod.** One replica of the `everything-voice-asr` image, built with the other images and released for amd64 only, because its native worker targets x86-64 with AVX2. The pod is scheduled on an amd64 node, runs as a non-root user with a read-only root filesystem and no capabilities, and has no Kubernetes API token. Its Service is ClusterIP only, and no Ingress routes to it. It asks for 1 CPU and 1 GiB and may use 4 CPUs and 3 GiB; about 1 GiB is in use while it recognizes. These are sizing defaults, not a service-level objective.
- **Model provisioning.** An init container from the same image (`python -m voice_asr.provision`) fills the `voice-asr-models` volume, a 2 GiB claim kept when the release is uninstalled, before the service starts:
  - the first time, it downloads the one pinned model, `nvidia/nemotron-speech-streaming-en-0.6b` at revision `ebe59e5a817142986528bbbee5dba8db7b38ed50`, `nemotron-speech-streaming-en-0.6b.q8_0.gguf` (699,872,960 bytes);
  - the download runs over HTTPS only, with a byte cap, a per-read timeout, and a 30-minute deadline;
  - it installs the file read-only and atomically only once its SHA-256 matches `d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d`;
  - at every later start, it checks the cached copy and replaces it if it doesn't match.

  The service mounts the volume read-only and checks the model again before warming up. The model is licensed under the NVIDIA Open Model License (`services/voice-asr/MODEL_LICENSE.md`); the chart's `VOICE_ASR_MODEL_LICENSE` setting accepts it, and a `NOTICE` file beside the model records it. The cluster's nodes need outbound HTTPS to `huggingface.co` and its download servers the first time.
- **Readiness.** The pod is ready once the model check, the native worker's start, and a warmup stream pass (`/readyz`). Until then the Service has no endpoint, and streams fail as unavailable.
- **Automatic connection.** Everything's `VOICE_STREAM_URL` is rendered from the Service, so no endpoint needs configuring.

**Authentication.** By default nothing is configured: the speech service runs without a token and is reachable only through its ClusterIP Service, from pods in the cluster. Leave `VOICE_ASR_TOKEN` and `VOICE_ASR_TOKEN_FILE` **unset** when the service runs without a token; a blank value is a configuration error there. To require one, add a Secret under `secrets` in your credentials file and reference it on both sides:

```yaml
secrets:
  voice-asr-auth:
    token: <16 to 512 printable characters, no spaces>
services:
  everything:
    env:
      VOICE_STREAM_TOKEN: { secretName: voice-asr-auth, key: token }
  voice-asr:
    env:
      VOICE_ASR_TOKEN: { secretName: voice-asr-auth, key: token }
```

**Turning it off or replacing it.**
- Set `services.voice-asr.enabled: false` to run without the speech service. The chart then removes its pod and Service, keeps its model claim, and sets `VOICE_STREAM_URL` empty, which turns streaming off.
- Set `services.everything.env.VOICE_STREAM_URL` to use another speech service instead. Each variable is a single map entry, so an override replaces the chart's value rather than adding a second one.
- Clusters without amd64 nodes can't schedule the pod; turn it off there.

The speech service's own settings, deadlines, and licence are in `services/voice-asr/README.md`.

**Route.** The browser opens `GET /v1/agents/{agentId}/voice/stream` as a WebSocket on the application's origin. Before the connection is upgraded:

1. the browser session or bearer token is verified;
2. cookie sessions must come from the application's exact origin, since upgrades are GET requests the mutation check doesn't cover;
3. the teammate must belong to the owner (missing and foreign teammates are the same 404);
4. the owner's single recording place, shared with uploads, and a stream slot are taken (429 when the owner already records, 503 when every slot is taken or streaming is unconfigured).

Every refusal is plain HTTP, and only this route can upgrade; an upgrade aimed at any other route is refused with 404 and its connection is closed. The route is not part of the generated API definition, which can't describe a WebSocket.

**Protocol.** Version 1 is shared verbatim with the speech service and defined in `@everything/conversation-contracts/voice-stream`:

- JSON `start`;
- binary audio messages, each a uint32 little-endian sequence then 1 to 3,200 samples of 16 kHz mono PCM16LE;
- a JSON `end` carrying the next sequence and the total samples;
- `cancel` at any point.

The service answers `ready`, cumulative `ack`s, and exactly one `final`, or `cancelled` or an allowlisted `error`. Everything relays both directions and validates each:

- consecutive sequences, frame sizes, at most 960,000 samples (60 seconds) and 6,000 messages;
- at most 16,000 unacknowledged samples, the end barrier, and a final of at most 32,000 characters;
- service limits are never allowed above the product's;
- service messages are bounded on the wire (`maxPayload`, compression off, redirects refused) as well as when parsed.

**Deadlines.** Start 5 s, idle 5 s while recording, final as configured, cleanup after a cancel 10 s, and a bound on the whole stream.

**Browser.** Capture uses an `AudioContext` asked to run at 16 kHz, verified rather than assumed. The browser resamples and mixes down; the worklet only converts to PCM16 and cuts 20 ms frames. Its port, the pending queue (at most 4 s), the acknowledgement window, and the WebSocket buffer are all bounded, and overflowing any of them fails the whole recording rather than dropping audio. On release, the worklet's last short frame is flushed before `end`, and one client deadline covers draining and the final. Browsers without audio worklets fall back to the upload lane when it is configured, and otherwise say voice input isn't supported.

**Ingress.** The ingress must pass WebSocket upgrades on `/v1/agents/*/voice/stream` and keep them open for a whole stream: about 60 s of recording plus the final deadline. Everything's development server proxies them too.

## Limits and admission

| Limit                              | Value                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| Encoded upload                     | 8 MiB, on this route only; the API's 64 KiB limit applies everywhere else             |
| Decoded audio                      | 60 seconds, counted from decoded frames; longer recordings are refused, not shortened |
| Formats                            | `audio/webm` (Opus, Vorbis), `audio/ogg` (Opus, Vorbis), `audio/mp4` (AAC, Opus)      |
| Recordings per owner               | One uploading, waiting, or transcribing at a time (429)                               |
| Recordings in progress, all owners | `VOICE_CONCURRENCY + VOICE_QUEUE_LIMIT` (503 beyond that)                             |

The owner's place is reserved after authentication and **before the upload is read**, so a second upload by the same owner, or one beyond the total, is refused without being buffered. The reservation ends with the response, including when the caller disconnects. At most `VOICE_CONCURRENCY + VOICE_QUEUE_LIMIT` uploads of up to 8 MiB are held in memory at once.

Before anything is decoded, the route checks that the declared container matches the bytes' signature and that the teammate belongs to the owner; missing and foreign teammates return the same 404. Recordings whose decoded audio is silent return an empty transcript without reaching the service.

The composer asks browsers to record at 32 kbps, about 250 KB a minute, though browsers may choose another rate. The ingress in front of Everything must accept request bodies of at least 8 MiB on `/v1/agents/*/voice/transcriptions`; ingress-nginx, for example, defaults to 1 MiB. Its response timeout must cover `VOICE_QUEUE_TIMEOUT_MS + 15 s + VOICE_ASR_TIMEOUT_MS`, which capabilities report as `responseTimeoutMs`. Everything's own 15-second request timeout limits how long the upload itself may take.

## Decoding

Recordings are decoded by FFmpeg from the Everything image's Debian packages (`ffmpeg`, with `prlimit` from `util-linux`), in a separate process for each recording:

- Input is only the uploaded bytes on stdin. The demuxer is forced from the validated content type (`matroska`, `ogg`, or `mov`), only the `pipe` protocol is allowed, and decoders are allowlisted per container. Playlists, network URLs, and references to other files are never opened.
- `prlimit` caps the process at 30 CPU seconds and 1 GiB of address space, forbids writing files (`RLIMIT_FSIZE=0`), and disables core dumps. FFmpeg's codec and filter threads are limited to one, and single allocations to 128 MiB. A 15-second timer kills it. The process receives only `PATH` from Everything's environment.
- Output is 16 kHz mono PCM on stdout. The bytes are counted as they arrive, and the process is killed as soon as they pass 60 seconds of audio. Stderr is discarded unread, so diagnostics about a recording are never logged.
- When the request is cancelled, or Everything shuts down, the process is killed.

These budgets are defaults sized for one short recording and have not been measured on target hardware.

MP4 recordings whose movie box (`moov`) comes after the media data can't be decoded from a pipe. Everything reorders such files in memory before decoding, as `-movflags +faststart` would, shifting the sample-table chunk offsets. The reordering follows only the fixed `moov → trak → mdia → minf → stbl` path, so nesting is at most five levels, and it reads at most 65,536 boxes; anything malformed is rejected as an unreadable recording. Fragmented MP4 and files that already lead with `moov` are passed through unchanged. This is a deliberate tradeoff: Debian bookworm's FFmpeg 5.1 has no `fd` protocol and treats `pipe:` as unseekable even when it is a regular file, so the alternatives were writing recordings to temporary files or allowing the `file` protocol, and both were rejected.

## Privacy

Recordings and transcripts are not stored or logged by Everything. The upload is held in memory for its request, decoded PCM and the WAVE file only for the upload to the speech service, and nothing is written to disk. Request logs record the method, path, and client address, never bodies. The browser keeps the recording in memory until the upload ends and the transcript only in the draft, never in browser storage. The speech service receives the WAVE file and must be configured not to log or keep audio or transcripts; that is the operator's responsibility.

## Cancellation and what is not yet verified

When the browser cancels (Escape, sending the draft, leaving the composer, page, or teammate), it aborts its request. Everything then aborts its request to the speech service and drops any late answer. That stops Everything's own work and frees the transcription slot. It does **not** prove the speech service stops computing: a service may keep processing a recording after its request is closed. `VOICE_CONCURRENCY` therefore bounds the requests Everything has open, not necessarily the service's work. The integration with a chosen model must verify or bound that, for example by serializing work in the service.

The streaming lane follows the same rule. On cancel, Escape, sending, leaving the composer, page, or teammate, or a browser disconnect, Everything sends `cancel`. It holds the owner's place until the service confirms `cancelled` or the 10 s cleanup deadline passes, and drops any late output. The speech service, not Everything, decides when its native work has stopped; `services/voice-asr` keeps its single native stream until then and answers `BUSY` meanwhile.

Verified for the streaming lane against `services/voice-asr` (CPU, a public LibriSpeech 9.9 s and 29.4 s clip played into a synthetic microphone stream, in Chromium and Playwright's WebKit):

- the browsers' own audio worklets captured audio, and the native service acknowledged it while the button was held;
- release to insertion of the final took about 0.19 to 0.35 s;
- the Space gesture, cancelling mid-stream followed by a new stream with no earlier words, a release with no speech, a release mid-sentence (short last frame), and the 60 s limit all behaved as described.

These are runs on a shared host over a real local test network, not a production WAN or mobile network, and not service-level objectives. The clips end in natural quiet, so they don't measure last-phoneme latency.

Verified for the default deployment on 2026-10-18 (`pnpm cluster:up`, the chart's default values, a local one-node amd64 Minikube):

- **Provisioning.** The init container downloaded the pinned model into `voice-asr-models` and installed it read-only with its NOTICE. The restarted pod checked and reused it (SHA-256 in 6.9 s).
- **Readiness.** The service was ready about 6 s after starting and used about 950 MiB. It could write neither its model volume nor its root filesystem.
- **Connection.** Everything's `VOICE_STREAM_URL` pointed at the Service without configuration.
- **A full stream.** A client signed in through the ingress streamed a public-domain 11 s clip (`tests/jfk.flac` from openai/whisper) in real time to a new teammate:
  - every frame was acknowledged while streaming;
  - the final arrived 0.25 s after `end` and matched the reference text;
  - neither service logged the transcript.

Not yet verified:

- The upload lane against a real speech recognition model and runtime, and their latency, resource use, cancellation, and logging.
- Safari on iOS and macOS. Playwright's Linux WebKit build has audio worklets, which the streaming tests used for real, but no `MediaRecorder`; upload-lane tests there used a stand-in recorder that negotiates formats as Safari does. Real upload recording was tested in Chromium (WebM and MP4), and both decoded through the production decoder path.
- Streaming against a physical microphone, real network conditions, or GPU or other hardware.
- A remote cluster: a production ingress (WebSocket upgrades held for a whole stream, 8 MiB uploads), arm64 or mixed-architecture nodes, outbound download through a proxy, and storage classes other than Minikube's host path.
