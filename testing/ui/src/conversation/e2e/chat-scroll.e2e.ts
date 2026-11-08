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

/** Where the field showed the draft after one change, read from the page's layout. */
interface DraftSample {
  readonly step: string;
  readonly length: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly fieldScrollTop: number;
  readonly fieldClientHeight: number;
  readonly fieldScrollHeight: number;
  readonly lineHeight: number;
  /** The caret's line in the field's scrolled contents, and how many of its pixels the field shows. */
  readonly caretTop: number;
  readonly caretBottom: number;
  readonly caretShown: number;
  /** The newest dictated word, where it starts, and the same for its line, when one is watched. */
  readonly newest: string | null;
  readonly newestAt: number | null;
  readonly newestTop: number | null;
  readonly newestShown: number | null;
  /** The height of the draft as the measuring copy lays it out, which must match the field's. */
  readonly copyHeight: number;
  /** How far the page itself is scrolled. */
  readonly pageScroll: number;
}

/** This test's samples, written as evidence after it ends. */
let samples: Sample[] = [];
let drafts: DraftSample[] = [];

/** What a dictation test's stand-in gateway observed, written as evidence after it ends. */
let gatewayRecord: LiveGateway | null = null;

test.beforeEach(() => {
  samples = [];
  drafts = [];
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
        ...(drafts.length && { drafts }),
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

/**
 * Scroll the history with the mouse wheel over it, as a reader does. The phone uses the wheel too:
 * Chromium's synthetic touch scroll gesture left the history unmoved in CI, and the history
 * responds to any scroll the same way.
 */
async function scrollHistory(page: Page, deltaY: number): Promise<void> {
  const box = (await historyView(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
  await settle(page);
}

/** Scroll back to the end of the history, past where it stops. */
async function scrollToEnd(page: Page): Promise<void> {
  const gap = await historyView(page).evaluate(
    (history) =>
      history.scrollHeight - history.scrollTop - history.clientHeight,
  );
  await scrollHistory(page, gap + 200);
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
  await scrollHistory(page, -400);
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
  await scrollToEnd(page);
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
  await scrollHistory(page, -400);
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
  await scrollToEnd(page);
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
  await scrollHistory(page, -400);
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

// ===========================================
// The draft inside the field
// ===========================================

/** More spoken words, so a dictation fills the field past its maximum height on a desktop too. */
const thirdDictation =
  "the onboarding sketches still need a clearer first step and a shorter welcome message and the dashboard should open on the summary view with the newest reports at the top while the settings stay one click away for anyone who wants to change the layout or the order of the cards on their own screen".split(
    " ",
  );
const longDictation = [
  ...firstDictation,
  ...secondDictation,
  ...thirdDictation,
];

/**
 * Measure where the field shows the draft after the last change. The caret's line, and the newest
 * dictated word's line when one is named, are found on a copy of the draft laid out by the page in a
 * hidden block with the field's text styles and width, which is independent of the composer's code;
 * the copy's height is kept so a test can check it lays the draft out as tall as the field does.
 */
async function recordDraft(
  page: Page,
  step: string,
  newest?: string,
): Promise<DraftSample> {
  const sample = await page.evaluate(
    ({ step, newest }) => {
      const field =
        document.querySelector<HTMLTextAreaElement>("#chat-message")!;
      const style = getComputedStyle(field);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const { value } = field;
      const view = {
        top: field.scrollTop,
        bottom: field.scrollTop + field.clientHeight,
      };
      /**
       * Lay the draft out with a mark at `position` and find the line the mark is on, in the field's
       * scrolled contents. A position that ends a line is marked with a zero-width space, which fits
       * on any line; anywhere else the mark holds the rest of the draft, so lines break where the
       * field breaks them.
       */
      const lineAt = (position: number) => {
        const copy = document.createElement("div");
        for (const property of [
          "direction",
          "font-family",
          "font-size",
          "font-stretch",
          "font-style",
          "font-variant",
          "font-weight",
          "font-feature-settings",
          "font-kerning",
          "letter-spacing",
          "word-spacing",
          "line-height",
          "text-indent",
          "text-transform",
          "text-rendering",
          "tab-size",
          "white-space",
          "word-break",
          "overflow-wrap",
          "line-break",
          "hyphens",
          "padding-top",
          "padding-right",
          "padding-bottom",
          "padding-left",
        ])
          copy.style.setProperty(property, style.getPropertyValue(property));
        Object.assign(copy.style, {
          position: "fixed",
          top: "0",
          left: "0",
          visibility: "hidden",
          boxSizing: "border-box",
          width: `${field.clientWidth}px`,
          border: "0",
          margin: "0",
        });
        copy.style.setProperty("text-size-adjust", "none");
        copy.style.setProperty("-webkit-text-size-adjust", "none");
        const ends = position === value.length || value[position] === "\n";
        const mark = document.createElement("span");
        mark.textContent = ends ? "​" : value.slice(position);
        copy.append(
          value.slice(0, position),
          mark,
          ends ? value.slice(position) : "",
        );
        // The field shows a line after a final line break; the block needs a character on it.
        if (value.endsWith("\n")) copy.append("​");
        document.body.append(copy);
        const box = mark.getClientRects()[0]!;
        const area = copy.getBoundingClientRect();
        copy.remove();
        const middle = box.top + box.height / 2 - area.top;
        const top = middle - lineHeight / 2;
        const bottom = middle + lineHeight / 2;
        return {
          top,
          bottom,
          shown: Math.max(
            0,
            Math.min(bottom, view.bottom) - Math.max(top, view.top),
          ),
          height: area.height,
        };
      };
      const caret = lineAt(field.selectionEnd);
      const at = newest
        ? value.lastIndexOf(newest, field.selectionEnd - newest.length)
        : -1;
      const word = at >= 0 ? lineAt(at) : null;
      return {
        step,
        length: value.length,
        selectionStart: field.selectionStart,
        selectionEnd: field.selectionEnd,
        fieldScrollTop: field.scrollTop,
        fieldClientHeight: field.clientHeight,
        fieldScrollHeight: field.scrollHeight,
        lineHeight,
        caretTop: caret.top,
        caretBottom: caret.bottom,
        caretShown: caret.shown,
        newest: newest ?? null,
        newestAt: word ? at : null,
        newestTop: word ? word.top : null,
        newestShown: word ? word.shown : null,
        copyHeight: caret.height,
        pageScroll: document.scrollingElement!.scrollTop,
      };
    },
    { step, newest },
  );
  drafts.push(sample);
  return sample;
}

/** The history and the draft after one change. */
interface Observation {
  readonly chat: Sample;
  readonly draft: DraftSample;
}

/** Measure the history and the draft after the last change. */
async function observe(
  page: Page,
  step: string,
  newest?: string,
): Promise<Observation> {
  const chat = await record(page, step);
  return { chat, draft: await recordDraft(page, step, newest) };
}

/**
 * The field shows the line the caret is on, and the newest dictated word's line when one is named:
 * most of each line is inside the field's own visible area, as typing leaves it. Typing reveals the
 * caret's line without the padding below it, so a line counts as shown when three quarters of it
 * is. The copy the lines are measured on must lay the draft out to the field's height.
 */
function expectCaretShown(draft: DraftSample): void {
  if (draft.fieldScrollHeight > draft.fieldClientHeight)
    expect
      .soft(
        Math.abs(draft.copyHeight - draft.fieldScrollHeight),
        `${draft.step}: pixels between the measured draft's height and the field's`,
      )
      .toBeLessThanOrEqual(1);
  expect
    .soft(
      draft.caretShown,
      `${draft.step}: pixels of the caret's line shown inside the field`,
    )
    .toBeGreaterThanOrEqual(0.75 * draft.lineHeight);
  if (draft.newest === null) return;
  expect
    .soft(draft.newestAt, `${draft.step}: the newest word is in the draft`)
    .not.toBeNull();
  expect
    .soft(
      draft.newestShown ?? 0,
      `${draft.step}: pixels of the newest word's line shown inside the field`,
    )
    .toBeGreaterThanOrEqual(0.75 * draft.lineHeight);
}

/** The field hasn't scrolled its contents since the writer scrolled it or placed the caret. */
function expectFieldStill(draft: DraftSample, still: DraftSample): void {
  expect
    .soft(
      Math.abs(draft.fieldScrollTop - still.fieldScrollTop),
      `${draft.step}: the field's scroll position stays put`,
    )
    .toBeLessThanOrEqual(1);
}

/** Dictating in the middle shows the insertion, not the end of the draft below it. */
function expectEndHidden(draft: DraftSample): void {
  expect
    .soft(
      draft.fieldScrollHeight - draft.fieldScrollTop - draft.fieldClientHeight,
      `${draft.step}: pixels of the draft below the field's visible bottom`,
    )
    .toBeGreaterThan(draft.lineHeight);
}

/** Nothing outside the field moves: the history follows the latest reply and the page stays put. */
function expectOuterStill(seen: Observation, opened: Observation): void {
  expectFollowing(seen.chat);
  expect
    .soft(seen.draft.pageScroll, `${seen.draft.step}: the page's own scroll`)
    .toBe(opened.draft.pageScroll);
}

/** Wait until the field's own scroll position has held still for several frames. */
async function settleField(page: Page): Promise<void> {
  await composer(page).evaluate(
    (field: HTMLTextAreaElement) =>
      new Promise<void>((resolve) => {
        let last = field.scrollTop;
        let still = 0;
        let count = 0;
        const tick = () => {
          const now = field.scrollTop;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 6 || ++count > 180) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * Scroll the draft inside the field with the mouse wheel over it, to just inside its start or its
 * end, as a writer does to reread it; stopping short of the ends keeps the wheel on the field.
 */
async function scrollField(page: Page, to: "start" | "end"): Promise<void> {
  const delta = await composer(page).evaluate(
    (field: HTMLTextAreaElement, to) => {
      const end = field.scrollHeight - field.clientHeight;
      if (end <= 4) return 0;
      return (to === "start" ? 2 : end - 2) - field.scrollTop;
    },
    to,
  );
  if (Math.abs(delta) < 1) return;
  const box = (await composer(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
  await settleField(page);
}

/**
 * Send growing partial transcripts of `words` into the draft between `before` and `after`, checking
 * that the draft holds exactly that text and checking the layout after each one appears.
 */
async function dictateInField(
  page: Page,
  gateway: LiveGateway,
  words: readonly string[],
  {
    before,
    after = "",
    label,
    from = 6,
    check,
  }: {
    before: string;
    after?: string;
    label: string;
    from?: number;
    check: (seen: Observation) => void;
  },
): Promise<void> {
  for (let count = from; count <= words.length + 5; count += 6) {
    const spoken = words.slice(0, Math.min(count, words.length));
    const text = spoken.join(" ");
    gateway.partial(text);
    await expect(composer(page)).toHaveValue(`${before}${text}${after}`);
    check(
      await observe(page, `${label}: ${spoken.length} words`, spoken.at(-1)),
    );
  }
}

/** Send a shorter partial than the last, replacing words already shown, and check the layout. */
async function revise(
  page: Page,
  gateway: LiveGateway,
  words: readonly string[],
  {
    before,
    after = "",
    label,
  }: { before: string; after?: string; label: string },
): Promise<Observation> {
  const text = words.join(" ");
  gateway.partial(text);
  await expect(composer(page)).toHaveValue(`${before}${text}${after}`);
  return observe(page, label, words.at(-1));
}

/** Send the final transcript once the gateway has the dictation's end, and wait for it in the draft. */
async function finish(
  page: Page,
  gateway: LiveGateway,
  words: readonly string[],
  {
    before,
    after = "",
    label,
    ends,
  }: {
    before: string;
    after?: string;
    label: string;
    ends: number;
  },
): Promise<Observation> {
  await expect.poll(() => gateway.ends).toBe(ends);
  const text = `${words.join(" ")}.`;
  gateway.final(text);
  await expect(composer(page)).toHaveValue(`${before}${text}${after}`);
  return observe(page, label, `${words.at(-1)}.`);
}

/** Touch and hold, and lift, the phone's microphone button, with audio flowing while it is held. */
async function microphone(page: Page, gateway: LiveGateway) {
  const touch = await page.context().newCDPSession(page);
  return {
    async press(): Promise<void> {
      const box = (await micButton(page).boundingBox())!;
      const frames = gateway.frames;
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 },
        ],
      });
      await expect(micButton(page)).toHaveAttribute("data-state", "recording");
      await expect.poll(() => gateway.frames).toBeGreaterThan(frames + 5);
    },
    async release(): Promise<void> {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    },
  };
}

/** A draft of short numbered lines, taller than the field can show at once. */
function numberedDraft(lines: number, text: string): string {
  return Array.from(
    { length: lines },
    (_, line) => `Line ${line + 1} ${text}`,
  ).join("\n");
}

/** Move the caret to the start of the given line of a draft of single-line rows, with the keyboard. */
async function caretToLine(page: Page, line: number): Promise<number> {
  await page.keyboard.press("Control+Home");
  for (let down = 1; down < line; down++)
    await page.keyboard.press("ArrowDown");
  return composer(page).evaluate(
    (field: HTMLTextAreaElement) => field.selectionEnd,
  );
}

/** A screenshot of the composer alone, kept as evidence. */
async function composerShot(page: Page, name: string): Promise<void> {
  await page.locator(".chat-composer").screenshot({
    path: path.join(evidence, `${test.info().project.name}-${name}.png`),
    animations: "disabled",
  });
}

test("@desktop held-Space dictation keeps its newest words in view inside a full field, again when continued, and after the writer scrolls back to them", async ({
  page,
}) => {
  const { server, gateway } = await open(page, "short", { streaming: true });
  const live = gateway!;
  gatewayRecord = live;
  const opened = await observe(page, "opened");
  await composer(page).click();
  await page.keyboard.type("Notes for Avery:");
  for (let line = 2; line <= 6; line++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`Note ${line} before dictating`);
  }
  const typed = await observe(page, "typed 6 lines");
  expectOuterStill(typed, opened);
  expectCaretShown(typed.draft);
  const shown = (seen: Observation) => {
    expectOuterStill(seen, opened);
    expectCaretShown(seen.draft);
  };

  // Hold Space to dictate past the field's maximum height.
  const notes = await composer(page).inputValue();
  await holdSpace(page, 1_300);
  await expect(micButton(page)).toHaveAttribute("data-state", "recording");
  await expect.poll(() => live.frames).toBeGreaterThan(5);
  const first = { before: `${notes} `, label: "first dictation" };
  await dictateInField(page, live, longDictation, { ...first, check: shown });
  const full = drafts.at(-1)!;
  // Past the field's maximum height by more than two lines.
  expect(full.fieldScrollHeight).toBeGreaterThan(
    full.fieldClientHeight + 2 * full.lineHeight,
  );
  await composerShot(page, "dictation-field");
  // A revision that drops words the gateway had shown.
  shown(
    await revise(page, live, longDictation.slice(0, -9), {
      ...first,
      label: "first dictation: shorter revision",
    }),
  );
  await page.keyboard.up(" ");
  shown(
    await finish(page, live, longDictation, {
      ...first,
      label: "first dictation added",
      ends: 1,
    }),
  );

  // Hold Space again to continue the draft.
  const added = await composer(page).inputValue();
  await holdSpace(page, 1_300);
  await expect(micButton(page)).toHaveAttribute("data-state", "recording");
  await expect.poll(() => live.starts.length).toBe(2);
  const second = { before: `${added} `, label: "continued dictation" };
  await dictateInField(page, live, longDictation.slice(0, 30), {
    ...second,
    check: shown,
  });

  // Scrolled back to the draft's start to reread it, the field stays there as words arrive.
  await scrollField(page, "start");
  const reading = await observe(
    page,
    "scrolled the field to the draft's start",
  );
  expect(reading.draft.caretShown).toBe(0);
  await dictateInField(page, live, longDictation.slice(0, 60), {
    ...second,
    label: "continued dictation while rereading",
    from: 36,
    check: (seen) => {
      expectOuterStill(seen, opened);
      expectFieldStill(seen.draft, reading.draft);
    },
  });

  // Scrolled back to the words, the field follows them again.
  await scrollField(page, "end");
  shown(await observe(page, "scrolled the field back to the end"));
  await dictateInField(page, live, longDictation, {
    ...second,
    label: "continued dictation followed again",
    from: 66,
    check: shown,
  });
  await page.keyboard.up(" ");
  shown(
    await finish(page, live, longDictation, {
      ...second,
      label: "continued dictation added",
      ends: 2,
    }),
  );

  // Escape takes a dictation's words back out, leaving the caret at the end of the draft in view.
  const kept = await composer(page).inputValue();
  await holdSpace(page, 1_300);
  await expect(micButton(page)).toHaveAttribute("data-state", "recording");
  await expect.poll(() => live.starts.length).toBe(3);
  await dictateInField(page, live, secondDictation, {
    before: `${kept} `,
    label: "dictation to cancel",
    check: shown,
  });
  await page.keyboard.press("Escape");
  await page.keyboard.up(" ");
  await expect(composer(page)).toHaveValue(kept);
  shown(await observe(page, "cancelled"));
  expect(server.sends).toEqual([]);
});

test("@desktop dictating in the middle of a long draft keeps the insertion in view rather than the draft's end, and leaves a writer's own scrolling and caret alone", async ({
  page,
}) => {
  const { server, gateway } = await open(page, "short", { streaming: true });
  const live = gateway!;
  gatewayRecord = live;
  const opened = await observe(page, "opened");
  await composer(page).click();
  const draft = numberedDraft(20, "of the notes for Avery.");
  await page.keyboard.insertText(draft);
  const pasted = await observe(page, "pasted 20 lines");
  expect(pasted.draft.fieldScrollHeight).toBeGreaterThan(
    pasted.draft.fieldClientHeight + 2 * pasted.draft.lineHeight,
  );
  const at = await caretToLine(page, 6);
  expect(at).toBe(draft.indexOf("Line 6 "));
  const middle = await observe(page, "caret at the start of line 6");
  expectCaretShown(middle.draft);

  // Hold Space at line 6: the words go there, ahead of the lines that follow.
  await holdSpace(page, 1_300);
  await expect(micButton(page)).toHaveAttribute("data-state", "recording");
  await expect.poll(() => live.frames).toBeGreaterThan(5);
  const inserted = {
    before: draft.slice(0, at),
    after: ` ${draft.slice(at)}`,
    label: "dictation at line 6",
  };
  const words = [...longDictation, ...secondDictation];
  await dictateInField(page, live, longDictation, {
    ...inserted,
    check: (seen) => {
      expectOuterStill(seen, opened);
      expectCaretShown(seen.draft);
      expectEndHidden(seen.draft);
    },
  });
  await composerShot(page, "middle-insertion-field");

  // The writer scrolls up and puts the caret at the end of line 1: dictation leaves both alone.
  await scrollField(page, "start");
  await recordDraft(page, "scrolled the field to the draft's start");
  // Past the end of line 1's text, well clear of the field's right edge.
  const lineOne = await composer(page).evaluate(
    (field: HTMLTextAreaElement) => {
      const box = field.getBoundingClientRect();
      const style = getComputedStyle(field);
      return {
        x: box.left + box.width * 0.6,
        y:
          box.top +
          Number.parseFloat(style.paddingTop) -
          field.scrollTop +
          Number.parseFloat(style.lineHeight) / 2,
      };
    },
  );
  await page.mouse.click(lineOne.x, lineOne.y);
  const placed = await observe(page, "placed the caret at the end of line 1");
  const lineEnd = draft.indexOf("\n");
  expect(placed.draft.selectionEnd).toBe(lineEnd);
  const still = (seen: Observation, caret: number) => {
    expectOuterStill(seen, opened);
    expectFieldStill(seen.draft, placed.draft);
    expect
      .soft(seen.draft.selectionStart, `${seen.draft.step}: the caret`)
      .toBe(caret);
    expect
      .soft(seen.draft.selectionEnd, `${seen.draft.step}: the caret`)
      .toBe(caret);
    // The writer's caret is away from the dictation, so only its line is watched.
    expectCaretShown({ ...seen.draft, newest: null });
  };
  const upTo = longDictation.length;
  await dictateInField(page, live, words.slice(0, upTo + 12), {
    ...inserted,
    label: "dictation while the caret is on line 1",
    from: upTo + 6,
    check: (seen) => still(seen, lineEnd),
  });
  // Typing there is the writer's own edit; the dictation carries on below it. A space would
  // end the held-Space dictation, so the edit has none.
  await page.keyboard.type("ok");
  const edited = {
    ...inserted,
    before: `${draft.slice(0, lineEnd)}ok${draft.slice(lineEnd, at)}`,
    label: "dictation after typing on line 1",
  };
  await dictateInField(page, live, words, {
    ...edited,
    from: upTo + 18,
    check: (seen) => still(seen, lineEnd + 2),
  });
  await page.keyboard.up(" ");
  still(
    await finish(page, live, words, {
      ...edited,
      label: "dictation added while the caret is on line 1",
      ends: 1,
    }),
    lineEnd + 2,
  );

  // Holding Space again dictates at the writer's caret, and the field follows those words.
  const now = await composer(page).inputValue();
  await holdSpace(page, 1_300);
  await expect(micButton(page)).toHaveAttribute("data-state", "recording");
  await expect.poll(() => live.starts.length).toBe(2);
  const resumed = {
    before: `${now.slice(0, lineEnd + 2)} `,
    after: now.slice(lineEnd + 2),
    label: "dictation at line 1",
  };
  await dictateInField(page, live, longDictation, {
    ...resumed,
    check: (seen) => {
      expectOuterStill(seen, opened);
      expectCaretShown(seen.draft);
      expectEndHidden(seen.draft);
    },
  });
  await page.keyboard.up(" ");
  const done = await finish(page, live, longDictation, {
    ...resumed,
    label: "dictation added at line 1",
    ends: 2,
  });
  expectOuterStill(done, opened);
  expectCaretShown(done.draft);
  expect(server.sends).toEqual([]);
});

test("@phone held microphone dictation keeps its newest words in view inside a full field, again when continued, and after the writer rereads the draft", async ({
  page,
}) => {
  const { server, gateway } = await open(page, "short", { streaming: true });
  const live = gateway!;
  gatewayRecord = live;
  const mic = await microphone(page, live);
  const opened = await observe(page, "opened");
  await composer(page).tap();
  await page.keyboard.type("Notes for Avery:");
  const typed = await observe(page, "typed a line");
  expectOuterStill(typed, opened);
  expectCaretShown(typed.draft);
  const shown = (seen: Observation) => {
    expectOuterStill(seen, opened);
    expectCaretShown(seen.draft);
  };

  // Hold the button to dictate past the field's maximum height.
  await mic.press();
  const first = { before: "Notes for Avery: ", label: "first dictation" };
  await dictateInField(page, live, longDictation, { ...first, check: shown });
  const full = drafts.at(-1)!;
  // Past the field's maximum height by more than two lines.
  expect(full.fieldScrollHeight).toBeGreaterThan(
    full.fieldClientHeight + 2 * full.lineHeight,
  );
  await composerShot(page, "dictation-field");
  shown(
    await revise(page, live, longDictation.slice(0, -9), {
      ...first,
      label: "first dictation: shorter revision",
    }),
  );
  await mic.release();
  shown(
    await finish(page, live, longDictation, {
      ...first,
      label: "first dictation added",
      ends: 1,
    }),
  );

  // Hold the button again to continue the draft.
  const added = await composer(page).inputValue();
  await mic.press();
  await expect.poll(() => live.starts.length).toBe(2);
  const second = { before: `${added} `, label: "continued dictation" };
  await dictateInField(page, live, longDictation.slice(0, 30), {
    ...second,
    check: shown,
  });

  // Scrolled back to the draft's start to reread it, the field stays there as words arrive and
  // when the dictation ends.
  await scrollField(page, "start");
  const reading = await observe(
    page,
    "scrolled the field to the draft's start",
  );
  expect(reading.draft.caretShown).toBe(0);
  const rereading = (seen: Observation) => {
    expectOuterStill(seen, opened);
    expectFieldStill(seen.draft, reading.draft);
  };
  await dictateInField(page, live, longDictation.slice(0, 60), {
    ...second,
    label: "continued dictation while rereading",
    from: 36,
    check: rereading,
  });
  await mic.release();
  rereading(
    await finish(page, live, longDictation.slice(0, 60), {
      ...second,
      label: "continued dictation added while rereading",
      ends: 2,
    }),
  );

  // Holding the button again shows where the new words go, and follows them.
  const kept = await composer(page).inputValue();
  await mic.press();
  await expect.poll(() => live.starts.length).toBe(3);
  const third = { before: `${kept} `, label: "dictation after rereading" };
  await dictateInField(page, live, secondDictation, { ...third, check: shown });
  await mic.release();
  shown(
    await finish(page, live, secondDictation, {
      ...third,
      label: "dictation added after rereading",
      ends: 3,
    }),
  );
  expect(server.sends).toEqual([]);
});

test("@phone dictating in the middle of a long draft keeps the insertion in view rather than the draft's end", async ({
  page,
}) => {
  const { server, gateway } = await open(page, "short", { streaming: true });
  const live = gateway!;
  gatewayRecord = live;
  const mic = await microphone(page, live);
  const opened = await observe(page, "opened");
  await composer(page).tap();
  const draft = numberedDraft(12, "of notes.");
  await page.keyboard.insertText(draft);
  const pasted = await observe(page, "pasted 12 lines");
  expect(pasted.draft.fieldScrollHeight).toBeGreaterThan(
    pasted.draft.fieldClientHeight + 2 * pasted.draft.lineHeight,
  );
  // Scroll back up and tap the start of line 3, as a writer does on a phone.
  await scrollField(page, "start");
  const lineThree = await composer(page).evaluate(
    (field: HTMLTextAreaElement) => {
      const box = field.getBoundingClientRect();
      const style = getComputedStyle(field);
      return {
        x: box.left + Number.parseFloat(style.paddingLeft) + 1,
        y:
          box.top +
          Number.parseFloat(style.paddingTop) -
          field.scrollTop +
          Number.parseFloat(style.lineHeight) * 2.5,
      };
    },
  );
  await page.touchscreen.tap(lineThree.x, lineThree.y);
  const at = await composer(page).evaluate(
    (field: HTMLTextAreaElement) => field.selectionEnd,
  );
  expect(at).toBe(draft.indexOf("Line 3 "));
  expectCaretShown((await observe(page, "caret at the start of line 3")).draft);

  // Hold the button at line 3: the words go there, ahead of the lines that follow.
  await mic.press();
  const inserted = {
    before: draft.slice(0, at),
    after: ` ${draft.slice(at)}`,
    label: "dictation at line 3",
  };
  const inView = (seen: Observation) => {
    expectOuterStill(seen, opened);
    expectCaretShown(seen.draft);
    expectEndHidden(seen.draft);
  };
  await dictateInField(page, live, longDictation, {
    ...inserted,
    check: inView,
  });
  await composerShot(page, "middle-insertion-field");
  inView(
    await revise(page, live, longDictation.slice(0, -9), {
      ...inserted,
      label: "dictation at line 3: shorter revision",
    }),
  );
  await mic.release();
  inView(
    await finish(page, live, longDictation, {
      ...inserted,
      label: "dictation added at line 3",
      ends: 1,
    }),
  );
  expect(server.sends).toEqual([]);
});
