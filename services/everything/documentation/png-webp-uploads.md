# Newly uploaded PNGs

New static PNG uploads can become smaller WebP files at exactly the same width and height, using local `sharp@0.35.5` with unmodified `.webp()` defaults (quality 80, alphaQuality 100, effort 4, lossless false). This is standard lossy format conversion; RGB values can change. There is no resize, rotation, quality control or optimization UI. Provider-specific on-demand image resizing is unchanged.

Actual content controls eligibility, regardless of the browser MIME type or filename. Only a strictly smaller valid WebP with identical dimensions replaces the original. JPEG, WebP, GIF, text and binary files keep their exact bytes. APNG, EXIF-bearing or 16-bit PNGs, malformed/unsupported images, no-benefit encodes, busy/failed/timed-out conversions and inputs beyond decode/format bounds stay original. This preserves animation and orientation rather than silently flattening or rotating them.

The preflight checks the PNG signature, dimensions, chunk lengths and CRCs, at most 4,096 chunks, the existing 40-million-pixel bound and WebP's 16,383-pixel per-axis format limit. Files beyond that limit remain full-resolution PNGs. Compressed text stays original; an ICC profile is limited to one profile and at most 1 MiB inflated before native decoding. Uncompressed metadata is bounded by the 25 MiB input limit. Sharp also enforces the pixel bound and treats decode warnings as conversion failure.

One codec child runs at a time per storage adapter, with no waiting queue; concurrent contenders keep the original. It uses one native worker, no Sharp cache, a 64 MiB JavaScript heap and an 8-second codec timeout. The parent enforces a 10-second deadline covering startup/decode/encode, kills on deadline/abort/excessive output, and waits for process closure before releasing capacity. Byte/pixel/metadata limits bound input work; this is not a kernel limit on all native memory. No provider or image-cloud request is made. Normal optional Sharp packages cover the existing Linux amd64/arm64 glibc runtime images; x64 was executed here, arm64 packaging is lockfile evidence rather than an arm64 runtime test. See [Sharp installation requirements](https://sharp.pixelplumbing.com/install/).

## Accounting and publication

Reservations and limits always count original `inputSize`: 25 MiB/file, 100 MiB/batch, ten files. `received` and chunk offsets count original bytes even when the ready file is much smaller. The additive upload response field `inputSize` is optional in the shared client contract for older servers; older responses fall back to `size`. Ready `name`, `size`, `mediaType` and `path` describe the real stored file, including `.webp` / `image/webp`. The composer adopts those canonical values; history, headers and model path metadata use the same values. Reloaded previews read the stored WebP; an in-progress local preview uses the original file.

The new tracked migration only backfills accounting metadata (`input_size = size`, `encode_png = false`) and updates constraints. Newly created server reservations opt into conversion; pre-existing ready files and in-flight reservations keep their original format and bytes. No stored-file migration or old released migration is changed. Downgrading refuses unfinished prepared uploads whose input/stored sizes differ; finish or cancel them first.

Completed input, the candidate WebP and a one-file publication directory stay in the controller-private staging root. The service saves canonical metadata while the record is still uploading and unclaimable, then atomically renames the complete publication directory into the teammate's attachment namespace through no-follow parent descriptors. The source is copied through its opened no-follow descriptor; existing nonempty targets, files and links are refused. Only one permanent file remains. Raw/candidate/publication staging files are discarded after success, fallback, removal, failure or expiry.

An abort before canonical metadata preparation rewinds only the final input part for retry. After that commit point publication finishes even if the HTTP response closes; listing/retry sees ready. A process interruption after publication can complete from the persisted canonical path without another encode. A failed completion, cancellation or expiry removes the appropriate final path and private files. Existing owner, claim, expiry and no-follow checks remain effective. Tests cover concurrent final retries, abort/resume, queued cancellation, expiry during conversion, recovery and failed completion cleanup.

## Local verification and measured evidence

[Synthetic measurements and the manageable original/stored pair](assets/png-webp/README.md) show unchanged dimensions and exact alpha, with honest lossy-RGB qualifications. `png-webp-encoder.test.ts` runs the production codec. `png-webp-http.test.ts` runs real TCP HTTP controllers/services, production storage and codec, sending/history/download and the real `image_view` reading the stored WebP. Only authentication, in-memory records and the model are fixtures; initial model input contains paths and small metadata, without automatic pixels/base64.

```bash
pnpm --filter @everything/everything... --filter @everything/ui-service... build
pnpm --filter @everything/everything exec node --import tsx --test 'src/attachment/test/*.test.ts'
pnpm --filter @everything/ui-service exec tsx --test src/conversation/test/attachment-draft.test.ts
pnpm --filter @everything/everything check
pnpm --filter @everything/ui-service check
pnpm --filter @everything/ui-tests check
```

Repository unit/integration tests are separate from browser evidence. No launchable Chromium is available on the author worker; browser assertions and screenshots are pending a MAIN run. No browser repair or install is needed here.

## MAIN Chromium handoff

Run at the exact PR source head recorded in the PR/report, using MAIN's existing Chromium. Every attempt must have a new owned output directory. The gateway refuses existing fixture directories. There are two tests (desktop and phone), one worker and zero retries. The heap limit is 256 MiB. Defaults are ports 5188 and 18188; `ATTACHMENTS_E2E_UI_PORT` and `ATTACHMENTS_E2E_GATEWAY_PORT` can select isolated ports before starting.

```bash
pnpm --filter @everything/everything... --filter @everything/ui-service... build
png_webp_run=$(mktemp -d /tmp/everything-png-webp-main-XXXXXX)
ATTACHMENTS_E2E_ROOT="$png_webp_run" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE="/absolute/path/to/existing/main/chromium" \
NODE_OPTIONS=--max-old-space-size=256 \
pnpm --filter @everything/ui-tests test:png-webp
```

`--list` only discovers the two tests and does not constitute browser execution. The harness uses the real UI, real upload/content/send/history/session/runtime HTTP, local codec and workspace filesystem. Authentication, in-memory records, model and unrelated UI metadata routes are fixtures; external HTTP is blocked. The desktop uses the production file input. The phone uses a synthetic `ClipboardEvent` through the production paste handler, not the operating-system clipboard.

Assertions hold the final real upload request to verify original-byte progress and disabled sending, then continue the request without fabricated encoded responses. They check canonical ready fields, full reload, decoded thumbnail dimensions, actual stored/download bytes and headers, one permanent file/no private partials, send/history/reload and path-only model input. Outputs under `$png_webp_run` are:

- `fixtures/upload.png`: generated 1280 × 720 source.
- `workspace-volume/`: actual stored files and private staging directory.
- `evidence/desktop-ready.png`, `desktop-sent.png`, `phone-ready.png`, `phone-sent.png`: real UI screenshots.
- `evidence/desktop-png-webp.json`, `phone-png-webp.json`: byte/hash/progress/metadata and provenance assertions.
- `evidence/initial-model-input-*.txt`: synthetic model-input references, not a private execution log.
- `playwright/`: Playwright output. Preserve the native exit and reporter counts separately.

The original attachment browser evidence remains historical; it has not been recaptured for this feature. A subsequent same-author evidence task must inspect MAIN's new screenshots/hashes and report actual results before the whole feature is called complete. No merge, tag, release or deployment is authorized by this feature task.
