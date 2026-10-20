# Watching avatar screenshots

These are UI previews of the chat avatar's `watching` pose and its monitor count. Each image is a real render of the `services/ui` React page and its CSS in a headless browser. The teammates, their messages and every API response are synthetic fixtures. No real teammate, monitor command, output or user content is shown, because the page shows only a count.

The images don't show a physical device, a deployed cluster or production data. They show how the page renders the runtime status it receives. The tests, not the images, check that the status and the count are read correctly.

| Image | Viewport | State |
| --- | --- | --- |
| `watching-avatar-desktop-count.png` | 1440×960, scale 1 | The main teammate is idle with one monitor running; the pointer rests on the card's avatar, which shows "1 monitor running" |
| `watching-avatar-phone-count.png` | 390×664, scale 3, touch | The same state; a tap on the header avatar shows "1 monitor running" |
| `watching-avatar-desktop-still.png` | 56×56 element, scale 1 | Reduced motion with two monitors running: the card avatar's still watching pose |
| `watching-avatar-phone-still.png` | 32×32 element, scale 3 | Reduced motion: the header avatar's still watching pose |
| `watching-avatar-motion-frames.png` | 56×56 element, scale 4, four frames | The card avatar paused at 10%, 35%, 60% and 85% of its 3.2 s cycle, one point in each of its steps: resting, then scanning left, down and right |
| `avatar-states-desktop.png` | 56×56 elements, scale 4, three frames | The card avatar for the same teammate when idle, thinking (main session working, with monitors running) and watching (monitors only) |

## How they were made

- **Source:** the UI at commit `c5271c7` (`services/ui` tree `ed0a8c0`), served by its Vite dev server on loopback.
- **Browser:** Chromium headless shell 156.0.8078.4, as installed for Playwright 1.64.0.
- **Fixture:** `testing/ui/src/conversation/fixture/teammate-activity.ts`, used by `testing/ui/src/conversation/test/monitor-watching.test.ts`.
  - Every `/v1` route is mocked, including the teammates Avery (fox, `avatar-03`) and Blake (owl, `avatar-26`) and two saved messages.
  - The tests set Avery's runtime status. Idle with monitors is `mainRunning: false` and `monitorCount: 1`, 2 or 3. Thinking is `mainRunning: true`.
- **Capture:** the four page and element images come from that test's `page.screenshot` and `locator.screenshot` calls, with motion allowed or under emulated reduced motion (the still images). They are unedited.
- **Frames:** a separate script used the same mocked routes at scale 4 and paused every animation in the avatar at each fraction of its own cycle, after its per-teammate phase delay. The state comparison was captured the same way, with motion paused at the start of each cycle. The unedited element screenshots were then placed side by side with labels.
