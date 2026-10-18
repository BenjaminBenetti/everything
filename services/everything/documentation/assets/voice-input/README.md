# Voice input screenshots

These are UI previews of the composer's voice control. Each image is a real render of the `services/ui` React page and its CSS in a headless browser. The conversation, the microphone and the transcription transport are synthetic fixtures.

The images don't measure speech recognition or latency. They don't show a physical device, a real microphone or production data.

| Image | Viewport | State |
| --- | --- | --- |
| `voice-input-desktop-recording.png` | 1440×1000, scale 1 | Space held for 3 s in the composer: recording, with the caret saved after "summarize" |
| `voice-input-desktop-inserted.png` | 1440×1000, scale 1 | After release: the transcript is inserted at the saved caret and nothing is sent |
| `voice-input-mobile-recording.png` | 393×852, scale 2, touch | Microphone button held: recording |
| `voice-input-mobile-transcribing.png` | 393×852, scale 2, touch | After release: transcribing |

## How they were made

- **Source:** the UI at commit `0b1cc134322709ed36e35b68675fbdd286ec0a5d` (`services/ui` tree `66ae5ade`), served by its Vite dev server on loopback.
- **Browser:** Chromium headless shell 156.0.8078.4, as installed for Playwright 1.64.0.
- **Fixture:** `testing/ui/src/voice/fixture/voice-workspace.ts`.
  - Every `/v1` route is mocked, including the teammate Avery and voice capabilities.
  - A fake microphone and MediaRecorder record no audio.
  - Transcriptions return fixed text: "the launch checklist" and "book the venue for Thursday".
  - These capabilities advertise only the upload lane. The streaming lane uses the same composer, button and status messages.
- **Interaction:** the steps follow the voice browser tests:
  - on desktop, holding Space for 3.3 s and then releasing;
  - on the phone, a touch `pointerdown`, then `pointerup` after 1.2 s.
- **Capture:** `page.screenshot` with animations disabled. The images are unedited.
- **Known side effect:** the desktop sidebar notice "Your teammate order couldn't load" appears because the fixture's catch-all mock answers 404 for that route.
