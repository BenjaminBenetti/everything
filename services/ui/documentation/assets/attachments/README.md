# Attachment screenshots

These show the chat composer attaching, uploading, and sending files, and the sent files in the conversation, on a desktop and an emulated phone. Each image is an unedited Playwright screenshot of the real `services/ui` page in Chromium, captured by `testing/ui/src/conversation/e2e/attachments.e2e.ts`. All files are synthetic; no real teammate, model, or user content is shown.

| Image                        | Viewport                                       | State                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop-1-uploading.png`    | 1440×960                                       | Four files (PNG, CSV, 5 MB binary, empty text) uploading: image preview, file chips, progress bars, "Uploading files. You can send when they finish.", and Send disabled                         |
| `desktop-2-ready.png`        | 1440×960                                       | All four ready to send with their sizes, a draft message, and Send enabled                                                                                                                       |
| `desktop-3-sent.png`         | 1440×960                                       | The sent message, scrolled to its end: the image, file chips with kind, size, workspace path, and download, and the mocked teammate reply listing the four server-chosen paths; composer cleared |
| `desktop-4-after-reload.png` | 1440×960                                       | The same conversation after a page reload, read back from the server                                                                                                                             |
| `phone-1-uploading.png`      | iPhone 13 emulation, 390×664 at scale 3, touch | Two files uploading in the phone composer, with Send disabled; above, the message the desktop drag-and-drop test sent earlier to the same gateway                                                |
| `phone-2-ready.png`          | iPhone 13 emulation                            | Both files ready, with a draft message                                                                                                                                                           |
| `phone-3-sent.png`           | iPhone 13 emulation                            | The sent message with its image and file chip, and the mocked reply listing both paths; the test also checks that nothing overflows the phone's width                                            |

`delivery.json` holds what the test read from the gateway: the teammate's initial model input for the desktop message, and each stored file's workspace path, size, and SHA-256. The four hashes match the synthetic files the test uploaded. The model input lists paths, names, types, and sizes only, with no file contents or base64.

## What is real and what is mocked

- **Real:** the UI, uploading in parts, storage on a temporary workspace volume, sending, history, Everything's conversation service, and the builder of the teammate's model input. These run the shipped code through Everything's production HTTP application (`services/everything/src/attachment/test/e2e-gateway.ts`).
- **Mocked:** sign-in (a fixed test session), records (in memory instead of PostgreSQL), the model (it records its input and returns a fixed "(Mocked model reply.)" message), and the chat page's unrelated endpoints (Playwright routes).
- Each uploaded part was delayed 700–900 ms so progress is visible. The uploading screenshots were taken as uploads began, so the bars are still near empty.
- The phone images are Chromium's iPhone 13 emulation, not a physical device.
- The images don't show live model inference, a teammate pod restart, a deployed cluster, or production data, and they are not evidence of security isolation; the unit and integration tests cover authorization and path safety.

## How they were made

- **Source:** commit `66496e7f018a7868a9d14a4ae2b97690ac3f5aa2`, checked out unchanged.
- **Run:** `pnpm --filter @everything/ui-tests test:attachments-e2e` with the main pod's Chromium. All three tests passed (3 expected, 0 unexpected, 0 flaky, 0 skipped) in 43.4 s, and the browser process exited 0.
- **Attempts:** the build worker that wrote the harness has no launchable Chromium, so its run failed at browser launch. The first run in the main pod was interrupted by a workspace restart after printing "Running 3 tests", with no assertions, screenshots, or exit status; its cause is unknown. One retry, with the same three tests, one worker, and a fresh gateway, set `NODE_OPTIONS=--max-old-space-size=256` for that process only and produced these images. No source changed between attempts.
- **Integrity:** `MAIN-EVIDENCE-MANIFEST.json` is the run's manifest, copied unchanged; its SHA-256 values match the PNGs here. `delivery.json` is the run's file with a trailing newline added for formatting: SHA-256 `117e8890ac44795dba98a731508201e2783b8c855556fd50380e35d3a22aea43` as captured, `6e0cb644e588e9d776a52c01f9687e400908fa5d86ae4d8bf019a398545e52bc` as committed.
