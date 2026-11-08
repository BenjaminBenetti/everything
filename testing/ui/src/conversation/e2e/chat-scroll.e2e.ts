import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  liveGateway,
  type LiveGateway,
} from "../../voice/fixture/live-gateway.js";
import { voiceWorkspace } from "../../voice/fixture/voice-workspace.js";

/** Measurements and screenshots kept as evidence, outside Playwright's cleared output folder. */
const evidence = fileURLToPath(
  new URL(
    "../../../../../.local/ui-test-results/chat-scroll-evidence/",
    import.meta.url,
  ),
);

/** The composer field. */
const composer = (page: Page): Locator =>
  page.getByRole("textbox", { name: "Message Avery", exact: true });

/** The hold-to-record button. */
const micButton = (page: Page): Locator => page.locator(".voice-button");

/** The conversation's scrolling history. */
const historyView = (page: Page): Locator => page.locator(".chat-history");

/** A history message, as the conversation API returns it. */
interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: readonly never[];
}

/** Paragraphs for a message, so the seeded history is long and its replies wrap. */
function prose(index: number, sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, sentence) =>
      `Message ${index}, sentence ${sentence + 1}: the plan covers the onboarding flow, the dashboard, and the review schedule.`,
  ).join(" ");
}

/**
 * Twenty-four alternating messages ending with Avery's reply: a short one that fits above the
 * composer, or a tall one that is longer than the history's height.
 */
function seededHistory(latest: "short" | "tall"): ChatMessage[] {
  const messages: ChatMessage[] = Array.from({ length: 23 }, (_, index) => ({
    id: `m${String(index + 1).padStart(2, "0")}`,
    role: index % 2 ? "assistant" : "user",
    text: prose(index + 1, index % 2 ? 4 : 2),
    createdAt: new Date(Date.UTC(2026, 10, 8, 9, index)).toISOString(),
    attachments: [],
  }));
  messages.push({
    id: "m24",
    role: "assistant",
    text:
      latest === "short"
        ? "Here is the plan for Thursday:\n\n1. Review the onboarding sketches.\n2. Agree on the two-week scope.\n3. Decide what the dashboard needs.\n\nThe last line of the latest reply."
        : `${Array.from({ length: 60 }, (_, item) => `- Step ${item + 1} of the long checklist.`).join("\n")}\n\nThe last line of the latest reply.`,
    createdAt: new Date(Date.UTC(2026, 10, 8, 9, 30)).toISOString(),
    attachments: [],
  });
  return messages;
}

/** Where the history and the composer were after one change, read from the page's layout. */
interface Sample {
  readonly step: string;
  /** Pixels of history below its visible bottom edge; 0 when scrolled to the end. */
  readonly gap: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  /** The history's visible top and bottom edges in the window. */
  readonly historyTop: number;
  readonly historyBottom: number;
  readonly footerTop: number;
  /** The latest reply's top and bottom edges in the window. */
  readonly replyTop: number;
  readonly replyBottom: number;
  /** The watched message's top edge in the window, while one is watched. */
  readonly anchorTop: number | null;
  readonly fieldHeight: number;
  readonly fieldClientHeight: number;
  readonly fieldScrollHeight: number;
  readonly fieldScrollTop: number;
  readonly fieldLineHeight: number;
  readonly caret: number;
  readonly length: number;
  /** Scroll events the history received since the previous sample, with its size at each. */
  readonly scrolls: { top: number; height: number }[];
}

/** This test's samples, written as evidence after it ends. */
let samples: Sample[] = [];

/** What a dictation test's stand-in gateway observed, written as evidence after it ends. */
let gatewayRecord: LiveGateway | null = null;

test.beforeEach(() => {
  samples = [];
  gatewayRecord = null;
});

test.afterEach(async ({ page }, info) => {
  await mkdir(evidence, { recursive: true });
  const name = `${info.project.name}-${info.title
    .replace(/^(@\w+ )+/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .slice(0, 60)}`;
  await writeFile(
    path.join(evidence, `${name}.json`),
    `${JSON.stringify(
      {
        project: info.project.name,
        title: info.title,
        status: info.status,
        viewport: page.viewportSize(),
        samples,
        ...(gatewayRecord && {
          gateway: gatewayRecord,
          voiceStatus: await page
            .locator("#voice-status")
            .textContent()
            .catch(() => null),
          buttonEvents: await page
            .evaluate(
              () =>
                (window as unknown as { buttonEvents?: unknown[] })
                  .buttonEvents ?? null,
            )
            .catch(() => null),
        }),
      },
      null,
      2,
    )}\n`,
  );
});

/**
 * Open Avery's conversation over a seeded history with every API route mocked, record the history's
 * scroll events, and wait until it has settled at its end.
 */
async function open(
  page: Page,
  latest: "short" | "tall",
  { streaming = false }: { streaming?: boolean } = {},
) {
  await page.context().addInitScript(() => {
    const scrolls: { top: number; height: number }[] = [];
    document.addEventListener(
      "scroll",
      (event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.classList.contains("chat-history")
        )
          scrolls.push({ top: target.scrollTop, height: target.clientHeight });
      },
      { capture: true },
    );
    Object.assign(window, { chatScrolls: scrolls });
  });
  const gateway = streaming ? await liveGateway(page.context()) : null;
  const server = await voiceWorkspace(page.context(), { streaming });
  const messages = seededHistory(latest);
  // Registered after the workspace's routes, so it answers history reads first; sends fall through.
  await page
    .context()
    .route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { messages, nextCursor: null } })
        : route.fallback(),
    );
  await page.goto("/team/avery");
  await expect(composer(page)).toBeEnabled();
  await expect(page.locator(".chat-message")).toHaveCount(messages.length);
  await settle(page);
  return { server, gateway };
}

/** Wait two frames, so resize observers and scroll events from the last change have run. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Wait until the history's scroll position has held still for several frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const history = document.querySelector<HTMLElement>(".chat-history")!;
        let last = history.scrollTop;
        let still = 0;
        let count = 0;
        const tick = () => {
          const now = history.scrollTop;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 6 || ++count > 180) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** Measure the layout after the last change has been laid out and observed. */
async function record(
  page: Page,
  step: string,
  anchor?: string,
): Promise<Sample> {
  await frames(page);
  const sample = await page.evaluate(
    ({ step, anchor }) => {
      const history = document.querySelector<HTMLElement>(".chat-history")!;
      const footer = document.querySelector<HTMLElement>(".chat-footer")!;
      const field =
        document.querySelector<HTMLTextAreaElement>("#chat-message")!;
      const replies = history.querySelectorAll<HTMLElement>(".chat-message");
      const reply = replies[replies.length - 1]!.getBoundingClientRect();
      const view = history.getBoundingClientRect();
      const watched = anchor
        ? history.querySelector<HTMLElement>(`[data-message-id="${anchor}"]`)
        : null;
      const scrolls = (
        window as unknown as { chatScrolls: { top: number; height: number }[] }
      ).chatScrolls;
      const historyTop = view.top + history.clientTop;
      return {
        step,
        gap: history.scrollHeight - history.scrollTop - history.clientHeight,
        scrollTop: history.scrollTop,
        clientHeight: history.clientHeight,
        scrollHeight: history.scrollHeight,
        historyTop,
        historyBottom: historyTop + history.clientHeight,
        footerTop: footer.getBoundingClientRect().top,
        replyTop: reply.top,
        replyBottom: reply.bottom,
        anchorTop: watched ? watched.getBoundingClientRect().top : null,
        fieldHeight: field.getBoundingClientRect().height,
        fieldClientHeight: field.clientHeight,
        fieldScrollHeight: field.scrollHeight,
        fieldScrollTop: field.scrollTop,
        fieldLineHeight: Number.parseFloat(getComputedStyle(field).lineHeight),
        caret: field.selectionEnd,
        length: field.value.length,
        scrolls: scrolls.splice(0),
      };
    },
    { step, anchor },
  );
  samples.push(sample);
  return sample;
}

/** Following the latest reply: the history is at its end and the reply ends above the composer. */
function expectFollowing(
  sample: Sample,
  { fits = true }: { fits?: boolean } = {},
): void {
  expect
    .soft(sample.gap, `${sample.step}: pixels of history hidden below`)
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      sample.replyBottom,
      `${sample.step}: the latest reply ends above the history's bottom edge and the composer`,
    )
    .toBeLessThanOrEqual(
      Math.min(sample.historyBottom, sample.footerTop) + 0.5,
    );
  if (fits)
    expect
      .soft(sample.replyTop, `${sample.step}: the whole latest reply is shown`)
      .toBeGreaterThanOrEqual(sample.historyTop - 0.5);
}

/** Reading earlier messages: the history hasn't moved since the reader stopped scrolling. */
function expectReading(sample: Sample, reading: Sample): void {
  expect
    .soft(
      Math.abs(sample.scrollTop - reading.scrollTop),
      `${sample.step}: the reading position stays put`,
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      Math.abs(sample.anchorTop! - reading.anchorTop!),
      `${sample.step}: the message being read stays put`,
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      sample.gap,
      `${sample.step}: the history didn't jump to the latest reply`,
    )
    .toBeGreaterThan(80);
}

/**
 * The caret is at the end of the draft. After typing, the browser also scrolls a full field to the
 * caret's line, leaving less than a line of the draft below it; it doesn't for words a dictation
 * puts in the draft, so dictation checks only the caret.
 */
function expectCaretAtEnd(
  sample: Sample,
  { typed = true }: { typed?: boolean } = {},
): void {
  expect.soft(sample.caret, `${sample.step}: the caret`).toBe(sample.length);
  if (typed)
    expect
      .soft(
        sample.fieldScrollHeight -
          sample.fieldScrollTop -
          sample.fieldClientHeight,
        `${sample.step}: pixels of the draft below the field's visible bottom`,
      )
      .toBeLessThan(sample.fieldLineHeight);
}

/** Scroll the history as a person would: the mouse wheel on a desktop, a swipe on a phone. */
async function scrollHistory(
  page: Page,
  isMobile: boolean,
  deltaY: number,
): Promise<void> {
  const box = (await historyView(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (isMobile) {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.synthesizeScrollGesture", {
      x,
      y,
      // Positive distances scroll up.
      yDistance: -deltaY,
      gestureSourceType: "touch",
      speed: 4_000,
    });
    await session.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, deltaY);
  }
  await settle(page);
  // Scrolling doesn't move focus; if an emulated gesture did, typing carries on in the composer.
  await composer(page).evaluate((field: HTMLTextAreaElement) => {
    if (document.activeElement !== field) field.focus({ preventScroll: true });
  });
}

/** Scroll back to the end of the history, past where it stops. */
async function scrollToEnd(page: Page, isMobile: boolean): Promise<void> {
  const gap = await historyView(page).evaluate(
    (history) =>
      history.scrollHeight - history.scrollTop - history.clientHeight,
  );
  await scrollHistory(page, isMobile, gap + 200);
}

/** The first message whose top is inside the history's visible area. */
function firstVisibleMessage(page: Page): Promise<string> {
  return historyView(page).evaluate((history) => {
    const top = history.getBoundingClientRect().top;
    return [...history.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (message) => message.getBoundingClientRect().top >= top,
    )!.dataset.messageId!;
  });
}

/** Select the draft's last line, including the line break before it, and delete it. */
async function deleteLastLine(page: Page): Promise<void> {
  await composer(page).evaluate((field: HTMLTextAreaElement) =>
    field.setSelectionRange(field.value.lastIndexOf("\n"), field.value.length),
  );
  await page.keyboard.press("Backspace");
}

/** Hold Space in the composer for a while, sending the auto-repeats a held key produces. */
async function holdSpace(page: Page, durationMs: number): Promise<void> {
  await page.keyboard.down(" ");
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    await page.waitForTimeout(100);
    await page.keyboard.down(" ");
  }
}

/** Escape text for a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Spoken words for a dictation, revealed a few at a time as partial transcripts. */
const firstDictation =
  "we should move the planning review to thursday afternoon so the design team can join and bring the latest sketches for the onboarding flow then we can agree on the scope for the next two weeks and decide which parts of the dashboard need another pass before we share it with the wider group".split(
    " ",
  );
const secondDictation =
  "after that please draft a short summary of the decisions with owners and dates and send it to me so I can check it before it goes out to everyone on friday morning".split(
    " ",
  );

/** Send growing partial transcripts and check the layout after each one appears in the draft. */
async function dictate(
  page: Page,
  gateway: LiveGateway,
  words: readonly string[],
  check: (sample: Sample) => void,
  label: string,
  { anchor, from = 6 }: { anchor?: string; from?: number } = {},
): Promise<void> {
  for (let count = from; count <= words.length + 5; count += 6) {
    const text = words.slice(0, count).join(" ");
    gateway.partial(text);
    await expect(composer(page)).toHaveValue(new RegExp(`${literal(text)}$`));
    check(
      await record(
        page,
        `${label}: ${Math.min(count, words.length)} words`,
        anchor,
      ),
    );
  }
  // A revision that changes words without changing the draft's length or height.
  const revised = [
    ...words.slice(0, -1),
    "x".repeat(words.at(-1)!.length),
  ].join(" ");
  gateway.partial(revised);
  await expect(composer(page)).toHaveValue(new RegExp(`${literal(revised)}$`));
  check(await record(page, `${label}: same-length revision`, anchor));
}

// ===========================================
// Typing
// ===========================================

test("@desktop @phone a growing, shrinking, and pasted draft keeps the latest reply in view and leaves a reader where they are", async ({
  page,
  isMobile,
}) => {
  const { server } = await open(page, "short");
  const opened = await record(page, "opened");
  expect(opened.scrollHeight).toBeGreaterThan(opened.clientHeight * 2);
  expectFollowing(opened);

  if (isMobile) await composer(page).tap();
  else await composer(page).click();
  await page.keyboard.type("Line 1 of a long draft for Avery");
  expectFollowing(await record(page, "first line"));
  for (let line = 2; line <= 4; line++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`Line ${line} of a long draft for Avery`);
    expectFollowing(await record(page, `${line} lines`));
  }
  // Keystrokes that leave the field's height unchanged.
  for (const letter of "abc") {
    await page.keyboard.type(letter);
    const sample = await record(page, `4 lines, typed "${letter}"`);
    expectFollowing(sample);
    expectCaretAtEnd(sample);
  }
  // Past the field's maximum height, where the draft scrolls inside it.
  for (let line = 5; line <= 12; line++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`Line ${line} of a long draft for Avery`);
    expectFollowing(await record(page, `${line} lines`));
  }
  const capped = await record(page, "12 lines, at the maximum height");
  expect(capped.fieldScrollHeight).toBeGreaterThan(capped.fieldClientHeight);
  for (const letter of "defghi") {
    await page.keyboard.type(letter);
    const sample = await record(page, `12 lines, typed "${letter}"`);
    expectFollowing(sample);
    expectCaretAtEnd(sample);
  }
  await page.screenshot({
    path: path.join(
      evidence,
      `${test.info().project.name}-typed-following.png`,
    ),
    animations: "disabled",
  });
  // Deleting lines shrinks the field back below its maximum height.
  for (let line = 12; line > 3; line--) {
    await deleteLastLine(page);
    expectFollowing(await record(page, `deleted to ${line - 1} lines`));
  }
  // Pasted text arrives as one insertion.
  await page.keyboard.insertText(
    "\nPasted: the review moves to Thursday.\nPasted: the scope is two weeks.\nPasted: the dashboard needs one more pass.\nPasted: owners and dates follow.",
  );
  expectFollowing(await record(page, "pasted 4 lines"));

  // Reading earlier messages: changes to the draft leave the history where the reader put it.
  await scrollHistory(page, isMobile, -400);
  const anchor = await firstVisibleMessage(page);
  const reading = await record(page, "scrolled up to read", anchor);
  expect(reading.gap).toBeGreaterThan(80);
  await page.screenshot({
    path: path.join(evidence, `${test.info().project.name}-typed-reading.png`),
    animations: "disabled",
  });
  for (const letter of "jkl") {
    await page.keyboard.type(letter);
    expectReading(
      await record(page, `reading, typed "${letter}"`, anchor),
      reading,
    );
  }
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("A line added while reading");
  expectReading(await record(page, "reading, added a line", anchor), reading);
  await deleteLastLine(page);
  expectReading(await record(page, "reading, deleted a line", anchor), reading);

  // Back at the end, the history follows the latest reply again.
  await scrollToEnd(page, isMobile);
  expectFollowing(await record(page, "scrolled back to the end"));
  for (const letter of "mno") {
    await page.keyboard.type(letter);
    expectFollowing(await record(page, `back at the end, typed "${letter}"`));
  }

  // Sending clears the draft, and the field returns to its smallest height.
  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("");
  expect(server.sends).toHaveLength(1);
  expectFollowing(await record(page, "sent"));
});

test("@desktop @phone a reply taller than the history keeps its ending in view while the draft changes", async ({
  page,
  isMobile,
}) => {
  await open(page, "tall");
  const opened = await record(page, "opened");
  // The reply can't all fit: its start is above the history's top edge.
  expect(opened.replyTop).toBeLessThan(opened.historyTop);
  expectFollowing(opened, { fits: false });

  if (isMobile) await composer(page).tap();
  else await composer(page).click();
  await page.keyboard.type("Line 1 of a long draft for Avery");
  for (let line = 2; line <= 12; line++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`Line ${line} of a long draft for Avery`);
    expectFollowing(await record(page, `${line} lines`), { fits: false });
  }
  for (const letter of "abcdef") {
    await page.keyboard.type(letter);
    expectFollowing(await record(page, `12 lines, typed "${letter}"`), {
      fits: false,
    });
  }
  await page.screenshot({
    path: path.join(evidence, `${test.info().project.name}-tall-reply.png`),
    animations: "disabled",
  });
});

// ===========================================
// Dictation
// ===========================================

test("@desktop held-Space dictation keeps the latest reply in view, again when continued, and leaves a reader where they are", async ({
  page,
}) => {
  const { server, gateway } = await open(page, "short", { streaming: true });
  const live = gateway!;
  gatewayRecord = live;
  await composer(page).click();
  await page.keyboard.type("Notes for Avery:");
  for (let line = 2; line <= 3; line++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`Note ${line} before dictating`);
  }
  expectFollowing(await record(page, "typed 3 lines"));

  // Hold Space to dictate; words appear in the draft as the gateway revises them.
  await holdSpace(page, 1_300);
  await expect(micButton(page)).toHaveAttribute("data-state", "recording");
  await expect.poll(() => live.frames).toBeGreaterThan(5);
  await dictate(
    page,
    live,
    firstDictation,
    (sample) => {
      expectFollowing(sample);
      expectCaretAtEnd(sample, { typed: false });
    },
    "first dictation",
  );
  await page.keyboard.up(" ");
  await expect.poll(() => live.ends).toBe(1);
  live.final(`${firstDictation.join(" ")}.`);
  await expect(composer(page)).toHaveValue(
    new RegExp(`${literal(`${firstDictation.join(" ")}.`)}$`),
  );
  expectFollowing(await record(page, "first dictation added"));

  // Hold Space again to continue the draft.
  await holdSpace(page, 1_300);
  await expect(micButton(page)).toHaveAttribute("data-state", "recording");
  await expect.poll(() => live.starts.length).toBe(2);
  await dictate(
    page,
    live,
    secondDictation.slice(0, 18),
    (sample) => {
      expectFollowing(sample);
      expectCaretAtEnd(sample, { typed: false });
    },
    "continued dictation",
  );
  await page.screenshot({
    path: path.join(evidence, "desktop-dictation-following.png"),
    animations: "disabled",
  });

  // Scrolling up while still dictating: the words keep arriving and the history stays put.
  await scrollHistory(page, false, -400);
  const anchor = await firstVisibleMessage(page);
  const reading = await record(page, "scrolled up while dictating", anchor);
  expect(reading.gap).toBeGreaterThan(80);
  await dictate(
    page,
    live,
    secondDictation,
    (sample) => expectReading(sample, reading),
    "dictation while reading",
    { anchor, from: 24 },
  );

  // Back at the end before releasing, the history follows the words and the added transcript.
  await scrollToEnd(page, false);
  expectFollowing(
    await record(page, "scrolled back to the end while dictating"),
  );
  await page.keyboard.up(" ");
  await expect.poll(() => live.ends).toBe(2);
  live.final(`${secondDictation.join(" ")}.`);
  await expect(composer(page)).toHaveValue(
    new RegExp(`${literal(`${secondDictation.join(" ")}.`)}$`),
  );
  const added = await record(page, "continued dictation added");
  expectFollowing(added);
  expectCaretAtEnd(added, { typed: false });
  expect(server.sends).toEqual([]);
});

test("@phone held microphone dictation keeps the latest reply in view, again when continued, and leaves a reader where they are", async ({
  page,
}) => {
  // The microphone button's pointer events, kept with the evidence.
  await page.context().addInitScript(() => {
    const events: unknown[] = [];
    for (const type of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "contextmenu",
    ])
      document.addEventListener(
        type,
        (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".voice-button")
          )
            events.push({
              type,
              pointerType: (event as PointerEvent).pointerType,
              pointerId: (event as PointerEvent).pointerId,
              at: Math.round(event.timeStamp),
              trusted: event.isTrusted,
            });
        },
        { capture: true },
      );
    Object.assign(window, { buttonEvents: events });
  });
  const { server, gateway } = await open(page, "short", { streaming: true });
  const live = gateway!;
  gatewayRecord = live;
  const touch = await page.context().newCDPSession(page);
  await composer(page).tap();
  await page.keyboard.type("Notes for Avery:");
  expectFollowing(await record(page, "typed a line"));

  /** Touch and hold the microphone button with a finger, while audio flows as when speaking. */
  async function press(): Promise<void> {
    const box = (await micButton(page).boundingBox())!;
    const frames = live.frames;
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 },
      ],
    });
    await expect(micButton(page)).toHaveAttribute("data-state", "recording");
    await expect.poll(() => live.frames).toBeGreaterThan(frames + 5);
  }

  /** Lift the finger from the microphone button. */
  async function release(): Promise<void> {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }

  await press();
  await dictate(
    page,
    live,
    firstDictation,
    (sample) => {
      expectFollowing(sample);
      expectCaretAtEnd(sample, { typed: false });
    },
    "first dictation",
  );
  await release();
  await expect.poll(() => live.ends).toBe(1);
  live.final(`${firstDictation.join(" ")}.`);
  await expect(composer(page)).toHaveValue(
    new RegExp(`${literal(`${firstDictation.join(" ")}.`)}$`),
  );
  expectFollowing(await record(page, "first dictation added"));

  // Hold the button again to continue the draft.
  await press();
  await expect.poll(() => live.starts.length).toBe(2);
  await dictate(
    page,
    live,
    secondDictation.slice(0, 18),
    (sample) => {
      expectFollowing(sample);
      expectCaretAtEnd(sample, { typed: false });
    },
    "continued dictation",
  );
  await release();
  await expect.poll(() => live.ends).toBe(2);
  live.final(`${secondDictation.slice(0, 18).join(" ")}.`);
  await expect(composer(page)).toHaveValue(
    new RegExp(`${literal(`${secondDictation.slice(0, 18).join(" ")}.`)}$`),
  );
  expectFollowing(await record(page, "continued dictation added"));
  await page.screenshot({
    path: path.join(evidence, "phone-dictation-following.png"),
    animations: "disabled",
  });

  // Scrolled up to read before dictating again: the history stays put as the words arrive.
  await scrollHistory(page, true, -400);
  const anchor = await firstVisibleMessage(page);
  const reading = await record(page, "scrolled up to read", anchor);
  expect(reading.gap).toBeGreaterThan(80);
  await press();
  await expect.poll(() => live.starts.length).toBe(3);
  await dictate(
    page,
    live,
    secondDictation,
    (sample) => expectReading(sample, reading),
    "dictation while reading",
    { anchor },
  );
  await release();
  await expect.poll(() => live.ends).toBe(3);
  live.final(`${secondDictation.join(" ")}.`);
  await expect(composer(page)).toHaveValue(
    new RegExp(`${literal(`${secondDictation.join(" ")}.`)}$`),
  );
  expectReading(
    await record(page, "dictation added while reading", anchor),
    reading,
  );
  expect(server.sends).toEqual([]);
});
