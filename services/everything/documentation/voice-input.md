# Voice input

Voice input lets the owner dictate into a teammate's message composer. On a desktop, holding Space in the composer for 3 seconds starts recording. On any device, holding the microphone button records immediately. Releasing ends the recording, which is uploaded once; its final transcript goes into the draft where the caret or selection was when recording began. Nothing is sent to the teammate until the owner sends the message.

This release integrates a **generic self-hosted speech recognition service** and has been tested against a local stand-in only. No model has been chosen, no speech service is deployed by the chart, and voice input stays unavailable until an operator configures one. Transcription is final-only and batch: the browser uploads a finished recording on release. It is not streaming, and the time to a transcript is whatever the chosen model and hardware take for the whole recording.

## Configuration

Everything reads these variables; add them under `services.everything.env` in the chart's values. Nothing here is visible to browsers, and nothing a request contains can change where audio is sent.

| Variable                 | Default  | Meaning                                                                                                                                                                                                                                                                    |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOICE_ASR_URL`          | empty    | Complete transcription endpoint of the self-hosted service, for example `http://speech.<namespace>.svc.cluster.local:8000/v1/audio/transcriptions`. Empty leaves voice input unavailable. Credentials in the URL, fragments, and non-HTTP schemes are rejected at startup. |
| `VOICE_ASR_TOKEN`        | empty    | Bearer token sent to the service. Supply it from a Secret (`{ secretName, key }`), never a literal in values files.                                                                                                                                                        |
| `VOICE_ASR_MODEL`        | empty    | Model identifier sent as the `model` field; empty sends none.                                                                                                                                                                                                              |
| `VOICE_ASR_TIMEOUT_MS`   | `120000` | Deadline for one transcription by the service (1 s to 15 min). Set it from the chosen model's measured time for a 60-second recording on the target hardware.                                                                                                              |
| `VOICE_CONCURRENCY`      | `1`      | Transcriptions Everything runs at once across all owners.                                                                                                                                                                                                                  |
| `VOICE_QUEUE_LIMIT`      | `4`      | Further transcriptions that may wait for a slot.                                                                                                                                                                                                                           |
| `VOICE_QUEUE_TIMEOUT_MS` | `60000`  | Longest a transcription waits for a slot before it is refused.                                                                                                                                                                                                             |

At startup Everything checks that its decoder runs. If `VOICE_ASR_URL` is set but the decoder can't start, voice input is reported unavailable and a warning is logged. `GET /v1/voice/capabilities` tells the browser whether voice input is available and which limits apply; when it isn't, the composer shows no microphone.

### The speech service contract

Everything sends `POST {VOICE_ASR_URL}` as `multipart/form-data`, the request shape of OpenAI-compatible transcription servers:

- `file`: `recording.wav`, 16 kHz, mono, 16-bit PCM WAVE, at most 60 seconds.
- `model`: `VOICE_ASR_MODEL`, when set.
- `response_format`: `json`.

It expects `200` with a JSON body containing a string `text`, at most 32,000 characters; other fields are ignored. The request is never retried and redirects are refused. Any other answer, a body larger than about 256 KiB, or a missing `text` is reported to the caller as a failed transcription, without the service's response. The service must be self-hosted: Everything has no hosted or browser speech-recognition fallback.

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

Not yet verified:

- A real speech recognition model and runtime, and their latency, resource use, cancellation, and logging.
- Safari on iOS and macOS. WebKit-based tests ran in Playwright's Linux WebKit build, which has no `MediaRecorder`; they used a stand-in recorder that negotiates formats as Safari does. Real recording was tested in Chromium (WebM and MP4), and both decoded through the production decoder path.
- A deployed stack with an ingress configured for 8 MiB uploads.
