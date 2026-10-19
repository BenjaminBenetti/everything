import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Real end-to-end voice streaming: the browser's own AudioWorklet captures a public LibriSpeech clip
 * played into a synthetic microphone stream, the local gateway relays it, and the self-hosted
 * Nemotron service transcribes it while the button is held, sending its provisional words back into
 * the composer. Only the clip source is synthetic: the audio graph, worklet, WebSocket transport,
 * gateway, and native service are all real. API routes the conversation page needs besides voice
 * are mocked; capabilities and the stream go to the gateway. Run with
 * `pnpm --filter @everything/ui-tests test:voice-e2e` against a running gateway and UI server; see
 * the voice-input documentation.
 */

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const fixtures =
  process.env.VOICE_E2E_FIXTURES ?? "/tmp/everything-voice-e2e-fixtures";

/** The public clips and their reference transcripts. */
const clips = [
  {
    file: "ls_10s.wav",
    reference:
      "HE HAS GRAVE DOUBTS WHETHER SIR FREDERICK LEIGHTON'S WORK IS REALLY GREEK AFTER ALL AND CAN DISCOVER IN IT BUT LITTLE OF ROCKY ITHACA",
  },
  {
    file: "ls_30s.wav",
    reference:
      "LINNELL'S PICTURES ARE A SORT OF UP GUARDS AND AT EM PAINTINGS AND MASON'S EXQUISITE IDYLLS ARE AS NATIONAL AS A JINGO POEM MISTER BIRKET FOSTER'S LANDSCAPES SMILE AT ONE MUCH IN THE SAME WAY THAT MISTER CARKER USED TO FLASH HIS TEETH AND MISTER JOHN COLLIER GIVES HIS SITTER A CHEERFUL SLAP ON THE BACK BEFORE HE SAYS LIKE A SHAMPOOER IN A TURKISH BATH NEXT MAN",
  },
] as const;

/** Word error rate after lower-casing and dropping punctuation. */
function wordErrorRate(reference: string, hypothesis: string): number {
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z' ]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const ref = words(reference);
  const hyp = words(hypothesis);
  const previous = Array.from({ length: hyp.length + 1 }, (_, index) => index);
  for (let i = 1; i <= ref.length; i++) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    previous.splice(0, previous.length, ...current);
  }
  return previous[hyp.length]! / ref.length;
}

/** Message sends the page attempted. */
const sends = { count: 0 };

/** Mock the page's other API routes; voice capabilities and the stream reach the real gateway. */
async function workspace(
  context: BrowserContext,
  baseURL: string,
): Promise<void> {
  await context.addCookies([
    { name: "everything-session", value: "e2e-session", url: baseURL },
  ]);
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  const avery = {
    id: agentId,
    name: "Avery",
    avatarId: "avatar-03",
    systemPrompt: "Help with project planning.",
    createdAt: "2026-10-12T10:00:00Z",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  };
  const json = (pattern: string | RegExp, body: unknown, status = 200) =>
    context.route(pattern, (route) =>
      status === 204
        ? route.fulfill({ status })
        : route.fulfill({ status, json: body }),
    );
  await json("**/v1/session", {
    profile: { subject: "e2e-owner", displayName: "E2E" },
  });
  await json("**/v1/providers", { providers: [] });
  await json("**/v1/agents", { agents: [avery] });
  await json("**/v1/agents/recent", { agents: [avery] });
  await json("**/v1/agents/*/interactions", null, 204);
  await json("**/v1/workspaces", { workspaces: [] });
  await json("**/v1/agents/*/workspaces", {
    workspaces: [],
    observedAt: new Date().toISOString(),
  });
  await json("**/v1/agents/*/runtime", {
    status: "idle",
    compacting: false,
    compactionStartedAt: null,
    typing: false,
    backgroundCount: 0,
    sessionId: "e2e",
    runId: null,
    error: null,
  });
  // Reading history is allowed; any send would mean dictation sent a message by itself.
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") sends.count++;
    return route.fulfill({ json: { messages: [], nextCursor: null } });
  });
  await json("**/v1/updates**", {
    updates: [],
    nextCursor: null,
    unread: 0,
    byAgent: {},
  });
  await context.route("**/v1/voice/capabilities", (route) => route.continue());
}

/**
 * Replace the microphone with a stream that plays public clips on request. Playback starts only when
 * the test calls `voiceFixture.play`, after the composer reports recording, so no words are lost to
 * setup; `seconds` stops it early. Each new microphone request gets a fresh stream.
 */
async function clipMicrophone(context: BrowserContext): Promise<void> {
  for (const clip of clips) {
    const wav = readFileSync(`${fixtures}/${clip.file}`);
    await context.route(`**/__voice-fixture/${clip.file}`, (route) =>
      route.fulfill({ body: wav, contentType: "audio/wav" }),
    );
  }
  await context.addInitScript(
    (files: string[]) => {
      const state: {
        play?: (file: string, seconds?: number) => Promise<number>;
      } = {};
      Object.assign(window, { voiceFixture: state });
      // The synthetic microphone's own audio context starts inside a trusted press, as engines with
      // autoplay rules require; real capture is exempt, a synthetic stream is not.
      let fixture: AudioContext | null = null;
      const bytes = Object.fromEntries(
        files.map((file) => [
          file,
          fetch(`/__voice-fixture/${file}`).then((r) => r.arrayBuffer()),
        ]),
      );
      const startFixture = () => {
        fixture ??= new AudioContext();
        void fixture.resume();
      };
      document.addEventListener("pointerdown", startFixture, { capture: true });
      document.addEventListener("keydown", startFixture, { capture: true });
      // Redefined rather than assigned: WebKit doesn't let a page assign over its own method.
      const getUserMedia = async () => {
        const context = (fixture ??= new AudioContext());
        const destination = context.createMediaStreamDestination();
        state.play = async (file, seconds) => {
          const audio = await context.decodeAudioData(
            (await bytes[file]!).slice(0),
          );
          return new Promise((resolve) => {
            const source = context.createBufferSource();
            source.buffer = audio;
            source.connect(destination);
            source.onended = () => resolve(performance.now());
            source.start();
            if (seconds !== undefined)
              source.stop(context.currentTime + seconds);
          });
        };
        return destination.stream;
      };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        get: () => ({ getUserMedia }),
      });
    },
    clips.map((clip) => clip.file),
  );
}

/** Play a clip into the synthetic microphone and wait until it has played. */
function play(page: Page, file: string, seconds?: number): Promise<number> {
  return page.evaluate(
    ([name, length]) =>
      (
        window as unknown as {
          voiceFixture: {
            play(file: string, seconds?: number): Promise<number>;
          };
        }
      ).voiceFixture.play(name as string, length as number | undefined),
    [file, seconds] as const,
  );
}

/** Record when the release happens and when the transcript lands in the draft, on the page clock. */
function watchInsertion(page: Page): Promise<void> {
  return page.evaluate(() => {
    const field = document.getElementById(
      "chat-message",
    ) as HTMLTextAreaElement;
    const button = document.querySelector(".voice-button")!;
    const timing: { releasedAt?: number; insertedAt?: number } = {};
    Object.assign(window, { voiceTiming: timing });
    // One clock for both ends: the page's performance clock at the release handler and at insertion.
    button.addEventListener(
      "pointerup",
      () => (timing.releasedAt = performance.now()),
      {
        capture: true,
        once: true,
      },
    );
    const start = field.value;
    const poll = () => {
      if (field.value !== start) timing.insertedAt = performance.now();
      else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

for (const clip of clips)
  for (let run = 1; run <= (clip.file === "ls_10s.wav" ? 3 : 2); run++)
    test(`streams ${clip.file} while held and inserts the final transcript (run ${run})`, async ({
      page,
      context,
      baseURL,
    }, info) => {
      test.setTimeout(150_000);
      await workspace(context, baseURL!);
      await clipMicrophone(context);
      sends.count = 0;
      const acks: { at: number; sequence: number }[] = [];
      const frames = { sent: 0 };
      const ends: string[] = [];
      const partials: string[] = [];
      const finals: string[] = [];
      const connections: string[] = [];
      page.on("websocket", (socket) => {
        // Only the voice stream counts; the dev server keeps its own reload socket.
        if (!socket.url().endsWith("/voice/stream")) return;
        connections.push(socket.url());
        socket.on("framesent", (frame) => {
          if (typeof frame.payload !== "string") frames.sent++;
          else if (
            (JSON.parse(frame.payload) as { type: string }).type === "end"
          )
            ends.push(frame.payload);
        });
        socket.on("framereceived", (frame) => {
          const message = JSON.parse(String(frame.payload)) as {
            type: string;
            sequence?: number;
            text?: string;
          };
          if (message.type === "ack")
            acks.push({ at: Date.now(), sequence: message.sequence! });
          if (message.type === "partial") partials.push(message.text!);
          if (message.type === "final") finals.push(message.text!);
        });
      });
      await page.goto(`/team/${agentId}`);
      const composer = page.getByRole("textbox", {
        name: "Message Avery",
        exact: true,
      });
      const button = page.locator(".voice-button");
      await expect(button).toBeEnabled();
      await composer.click();
      // A fresh context: the draft starts empty, so anything in it afterwards came from this run.
      await expect(composer).toHaveValue("");
      await watchInsertion(page);
      await button.hover();
      await page.mouse.down();
      await expect(page.locator("#voice-status")).toContainText(
        "Release to add your words",
      );
      await play(page, clip.file);
      const acksBeforeRelease = acks.length;
      // Still held: recording, the provisional words are in the draft, and neither end nor a final
      // has happened yet.
      await expect(page.locator("#voice-status")).toContainText(
        "Release to add your words",
      );
      expect(partials.length).toBeGreaterThan(0);
      await expect(composer).toHaveValue(partials.at(-1)!.trim());
      expect(ends).toEqual([]);
      expect(finals).toEqual([]);
      const releasedAtWall = Date.now();
      await page.mouse.up();
      await expect(composer).not.toHaveValue("", { timeout: 60_000 });
      // The watcher polls each frame; wait for both of its timestamps rather than racing it.
      await page.waitForFunction(() => {
        const timing = (
          window as unknown as {
            voiceTiming: { releasedAt?: number; insertedAt?: number };
          }
        ).voiceTiming;
        return (
          Number.isFinite(timing.releasedAt) &&
          Number.isFinite(timing.insertedAt)
        );
      });
      const timing = await page.evaluate(
        () =>
          (
            window as unknown as {
              voiceTiming: { releasedAt: number; insertedAt: number };
            }
          ).voiceTiming,
      );
      const releaseToChangeMs = timing.insertedAt - timing.releasedAt;
      expect(Number.isFinite(releaseToChangeMs)).toBe(true);
      expect(releaseToChangeMs).toBeGreaterThanOrEqual(0);
      await expect(page.locator("#voice-status")).toContainText(
        "Added your words",
        { timeout: 60_000 },
      );
      const text = await composer.inputValue();
      // One stream, one end, one final, and the draft holds exactly that final; nothing was sent.
      expect(connections).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(finals).toHaveLength(1);
      expect(text).toBe(finals[0]!.trim());
      expect(sends.count).toBe(0);
      const wer = wordErrorRate(clip.reference, text);
      const result = {
        browser: info.project.name,
        clip: clip.file,
        run,
        // The draft already held provisional words, so this is release to the first change after it.
        releaseToChangeMs: Math.round(releaseToChangeMs),
        partials: partials.length,
        framesSent: frames.sent,
        acksBeforeRelease,
        lastAckBeforeRelease:
          acks.filter((ack) => ack.at <= releasedAtWall).at(-1)?.sequence ??
          null,
        wordErrorRate: Number(wer.toFixed(3)),
        transcript: text,
      };
      await info.attach("result.json", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
      console.log(`VOICE_E2E ${JSON.stringify(result)}`);
      // Audio left the browser while held and the native service ingested it: acknowledgements
      // mean ingested and drained, not that any word was stable. Only the final is.
      expect(acksBeforeRelease).toBeGreaterThan(10);
      expect(wer).toBeLessThan(0.25);
      await expect(page.locator("#voice-status")).toContainText(
        "Added your words",
      );
    });

// ===========================================
// Live words while held
// ===========================================

test("live: provisional words appear in the composer while held, and the final replaces them once", async ({
  page,
  context,
  baseURL,
}, info) => {
  test.setTimeout(150_000);
  const { composer, traffic, status, button } = await dictationPage(
    page,
    context,
    baseURL!,
  );
  await composer.fill("Quote:");
  await composer.focus();
  // Every value the field shows, with the page clock, so the words are seen before the release.
  await page.evaluate(() => {
    const field = document.getElementById(
      "chat-message",
    ) as HTMLTextAreaElement;
    const seen: { at: number; value: string }[] = [];
    Object.assign(window, { voiceValues: seen });
    const poll = () => {
      if (seen.at(-1)?.value !== field.value)
        seen.push({ at: performance.now(), value: field.value });
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  await holdButton(page, status, button);
  const startedAt = await page.evaluate(() => performance.now());
  const endedAt = await play(page, "ls_10s.wav");
  // Still held after the whole clip: words are on screen, and no end or final has been sent.
  await expect(composer).toBeVisible();
  const held = await composer.inputValue();
  expect(held.startsWith("Quote: ")).toBe(true);
  expect(traffic.partials.length).toBeGreaterThan(3);
  expect(held).toBe(`Quote: ${traffic.partials.at(-1)!.trim()}`);
  expect(traffic.ends).toEqual([]);
  expect(traffic.finals).toEqual([]);
  const releasedAt = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await expect(status).toContainText("Added your words", { timeout: 60_000 });
  const values = await page.evaluate(
    () =>
      (window as unknown as { voiceValues: { at: number; value: string }[] })
        .voiceValues,
  );
  const shownWhileHeld = values.filter(
    (entry) => entry.at < releasedAt && entry.value !== "Quote:",
  );
  const text = await composer.inputValue();
  // The final replaced the provisional words exactly once: the draft is the prefix and the final.
  expect(traffic.ends).toHaveLength(1);
  expect(traffic.finals).toHaveLength(1);
  expect(text).toBe(`Quote: ${traffic.finals[0]!.trim()}`);
  const words = text
    .toLowerCase()
    .replace(/[^a-z' ]/g, " ")
    .trim()
    .split(/\s+/);
  expect(words.slice(-2)).toEqual(["rocky", "ithaca"]);
  for (const word of ["grave", "doubts", "ithaca"])
    expect(words.filter((each) => each === word)).toHaveLength(1);
  expect(wordErrorRate(clips[0].reference, traffic.finals[0]!)).toBeLessThan(
    0.25,
  );
  expect(sends.count).toBe(0);
  const result = {
    browser: info.project.name,
    edge: "live",
    partials: traffic.partials.length,
    distinctValuesWhileHeld: shownWhileHeld.length,
    firstWordsAfterStartMs: Math.round(shownWhileHeld[0]!.at - startedAt),
    clipEndToReleaseMs: Math.round(releasedAt - endedAt),
    heldText: held,
    finalText: text,
  };
  await info.attach("live.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  console.log(`VOICE_E2E_LIVE ${JSON.stringify(result)}`);
  expect(shownWhileHeld.length).toBeGreaterThan(3);
});

// ===========================================
// Native edge cases
// ===========================================

/** Open the conversation ready to dictate, recording the stream's traffic. */
async function dictationPage(
  page: Page,
  context: BrowserContext,
  baseURL: string,
) {
  sends.count = 0;
  await workspace(context, baseURL);
  await clipMicrophone(context);
  const traffic = {
    connections: 0,
    acks: 0,
    cancels: 0,
    ends: [] as { sequence: number; totalSamples: number }[],
    partials: [] as string[],
    finals: [] as string[],
    errors: [] as string[],
  };
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/voice/stream")) return;
    traffic.connections++;
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      const message = JSON.parse(frame.payload) as {
        type: string;
        sequence: number;
        totalSamples: number;
      };
      if (message.type === "end") traffic.ends.push(message);
      if (message.type === "cancel") traffic.cancels++;
    });
    socket.on("framereceived", (frame) => {
      const message = JSON.parse(String(frame.payload)) as {
        type: string;
        text?: string;
        code?: string;
      };
      if (message.type === "ack") traffic.acks++;
      if (message.type === "partial") traffic.partials.push(message.text!);
      if (message.type === "final") traffic.finals.push(message.text!);
      if (message.type === "error") traffic.errors.push(message.code!);
    });
  });
  await page.goto(`/team/${agentId}`);
  const composer = page.getByRole("textbox", {
    name: "Message Avery",
    exact: true,
  });
  await expect(page.locator(".voice-button")).toBeEnabled();
  await composer.click();
  await expect(composer).toHaveValue("");
  return {
    composer,
    traffic,
    status: page.locator("#voice-status"),
    button: page.locator(".voice-button"),
  };
}

/** Hold the microphone button until recording starts, retrying while the single native stream is busy. */
async function holdButton(
  page: Page,
  status: ReturnType<Page["locator"]>,
  button: ReturnType<Page["locator"]>,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await button.hover();
    await page.mouse.down();
    try {
      await expect(status).toContainText("Release to add your words", {
        timeout: 3_000,
      });
      // Ready means admitted: busy refusals arrive before ready, so wait briefly for one.
      await page.waitForTimeout(300);
      if (!(await status.textContent())?.includes("busy")) return;
    } catch {
      // Busy or not yet recovered from the previous stream.
    }
    await page.mouse.up();
    await page.waitForTimeout(1_000);
  }
  throw new Error("The speech service stayed busy");
}

test.describe("native edges", () => {
  test.setTimeout(150_000);

  test("holding Space for 1 second streams while held and adds the final at the caret", async ({
    page,
    context,
    baseURL,
  }, info) => {
    const { composer, traffic, status } = await dictationPage(
      page,
      context,
      baseURL!,
    );
    await composer.fill("Note:");
    await composer.focus();
    await page.keyboard.down(" ");
    for (
      let index = 0;
      index < 40 && !(await status.textContent())?.includes("Recording");
      index++
    ) {
      await page.waitForTimeout(100);
      await page.keyboard.down(" ");
    }
    await expect(status).toContainText("Release Space");
    // The hold's own space is gone and repeats typed nothing.
    for (let index = 0; index < 5; index++) await page.keyboard.down(" ");
    await expect(composer).toHaveValue("Note:");
    await play(page, "ls_10s.wav");
    expect(traffic.ends).toEqual([]);
    expect(traffic.finals).toEqual([]);
    await expect(composer).not.toHaveValue("Note:");
    await page.keyboard.up(" ");
    await expect(status).toContainText("Added your words", { timeout: 60_000 });
    expect(traffic.finals).toHaveLength(1);
    await expect(composer).toHaveValue(`Note: ${traffic.finals[0]!.trim()}`);
    expect(wordErrorRate(clips[0].reference, traffic.finals[0]!)).toBeLessThan(
      0.25,
    );
    expect(sends.count).toBe(0);
    console.log(
      `VOICE_E2E_EDGE ${JSON.stringify({ browser: info.project.name, edge: "space-hold", acks: traffic.acks, end: traffic.ends[0] })}`,
    );
  });

  test("cancelling a stream in flight drops it, and the next stream has none of its words", async ({
    page,
    context,
    baseURL,
  }, info) => {
    const { composer, traffic, status, button } = await dictationPage(
      page,
      context,
      baseURL!,
    );
    await holdButton(page, status, button);
    await play(page, "ls_30s.wav", 5);
    await page.keyboard.press("Escape");
    await expect(status).toContainText("Recording canceled");
    await page.mouse.up();
    await page.waitForTimeout(1_000);
    expect(traffic.finals).toEqual([]);
    expect(traffic.cancels).toBeGreaterThanOrEqual(1);
    await expect(composer).toHaveValue("");
    // The native service holds its single stream until the cancelled work is quiescent; retry while busy.
    await holdButton(page, status, button);
    await play(page, "ls_10s.wav");
    await page.mouse.up();
    await expect(status).toContainText("Added your words", { timeout: 60_000 });
    const text = await composer.inputValue();
    expect(text).toBe(traffic.finals.at(-1)!.trim());
    expect(text.toLowerCase()).toContain("ithaca");
    expect(text.toLowerCase()).not.toMatch(/pictures|guards|linnell|lynnell/);
    expect(sends.count).toBe(0);
    console.log(
      `VOICE_E2E_EDGE ${JSON.stringify({ browser: info.project.name, edge: "cancel-then-new", connections: traffic.connections, errors: traffic.errors })}`,
    );
  });

  test("releasing without speech ends the stream with an empty final and changes nothing", async ({
    page,
    context,
    baseURL,
  }, info) => {
    const { composer, traffic, status, button } = await dictationPage(
      page,
      context,
      baseURL!,
    );
    await holdButton(page, status, button);
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect(status).toContainText("No speech was recognized", {
      timeout: 30_000,
    });
    expect(traffic.ends).toHaveLength(1);
    expect(traffic.finals).toEqual([""]);
    await expect(composer).toHaveValue("");
    console.log(
      `VOICE_E2E_EDGE ${JSON.stringify({ browser: info.project.name, edge: "no-speech", end: traffic.ends[0] })}`,
    );
  });

  test("releasing mid-sentence flushes the last packet and returns the words so far", async ({
    page,
    context,
    baseURL,
  }, info) => {
    const { composer, traffic, status, button } = await dictationPage(
      page,
      context,
      baseURL!,
    );
    await holdButton(page, status, button);
    await play(page, "ls_10s.wav", 3);
    await page.mouse.up();
    await expect(status).toContainText(/Added your words|No speech/, {
      timeout: 30_000,
    });
    expect(traffic.ends).toHaveLength(1);
    expect(traffic.finals).toHaveLength(1);
    const text = await composer.inputValue();
    expect(text).toBe(traffic.finals[0]!.trim());
    expect(text.toLowerCase()).toMatch(/grave|doubts/);
    expect(text.toLowerCase()).not.toContain("ithaca");
    console.log(
      `VOICE_E2E_EDGE ${JSON.stringify({ browser: info.project.name, edge: "mid-sentence", end: traffic.ends[0], text })}`,
    );
  });

  test("the one-minute limit stops recording by itself and still returns the final", async ({
    page,
    context,
    baseURL,
  }, info) => {
    const { composer, traffic, status, button } = await dictationPage(
      page,
      context,
      baseURL!,
    );
    await holdButton(page, status, button);
    await play(page, "ls_30s.wav");
    await play(page, "ls_30s.wav");
    await expect(status).toContainText(/1-minute limit|Added your words/, {
      timeout: 20_000,
    });
    await expect(status).toContainText("Added your words", { timeout: 60_000 });
    await page.mouse.up();
    expect(traffic.ends).toHaveLength(1);
    const end = traffic.ends[0]!;
    expect(end.totalSamples).toBeLessThanOrEqual(960_000);
    expect(end.totalSamples).toBeGreaterThan(58 * 16_000);
    expect(traffic.finals).toHaveLength(1);
    await expect(composer).toHaveValue(traffic.finals[0]!.trim());
    console.log(
      `VOICE_E2E_EDGE ${JSON.stringify({ browser: info.project.name, edge: "limit", end })}`,
    );
  });
});
