# Voice input screenshots

These are UI previews of the composer's voice control. Each image is a real render of the `services/ui` React page and its CSS in a headless browser. The conversation, the microphone and the transcription transport are synthetic fixtures.

The images don't measure speech recognition or latency. They don't show a physical device, a real microphone or production data.

No status line appears above the field. The microphone button shows each state:
- **Recording:** the button is highlighted.
- **Transcribing:** the button shows a spinner.
- **Failed dictation:** the button turns the danger colour, and its name and tooltip say what happened.

Screen readers still hear each change through a visually hidden live region.

| Image | Viewport | State |
| --- | --- | --- |
| `voice-input-desktop-recording.png` | 1440×1000, scale 1 | Space held for 3 s in the composer: the button shows recording, with the caret saved after "summarize" |
| `voice-input-desktop-inserted.png` | 1440×1000, scale 1 | After release: the transcript is inserted at the saved caret, nothing is sent, and the button is back at rest |
| `voice-input-mobile-recording.png` | 393×852, scale 2, touch | Microphone button held: the button shows recording |
| `voice-input-mobile-transcribing.png` | 393×852, scale 2, touch | After release: the button shows the transcribing spinner |

## How they were made

- **Source:** the UI at commit `a969309d6a09ef4694303559d4807f7a0fe3cf0a` (`services/ui` tree `e67699f7`), served by its Vite dev server on loopback.
- **Browser:** Chromium headless shell 156.0.8078.4, as installed for Playwright 1.64.0.
- **Fixture:** `testing/ui/src/voice/fixture/voice-workspace.ts`.
  - Every `/v1` route is mocked, including the teammate Avery and voice capabilities.
  - A fake microphone and MediaRecorder record no audio.
  - Transcriptions return fixed text: "the launch checklist" and "book the venue for Thursday".
  - These capabilities advertise only the upload lane. The streaming lane uses the same composer and button.
- **Interaction:** the steps follow the voice browser tests:
  - on desktop, holding Space for 3.3 s and then releasing;
  - on the phone, a touch `pointerdown`, then `pointerup` after 1.2 s.
- **Capture:** `page.screenshot` with animations disabled. The images are unedited.
- **Known side effect:** the desktop sidebar notice "Your teammate order couldn't load" appears because the fixture's catch-all mock answers 404 for that route.
