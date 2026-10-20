# Thinking avatar screenshots

These are UI previews of the chat avatar's `thinking` pose. Each image is a real render of the `services/ui` React page and its CSS in a headless browser. The teammates, their messages and every API response are synthetic fixtures; no real teammate, model or user content is shown.

The images don't show a physical device, a deployed cluster or production data. They show how the page renders the runtime status it receives. The tests, not the images, check that the status is read correctly.

| Image | Viewport | State |
| --- | --- | --- |
| `thinking-avatar-desktop-background-only.png` | 1440×960, scale 1 | Two background teammates work and the main teammate is idle: the card shows "2 background" (mid fade-in) and the ordinary avatar |
| `thinking-avatar-desktop-thinking.png` | 1440×960, scale 1 | The main teammate and two background teammates work: the card's avatar shows the thought cloud beside "2 background" |
| `thinking-avatar-phone-background-only.png` | 390×664, scale 3, touch | Two background teammates only: the header shows "2 background" and the ordinary avatar |
| `thinking-avatar-phone-thinking.png` | 390×664, scale 3, touch | The main teammate and two background teammates work: the header avatar shows the thought cloud |
| `thinking-avatar-desktop-still.png` | 56×56 element, scale 1 | Reduced motion: the card avatar's still thinking pose |
| `thinking-avatar-phone-still.png` | 32×32 element, scale 3 | Reduced motion: the header avatar's still thinking pose |
| `thinking-avatar-motion-frames.png` | 56×56 element, scale 4, two frames | The card avatar paused at 25% and 75% of its 2.4 s cycle, one point in each of its steps: resting, and the cloud drifted up |

## How they were made

- **Source:** the UI at commit `9c6ff6e` (`services/ui` tree `e83e60d`), served by its Vite dev server on loopback. The two background-only images show only the ordinary avatar, which that commit doesn't change, and remain from commit `89aded6`.
- **Browser:** Chromium headless shell 156.0.8078.4, as installed for Playwright 1.64.0.
- **Fixture:** `testing/ui/src/conversation/fixture/teammate-activity.ts`, used by `testing/ui/src/conversation/test/main-activity.test.ts`.
  - Every `/v1` route is mocked, including the teammates Avery (fox, `avatar-03`) and Blake (owl, `avatar-26`) and two saved messages.
  - The test changes Avery's runtime status between idle, background-only (`status: "running"`, `mainRunning: false`, `backgroundCount: 2`), and main plus background (`mainRunning: true`).
- **Capture:** the six page and element images come from that test's `page.screenshot` and `locator.screenshot` calls, with animations running (motion allowed) or under emulated reduced motion (the still images). They are unedited.
- **Motion frames:** a separate script used the same mocked routes at scale 4 and paused every animation in the avatar at each fraction of its own cycle, after its per-teammate phase delay. The two unedited element screenshots were then placed side by side with labels.
