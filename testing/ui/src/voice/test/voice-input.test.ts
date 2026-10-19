import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { liveGateway } from "../fixture/live-gateway.js";
import {
  answerPermission,
  chromiumFormats,
  installFakeMicrophone,
  microphone,
  safariFormats,
  voiceWorkspace,
  type FakeMicrophoneOptions,
  type VoiceWorkspace,
} from "../fixture/voice-workspace.js";

/** The composer field. */
const composer = (page: Page): Locator =>
  page.getByRole("textbox", { name: "Message Avery", exact: true });

/** The hold-to-record button. */
const micButton = (page: Page): Locator => page.locator(".voice-button");

/** The dictation status line. */
const status = (page: Page): Locator => page.locator("#voice-status");

/** The top of the composer field, which a visible status line above it would push down. */
async function fieldTop(page: Page): Promise<number> {
  return (await composer(page).boundingBox())!.y;
}

/** The status is for screen readers only: it takes no visible space and the field stays put. */
async function expectNoVisibleStatus(page: Page, top: number): Promise<void> {
  const box = await status(page).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(1);
  expect(box!.height).toBeLessThanOrEqual(1);
  expect(await fieldTop(page)).toBe(top);
}

/** Fake formats that match the engine under test, so negotiation follows its real behavior. */
function formatsFor(
  browserName: string,
  permission: FakeMicrophoneOptions["permission"] = "grant",
) {
  return {
    ...(browserName === "webkit" ? safariFormats : chromiumFormats),
    permission,
  };
}

/** The type each engine's negotiation should choose, given the fake's format list. */
const expectedType = (browserName: string): string =>
  browserName === "webkit"
    ? "audio/mp4;codecs=mp4a.40.2"
    : "audio/webm;codecs=opus";

/** Open Avery's conversation with a fake microphone and every API route mocked. */
async function open(
  page: Page,
  browserName: string,
  permission: FakeMicrophoneOptions["permission"] = "grant",
): Promise<VoiceWorkspace> {
  await installFakeMicrophone(
    page.context(),
    formatsFor(browserName, permission),
  );
  const server = await voiceWorkspace(page.context());
  await page.goto("/team/avery");
  await expect(composer(page)).toBeEnabled();
  await expect(micButton(page)).toBeEnabled();
  return server;
}

/** Hold Space in the composer for a while, sending the auto-repeats a held key produces. */
async function holdSpace(page: Page, durationMs: number): Promise<void> {
  await page.keyboard.down(" ");
  const until = Date.now() + durationMs;
  // A held key repeats; Playwright marks a second down of a held key as a repeat.
  while (Date.now() < until) {
    await page.waitForTimeout(100);
    await page.keyboard.down(" ");
  }
}

/** The composer's draft and selection. */
function field(
  page: Page,
): Promise<{ value: string; start: number; end: number }> {
  return composer(page).evaluate((element: HTMLTextAreaElement) => ({
    value: element.value,
    start: element.selectionStart,
    end: element.selectionEnd,
  }));
}

/** Put text in the composer with the caret at a position. */
async function draft(
  page: Page,
  text: string,
  start: number,
  end = start,
): Promise<void> {
  await composer(page).fill(text);
  await composer(page).evaluate(
    (element: HTMLTextAreaElement, [from, to]) =>
      element.setSelectionRange(from!, to!),
    [start, end],
  );
}

/** Dispatch a touch pointer event to the microphone button. */
function touch(page: Page, type: string): Promise<void> {
  return micButton(page).dispatchEvent(type, {
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: type === "pointerdown" ? 1 : 0,
    bubbles: true,
    cancelable: true,
  });
}

// ===========================================
// Desktop: holding Space in the composer
// ===========================================

test.describe("desktop Space hold", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, "Holding Space is a desktop keyboard gesture.");
  });

  test("ordinary Space typing, short holds, and shortcuts never open the microphone", async ({
    page,
    browserName,
  }) => {
    await open(page, browserName);
    // Screen readers hear how to record; on screen only the microphone button shows voice input.
    await expect(page.locator("#composer-help")).toContainText(
      "Hold Space for 1 second to record",
    );
    const hint = await page
      .getByText("Hold Space for 1 second to record")
      .boundingBox();
    expect(hint!.width).toBeLessThanOrEqual(1);
    expect(hint!.height).toBeLessThanOrEqual(1);
    await expect(page.locator("#composer-help")).toContainText(
      "Enter to send · Shift+Enter for a new line",
    );
    await composer(page).click();
    await page.keyboard.type("a b c");
    await holdSpace(page, 600);
    await page.keyboard.up(" ");
    await page.keyboard.type("d");
    // One space per press: the held press's repeats added nothing.
    expect((await field(page)).value).toBe("a b c d");
    for (const modifier of ["Shift", "Control", "Alt"]) {
      await page.keyboard.down(modifier);
      await holdSpace(page, 1_300);
      await page.keyboard.up(" ");
      await page.keyboard.up(modifier);
    }
    expect((await microphone(page)).requests).toBe(0);
    await expect(status(page)).toHaveText("");
  });

  test("with time held still, a hold starts recording at exactly 1 second, once", async ({
    page,
    browserName,
  }) => {
    await page.clock.install();
    await open(page, browserName);
    await draft(page, "Hi", 2);
    await composer(page).focus();
    await page.clock.pauseAt(Date.now() + 60_000);
    await page.keyboard.down(" ");
    await page.clock.runFor(999);
    await expect(micButton(page)).toHaveAttribute("data-state", "arming");
    expect((await microphone(page)).requests).toBe(0);
    expect((await field(page)).value).toBe("Hi ");
    await page.clock.runFor(1);
    await expect(micButton(page)).toHaveAttribute("data-state", "recording");
    // The hold's own space is gone; more time starts nothing more.
    expect((await field(page)).value).toBe("Hi");
    await page.clock.runFor(5_000);
    expect((await microphone(page)).requests).toBe(1);
    await page.keyboard.up(" ");
    await page.clock.resume();
    await expect(composer(page)).toHaveValue("Hi there");
  });

  test("other keys and IME composition end a hold before it records", async ({
    page,
    browserName,
  }) => {
    await open(page, browserName);
    await draft(page, "Hi", 2);
    await composer(page).focus();
    // Fast typing: the next letter goes down while Space is still held.
    await page.keyboard.down(" ");
    await page.keyboard.press("t");
    await page.waitForTimeout(1_300);
    await page.keyboard.up(" ");
    expect((await field(page)).value).toBe("Hi t");
    await page.keyboard.down(" ");
    await composer(page).dispatchEvent("compositionstart");
    await page.waitForTimeout(1_300);
    await page.keyboard.up(" ");
    expect((await microphone(page)).requests).toBe(0);
  });

  test("a 1-second hold records, and release adds the transcript at the caret without sending", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    await draft(page, "Say hello", 3);
    await composer(page).focus();
    const top = await fieldTop(page);
    await holdSpace(page, 1_300);
    await expect(status(page)).toContainText("Recording");
    await expect(micButton(page)).toHaveAttribute("data-state", "recording");
    await expect(micButton(page)).toHaveAccessibleName(/^Recording/);
    await expectNoVisibleStatus(page, top);
    // The hold's own space is gone and no repeats were typed.
    expect(await field(page)).toEqual({ value: "Say hello", start: 3, end: 3 });
    await page.waitForTimeout(1_200);
    await page.keyboard.up(" ");
    await expect(composer(page)).toHaveValue("Say there hello");
    // Screen readers hear the outcome; nothing appears above the field.
    await expect(status(page)).toContainText("Added your words");
    await expectNoVisibleStatus(page, top);
    await expect(micButton(page)).toHaveAttribute("data-state", "idle");
    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0]!.path).toBe(
      "/v1/agents/avery/voice/transcriptions",
    );
    expect(server.uploads[0]!.contentType).toBe(expectedType(browserName));
    expect(server.sends).toEqual([]);
    const fake = await microphone(page);
    expect(fake.recordersCreated).toBe(1);
    expect(fake.tracksStopped).toBe(fake.tracksStarted);
  });

  test("a selection is restored when recording starts and replaced by the transcript", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    server.transcript = "new";
    await draft(page, "Use OLD here", 4, 7);
    await composer(page).focus();
    await holdSpace(page, 1_300);
    await expect(status(page)).toContainText("Recording");
    expect(await field(page)).toEqual({
      value: "Use OLD here",
      start: 4,
      end: 7,
    });
    await page.keyboard.up(" ");
    await expect(composer(page)).toHaveValue("Use new here");
  });

  test("Escape cancels a recording and nothing is uploaded", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    await draft(page, "Keep this", 9);
    await composer(page).focus();
    await holdSpace(page, 1_300);
    await expect(status(page)).toContainText("Recording");
    await page.keyboard.press("Escape");
    await expect(status(page)).toContainText("Recording canceled");
    await page.keyboard.up(" ");
    await page.waitForTimeout(500);
    expect(server.uploads).toHaveLength(0);
    await expect(composer(page)).toHaveValue("Keep this");
    const fake = await microphone(page);
    expect(fake.tracksStopped).toBe(fake.tracksStarted);
  });

  test("words typed while transcribing are kept after the transcript", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    let open_: () => void = () => undefined;
    server.gate = new Promise((resolve) => (open_ = resolve));
    await draft(page, "Hello", 5);
    await composer(page).focus();
    await holdSpace(page, 1_300);
    await page.waitForTimeout(600);
    await page.keyboard.up(" ");
    await expect.poll(() => server.uploads.length).toBe(1);
    await page.keyboard.type(" friends");
    open_();
    await expect(composer(page)).toHaveValue("Hello there friends");
  });

  test("sending while transcribing drops the pending transcript", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    let open_: () => void = () => undefined;
    server.gate = new Promise((resolve) => (open_ = resolve));
    await draft(page, "Ship it", 7);
    await composer(page).focus();
    await holdSpace(page, 1_300);
    await page.waitForTimeout(600);
    await page.keyboard.up(" ");
    await expect.poll(() => server.uploads.length).toBe(1);
    await page.keyboard.press("Enter");
    await expect.poll(() => server.sends).toEqual(["Ship it"]);
    await expect(composer(page)).toHaveValue("");
    open_();
    await page.waitForTimeout(500);
    await expect(composer(page)).toHaveValue("");
  });

  test("permission granted after release starts no recorder and stops the microphone", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName, "manual");
    await composer(page).focus();
    await holdSpace(page, 1_300);
    await expect(status(page)).toContainText("Allow access");
    await page.keyboard.up(" ");
    await expect(status(page)).toContainText("Keep holding to record");
    await answerPermission(page, "grant");
    await expect
      .poll(async () => (await microphone(page)).tracksStopped)
      .toBe(1);
    expect((await microphone(page)).recordersCreated).toBe(0);
    expect(server.uploads).toHaveLength(0);
  });

  test("a blocked microphone explains how to allow it", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName, "deny");
    await draft(page, "Draft", 5);
    await composer(page).focus();
    const top = await fieldTop(page);
    await holdSpace(page, 1_300);
    await expect(status(page)).toContainText("Microphone access is blocked");
    // On screen, the button is marked and its name and tooltip explain the problem.
    await expect(micButton(page)).toHaveAttribute("data-problem", "true");
    await expect(micButton(page)).toHaveAttribute(
      "title",
      /^Microphone access is blocked/,
    );
    await expect(micButton(page)).toHaveAccessibleName(
      /^Microphone access is blocked/,
    );
    await expectNoVisibleStatus(page, top);
    await page.keyboard.up(" ");
    await expect(composer(page)).toHaveValue("Draft");
    expect(server.uploads).toHaveLength(0);
  });

  test("leaving the window or hiding the page cancels a recording", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    await composer(page).focus();
    for (const leave of [
      () => page.evaluate(() => window.dispatchEvent(new Event("blur"))),
      () =>
        page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
          });
        }),
    ]) {
      await holdSpace(page, 1_300);
      await expect(status(page)).toContainText("Recording");
      await leave();
      await expect(micButton(page)).toHaveAttribute("data-state", "idle");
      await page.keyboard.up(" ");
    }
    await page.waitForTimeout(500);
    expect(server.uploads).toHaveLength(0);
    const fake = await microphone(page);
    expect(fake.tracksStopped).toBe(fake.tracksStarted);
  });

  test("focus moving to another control ends a button recording without uploading", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    await draft(page, "Draft", 5);
    await composer(page).focus();
    await micButton(page).hover();
    await page.mouse.down();
    await expect(status(page)).toContainText("Release to add your words");
    // The button keeps the field focused; focus then moves elsewhere in the same window.
    await expect(composer(page)).toBeFocused();
    await page.getByRole("button", { name: "Edit Avery", exact: true }).focus();
    await expect(micButton(page)).toHaveAttribute("data-state", "idle");
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(server.uploads).toHaveLength(0);
    await expect(composer(page)).toHaveValue("Draft");
    const fake = await microphone(page);
    expect(fake.tracksStopped).toBe(fake.tracksStarted);
  });

  test("tabbing out of the composer or Escape abandons a button transcription", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    const aborted: string[] = [];
    page.on("requestfailed", (request) => {
      if (request.url().includes("/voice/transcriptions"))
        aborted.push(request.url());
    });
    for (const leave of [
      async () => {
        // Field, then the microphone button, then outside the composer (Send is disabled).
        await composer(page).fill("");
        await composer(page).focus();
        await page.keyboard.press("Tab");
        await expect(micButton(page)).toBeFocused();
        await page.keyboard.press("Tab");
      },
      async () => {
        await composer(page).focus();
        await page.keyboard.press("Escape");
      },
    ]) {
      let open_: () => void = () => undefined;
      server.gate = new Promise((resolve) => (open_ = resolve));
      const uploads = server.uploads.length;
      await micButton(page).hover();
      await page.mouse.down();
      await expect(status(page)).toContainText("Release to add your words");
      await page.waitForTimeout(600);
      await page.mouse.up();
      await expect.poll(() => server.uploads.length).toBe(uploads + 1);
      await expect(micButton(page)).toHaveAttribute(
        "data-state",
        "transcribing",
      );
      await leave();
      await expect(micButton(page)).toHaveAttribute("data-state", "idle");
      open_();
      await page.waitForTimeout(500);
      await expect(composer(page)).toHaveValue("");
    }
    expect(aborted).toHaveLength(2);
    const fake = await microphone(page);
    expect(fake.tracksStopped).toBe(fake.tracksStarted);
  });

  test("holding the microphone button with a mouse also records", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    await draft(page, "Note:", 5);
    await micButton(page).hover();
    await page.mouse.down();
    await expect(status(page)).toContainText("Release to add your words");
    await page.waitForTimeout(1_200);
    await page.mouse.up();
    await expect(composer(page)).toHaveValue("Note: there");
    expect(server.uploads).toHaveLength(1);
  });
});

// ===========================================
// Phones: holding the microphone button
// ===========================================

// ===========================================
// Streaming: partial transcripts in the composer
// ===========================================

test.describe("live dictation", () => {
  test.beforeEach(({ browserName, isMobile }) => {
    test.skip(
      browserName !== "chromium" || isMobile,
      "The stand-in gateway's silent microphone is checked on desktop Chromium.",
    );
  });

  /** Open Avery's conversation with the streaming lane and a stand-in version 2 gateway. */
  async function openLive(page: Page) {
    const gateway = await liveGateway(page.context());
    const server = await voiceWorkspace(page.context(), { streaming: true });
    await page.goto("/team/avery");
    await expect(micButton(page)).toBeEnabled();
    return { gateway, server };
  }

  test("words appear in the composer while held, are revised in place, and the final replaces them once", async ({
    page,
  }) => {
    const { gateway, server } = await openLive(page);
    await draft(page, "Note:", 5);
    await composer(page).focus();
    const top = await fieldTop(page);
    await micButton(page).hover();
    await page.mouse.down();
    await expect(micButton(page)).toHaveAttribute("data-state", "recording");
    await expect.poll(() => gateway.frames).toBeGreaterThan(5);
    expect(gateway.starts).toEqual([2]);
    gateway.partial("hello");
    await expect(composer(page)).toHaveValue("Note: hello");
    gateway.partial("hello wor");
    gateway.partial("hello world");
    await expect(composer(page)).toHaveValue("Note: hello world");
    expect(await field(page)).toEqual({
      value: "Note: hello world",
      start: 17,
      end: 17,
    });
    // Still held: no end yet, nothing on screen but the words and the button.
    expect(gateway.ends).toBe(0);
    await expectNoVisibleStatus(page, top);
    await page.mouse.up();
    await expect.poll(() => gateway.ends).toBe(1);
    await expect(micButton(page)).toHaveAttribute("data-state", "transcribing");
    gateway.final("Hello, world.");
    await expect(composer(page)).toHaveValue("Note: Hello, world.");
    await expect(status(page)).toContainText("Added your words");
    expect(server.sends).toEqual([]);
  });

  test("typing beside the words is kept as they change, and Escape puts the draft back", async ({
    page,
  }) => {
    const { gateway, server } = await openLive(page);
    await draft(page, "Hi", 2);
    await composer(page).focus();
    await holdSpace(page, 1_300);
    await expect(micButton(page)).toHaveAttribute("data-state", "recording");
    gateway.partial("there");
    await expect(composer(page)).toHaveValue("Hi there");
    await page.keyboard.type("!");
    await expect(composer(page)).toHaveValue("Hi there!");
    gateway.partial("there friend");
    await expect(composer(page)).toHaveValue("Hi there friend!");
    expect(await field(page)).toEqual({
      value: "Hi there friend!",
      start: 16,
      end: 16,
    });
    // Backspace into the words is refused while they are provisional.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    await expect(composer(page)).toHaveValue("Hi there friend!");
    // Sending now would send only what was typed; Escape takes the words out.
    await page.keyboard.press("Escape");
    await expect(composer(page)).toHaveValue("Hi!");
    await expect(status(page)).toContainText("Recording canceled");
    await page.keyboard.up(" ");
    await expect.poll(() => gateway.cancels).toBe(1);
    gateway.partial("late words");
    await page.waitForTimeout(300);
    await expect(composer(page)).toHaveValue("Hi!");
    expect(server.sends).toEqual([]);
  });

  test("sending during dictation sends only the typed text and drops the words", async ({
    page,
  }) => {
    const { gateway, server } = await openLive(page);
    await draft(page, "Typed", 5);
    await composer(page).focus();
    await micButton(page).hover();
    await page.mouse.down();
    await expect(micButton(page)).toHaveAttribute("data-state", "recording");
    gateway.partial("spoken words");
    await expect(composer(page)).toHaveValue("Typed spoken words");
    await page.keyboard.press("Enter");
    await expect.poll(() => server.sends).toEqual(["Typed"]);
    await expect(composer(page)).toHaveValue("");
    await page.mouse.up();
  });
});

test.describe("phone microphone button", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, "The compact composer is a phone layout.");
  });

  test("the composer fits without overflow and the button is a 44-pixel target", async ({
    page,
    browserName,
  }, info) => {
    await open(page, browserName);
    const button = await micButton(page).boundingBox();
    expect(button?.width).toBe(44);
    expect(button?.height).toBe(44);
    const viewport = page.viewportSize()!;
    expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
    const send = await page
      .getByRole("button", { name: "Send message" })
      .boundingBox();
    expect(send!.x + send!.width).toBeLessThanOrEqual(viewport.width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await expect(page.locator("#composer-help")).toBeHidden();
    await expect(micButton(page)).toHaveCSS("touch-action", "none");
    await page.screenshot({
      path: info.outputPath("phone-composer.png"),
      animations: "disabled",
    });
  });

  test("a held touch records until release and adds the words at the caret", async ({
    page,
    browserName,
  }, info) => {
    const server = await open(page, browserName);
    await draft(page, "Hello", 5);
    const top = await fieldTop(page);
    await touch(page, "pointerdown");
    await expect(status(page)).toContainText("Release to add your words");
    await expect(micButton(page)).toHaveAttribute("data-state", "recording");
    await expectNoVisibleStatus(page, top);
    await page.screenshot({
      path: info.outputPath("phone-recording.png"),
      animations: "disabled",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.waitForTimeout(1_200);
    await touch(page, "pointerup");
    await expect(composer(page)).toHaveValue("Hello there");
    await expect(status(page)).toContainText("Added your words");
    await expectNoVisibleStatus(page, top);
    expect(server.uploads[0]!.contentType).toBe(expectedType(browserName));
    expect(server.sends).toEqual([]);
    const fake = await microphone(page);
    expect(fake.tracksStopped).toBe(fake.tracksStarted);
  });

  test("a quick tap explains how to record and records nothing", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    await touch(page, "pointerdown");
    await touch(page, "pointerup");
    await expect(status(page)).toContainText("Keep holding to record");
    await page.waitForTimeout(500);
    expect(server.uploads).toHaveLength(0);
    const fake = await microphone(page);
    expect(fake.tracksStopped).toBe(fake.tracksStarted);
  });

  test("a cancelled touch discards the recording, and long presses open no menu", async ({
    page,
    browserName,
  }) => {
    const server = await open(page, browserName);
    await draft(page, "Draft", 5);
    await touch(page, "pointerdown");
    await expect(status(page)).toContainText("Release to add your words");
    await touch(page, "pointercancel");
    await expect(micButton(page)).toHaveAttribute("data-state", "idle");
    await page.waitForTimeout(500);
    expect(server.uploads).toHaveLength(0);
    await expect(composer(page)).toHaveValue("Draft");
    const prevented = await micButton(page).evaluate((element) => {
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });
});

// ===========================================
// Real browser recorders, without the fake microphone
// ===========================================

test.describe("real recorder formats", () => {
  test("Chromium records Opus in WebM, and MP4 when only MP4 is accepted, uploading the actual type", async ({
    page,
    browserName,
    isMobile,
  }, info) => {
    test.skip(
      browserName !== "chromium" || isMobile,
      "Uses Chromium's generated microphone.",
    );
    for (const mediaTypes of [
      ["audio/webm", "audio/ogg", "audio/mp4"],
      ["audio/mp4"],
    ]) {
      const context = await page
        .context()
        .browser()!
        .newContext({
          baseURL: info.project.use.baseURL!,
          viewport: { width: 1440, height: 960 },
        });
      await context.grantPermissions(["microphone"]);
      const server = await voiceWorkspace(context);
      await context.route("**/v1/voice/capabilities", (route) =>
        route.fulfill({
          json: {
            available: true,
            maxDurationMs: 60_000,
            maxBytes: 8 * 1024 * 1024,
            mediaTypes,
            responseTimeoutMs: 195_000,
          },
        }),
      );
      const real = await context.newPage();
      await real.goto("/team/avery");
      await expect(micButton(real)).toBeEnabled();
      await micButton(real).hover();
      await real.mouse.down();
      await expect(status(real)).toContainText("Release to add your words");
      await real.waitForTimeout(2_000);
      await real.mouse.up();
      await expect(composer(real)).toHaveValue("there");
      const [upload] = server.uploads;
      const name =
        mediaTypes.length > 1
          ? "chromium-recording.webm"
          : "chromium-recording.mp4";
      // Kept so the backend decoder can be checked against a real browser recording.
      await writeFile(info.outputPath(name), upload!.bytes);
      await info.attach(name, {
        body: upload!.bytes,
        contentType: upload!.contentType,
      });
      if (mediaTypes.length > 1) {
        expect(upload!.contentType).toBe("audio/webm;codecs=opus");
        expect(upload!.bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
      } else {
        expect(upload!.contentType.split(";")[0]).toBe("audio/mp4");
        expect(upload!.bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
      }
      await context.close();
    }
  });

  test("an engine without MediaRecorder shows voice input as unavailable instead of failing later", async ({
    page,
    browserName,
  }) => {
    const supported = await page.evaluate(
      () => typeof MediaRecorder !== "undefined",
    );
    test.skip(supported, "This engine can record.");
    expect(browserName).toBe("webkit");
    await voiceWorkspace(page.context());
    await page.goto("/team/avery");
    await expect(micButton(page)).toBeDisabled();
    await expect(micButton(page)).toHaveAttribute(
      "aria-label",
      "This browser can't record audio for voice input.",
    );
    await expect(page.locator("#composer-help")).not.toContainText(
      "Hold Space",
    );
  });
});
