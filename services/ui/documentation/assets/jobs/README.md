# Teammate jobs screenshots

Unedited Playwright screenshots of the Jobs card, editor, and run history in the real `services/ui` page, on a desktop and an emulated phone. They come from CI's **Jobs browser harness** step, which runs `testing/ui/src/job/e2e/jobs.e2e.ts`. All data is synthetic: no real teammate, model, user content, or provider is involved.

| Image                   | Viewport                                                          | What it shows                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-1-jobs.png`    | 1440×960                                                          | The chat with the Jobs card: a weekday cron job in Europe/Paris with its next time, and a daily job whose last run failed                                                                       |
| `desktop-2-new-job.png` | 1440×960                                                          | The New job editor with a cron schedule (`0 9 * * 1-5`, Europe/Paris), each field's help text below it, and the server's preview of the next three weekday 9:00 AM runs                         |
| `desktop-3-running.png` | 1440×960                                                          | After the test skips the job clock 15 minutes, the real scheduler has dispatched the new interval job: its history shows the run **Running** and the card lists the job                         |
| `desktop-4-reply.png`   | 1440×960                                                          | The background run finished; its reply woke main, whose mocked model messaged the user in the chat                                                                                              |
| `desktop-5-history.png` | 1440×960                                                          | After Run now, Stop run, Pause, and Resume: a **Cancelled** run ("Stopped from the job before it finished.") above the **Completed** scheduled run, and the next time restarted from the resume |
| `phone-1-jobs.png`      | Chromium iPhone 13 emulation, 390×664 CSS px at DPR 3 (1170×1992) | The Jobs card behind the chat's Details button                                                                                                                                                  |
| `phone-2-history.png`   | iPhone 13 emulation                                               | A job's details on the phone: a failed run with its safe reason and a completed run                                                                                                             |
| `phone-3-editor.png`    | iPhone 13 emulation                                               | The editor on the phone with a cron schedule (`0 16 * * 5`) previewing three Friday 4:00 PM runs                                                                                                |

## What the test checked

Screenshots show moments; the assertions cover the flow. On the desktop:

- the seeded jobs are listed
- the editor's fields are named by their labels alone, and each help text is the field's accessible description
- the cron preview lists three 9:00 AM times; an invalid cron (`*/2 * * * *`) is refused with Create job disabled
- the interval preview's times are 15 minutes apart
- creating the job sends exactly the name, instructions, and `{"type":"interval","seconds":900}`
- skipping the job clock lets the real scheduler dispatch it: Running, then Completed
- main's mocked reply reaches the chat
- Run now then Stop run records Cancelled with the stop reason
- Pause and Resume update the status, and two runs are listed
- the background task's text and main's wakeup input are as expected, with no dispatcher failures
- Delete asks for confirmation, then removes the job

On the phone: the card behind Details, both runs of a job's history with the failure reason first, and the cron editor's preview of three 4:00 PM times, with nothing wider than the screen. Both tests ran with one worker and no retries. `browser-report-summary.json` is the CI checker's reading of the Playwright JSON report: 2 expected, 0 unexpected, 0 flaky, 0 skipped, 0 errors.

`jobs-evidence.json` is what the test read back from the gateway: the created job, its two runs, the background session's task text, the input that woke main, and the dispatcher's failure reports (none).

## What is real and what is synthetic

- **Real:** the production UI (Vite), Everything's HTTP application, and the job service, scheduler, and dispatcher, plus the conversation service, subagent service, and teammate session family. These are the shipped code, composed by `services/everything/src/job/test/job-gateway.ts`.
- **Synthetic:**
  - sign-in (a fixed test session)
  - records (in memory, applying the PostgreSQL repository's rules, **not PostgreSQL**)
  - the model (fixed replies after a short delay)
  - the job clock (real time, skipped forward by the test)
  - seeded jobs and two seeded past runs, and the chat page's unrelated routes (Playwright mocks)
- The phone images are Chromium's iPhone 13 emulation, not a physical device. The browser's locale is en-US and its timezone Europe/Paris.
- These images don't show live model inference, PostgreSQL, a deployed cluster, or production data, and they aren't security certification. PostgreSQL behavior is proven separately by CI's **Jobs PostgreSQL integration** step against a disposable database.

## Provenance

- **Screenshots and records:** taken from source `bb89cf59d4c0bac15993db0a631612524f21e0a2`, tree `d4368330136d391b73f40492d561174b9877219c`.
- **CI run:** 41954346460, attempt 1, `pull_request`, job "Build and test". GitHub tested merge commit `01840afea2d28934058a0aaab5c737dc2978be6a`, whose tree is identical to the source's.
- **Artifact:** `jobs-browser-proof-41954346460-1`, id 13382139074.
- **Documentation commit:** these files were added in a later, documentation-only commit. That commit's own CI reruns the same tests, but these pixels come from the source above, not from it.
- **Integrity:**
  - The PNGs are byte-identical to the artifact; no resizing or re-encoding.
  - `jobs-evidence.json` is byte-identical too.
  - `browser-report-summary.json` differs only by Prettier collapsing two one-item arrays: 717 → 685 bytes, and it parses identically.
  - `MANIFEST.json` records every hash, both before and after formatting, plus the raw report's.

## Earlier attempts

- **First browser run** (on source `f11730e`): failed in both viewports, because the editor's help text was inside each label. Fixed in `8d561a2`.
- **Two later local browser runs** (on `146ebc6`): lost their completion and are unknown. The browser harness was then moved into CI.
- **First CI run with the harness** (`ebeddae`, run 41952630261):
  - **Attempt 1** failed in an unrelated, already-shipped upload test (`png-webp-http.test.ts`), which reads a prompt file while it's being written. The jobs steps didn't run.
  - **Attempt 2** passed both browser tests, but its desktop editor screenshot showed the previous schedule's preview times under a new cron schedule, so those images weren't published.
- **The fix** (`bb89cf5`): the editor now shows a schedule's preview only for that schedule, and the test checks the preview's contents.
