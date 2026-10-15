import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  summary?: string;
  summaryStatus?: "pending" | "ready" | "unavailable";
}

/** Update IDs differ from message IDs, so the UI must key and page by one and link by the other. */
function updateId(message: Message): string {
  return `update-${message.id}`;
}

/** Model persistent server state separately from browser contexts, with controllable delivery and failures. */
function serverState() {
  return {
    messages: [] as Message[],
    read: new Set<string>(),
    receipts: [] as string[][],
    failReceipts: false,
    failHistory: false,
    failFeed: false,
    historyFetches: 0,
    historyDelay: undefined as Promise<void> | undefined,
    feedFetches: 0,
    /** Deliver only public conversation content into the mock API. */
    append(text: string, role: Message["role"] = "assistant") {
      const message: Message = {
        id: randomUUID(),
        role,
        text,
        createdAt: new Date().toISOString(),
      };
      this.messages.push(message);
      return message;
    },
  };
}

/** Use the production UI and HTTP client against an owner-specific, durable test API. */
async function workspace(
  context: BrowserContext,
  state: ReturnType<typeof serverState>,
) {
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: { subject: "updates-owner", displayName: "Updates owner" },
      },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "avery",
            name: "Avery",
            avatarId: "avatar-03",
            systemPrompt: "Help with planning",
            createdAt: "2026-10-14T10:00:00Z",
            inference: {
              provider: "openai-compatible",
              model: "test-model",
              effort: "high",
            },
          },
        ],
      },
    }),
  );
  await context.route("**/v1/agents/avery/runtime", (route) =>
    route.fulfill({
      json: {
        status: "running",
        compacting: false,
        typing: false,
        backgroundCount: 0,
        sessionId: null,
        runId: null,
        error: null,
      },
    }),
  );
  await context.route(
    /\/v1\/agents\/avery\/messages(?:\?.*)?$/,
    async (route) => {
      state.historyFetches++;
      if (state.failHistory) return route.fulfill({ status: 503, json: {} });
      const cursor = new URL(route.request().url()).searchParams.get("before");
      const end = cursor
        ? state.messages.findIndex((message) => message.id === cursor)
        : state.messages.length;
      const start = Math.max(0, end - 100);
      const messages = state.messages.slice(start, end);
      await state.historyDelay;
      return route.fulfill({
        json: { messages, nextCursor: start > 0 ? messages[0]!.id : null },
      });
    },
  );
  await context.route("**/v1/agents/avery/messages/read", (route) => {
    const { messageIds } = route.request().postDataJSON() as {
      messageIds: string[];
    };
    state.receipts.push(messageIds);
    if (state.failReceipts) return route.fulfill({ status: 503, json: {} });
    messageIds.forEach((id) => state.read.add(id));
    return route.fulfill({ status: 204 });
  });
  /** Unread teammate replies, oldest first, as the server derives updates from them. */
  const unread = () =>
    state.messages.filter(
      (message) => message.role === "assistant" && !state.read.has(message.id),
    );
  await context.route(/\/v1\/updates(?:\?.*)?$/, (route) => {
    state.feedFetches++;
    if (state.failFeed) return route.fulfill({ status: 503, json: {} });
    const cursor = new URL(route.request().url()).searchParams.get("before");
    const end = cursor
      ? state.messages.findIndex((message) => updateId(message) === cursor)
      : state.messages.length;
    const older = unread()
      .filter((message) => state.messages.indexOf(message) < end)
      .reverse();
    const updates = older.slice(0, 50).map((message) => ({
      id: updateId(message),
      kind: "message",
      agentId: "avery",
      messageId: message.id,
      summary: message.summary ?? message.text,
      summaryStatus: message.summaryStatus ?? "ready",
      createdAt: message.createdAt,
    }));
    return route.fulfill({
      json: {
        updates,
        nextCursor: older.length > 50 ? updates.at(-1)!.id : null,
      },
    });
  });
  await context.route(/\/v1\/updates\/count(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { unread: unread().length } }),
  );
}

/** The workspace navigation for the current viewport: the sidebar, or the bottom bar on phones. */
function navigation(page: Page) {
  return page.getByRole("navigation", {
    name:
      (page.viewportSize()?.width ?? 1000) < 650
        ? "Mobile workspace"
        : "Workspace",
    exact: true,
  });
}

/** Wait for an element's transitions, such as the route's, whose transform would otherwise hide layout overflow. */
async function settled(element: Locator) {
  await element.evaluate((target) =>
    Promise.all(target.getAnimations().map((animation) => animation.finished)),
  );
}

/** Headless tabs do not emulate OS attention consistently; send the same document events explicitly. */
async function attention(page: Page, visible: boolean, focused: boolean) {
  await page.evaluate(
    ({ visible, focused }) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (visible ? "visible" : "hidden"),
      });
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => focused,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event(focused ? "focus" : "blur"));
    },
    { visible, focused },
  );
}

test("looking acknowledges delivery; away messages populate Home and Updates without fetch side effects", async ({
  page,
  context,
}, info) => {
  const state = serverState();
  await workspace(context, state);
  await page.goto("/team/avery");
  await expect(page.getByRole("log")).toBeAttached();
  const seen = state.append(
    "The build passed all 12 checks. The preview is ready.",
  );
  await expect(page.getByText(seen.text, { exact: true })).toBeVisible();
  await expect.poll(() => state.read.has(seen.id)).toBe(true);
  await page.goto("/updates");
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
  const away = state.append(
    "The release notes are ready. Please review the two open questions.",
  );
  await expect(page.getByText(away.text, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(() => state.feedFetches).toBeGreaterThan(2);
  expect(state.read.has(away.id)).toBe(false);
  await page.reload();
  await expect(page.getByText(away.text, { exact: true })).toBeVisible();
  await expect(page.locator(".update-row")).toHaveCount(1);
  expect(state.read.has(away.id)).toBe(false);
  await page.screenshot({
    path: info.outputPath("updates.png"),
    fullPage: true,
  });
  await page.goto("/");
  await expect(page.getByText(away.text, { exact: true })).toBeVisible();
  await page.locator(".update-row").click();
  await expect(page.locator(".update-target")).toContainText(away.text);
  await expect.poll(() => state.read.has(away.id)).toBe(true);
  await page.goto("/updates");
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
});

test("old update links load earlier history, highlight the exact message, and survive reloads", async ({
  page,
  context,
}, info) => {
  const state = serverState();
  const target = state.append("An early decision still needs your approval.");
  for (let index = 0; index < 205; index++)
    state.append(`Saved input ${index}`, "user");
  const newest = state.append(
    "A newer unread message should stay unread while reviewing the old one.",
  );
  await workspace(context, state);
  await page.goto("/updates");
  await page.getByText(target.text, { exact: true }).click();
  await expect(page.locator(".update-target")).toContainText(target.text);
  await expect(page.locator(".update-target")).toBeInViewport();
  await expect.poll(() => state.read.has(target.id)).toBe(true);
  expect(state.read.has(newest.id)).toBe(false);
  // A soft, rounded tint instead of a square outline.
  const highlight = page.locator(".update-target");
  await settled(highlight);
  const style = await highlight.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      radius: parseFloat(computed.borderTopLeftRadius),
      outline: computed.outlineStyle,
      background: computed.backgroundColor,
      shadow: computed.boxShadow,
    };
  });
  expect(style.radius).toBeGreaterThan(0);
  expect(style.outline).toBe("none");
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.shadow).not.toBe("none");
  await page.screenshot({ path: info.outputPath("highlight-dark.png") });
  await page.goto(`${page.url()}&theme=daylight`);
  await expect(highlight).toBeInViewport();
  await settled(highlight);
  await page.screenshot({ path: info.outputPath("highlight-light.png") });
  await page.reload();
  await expect(page.locator(".update-target")).toBeInViewport();
  expect(state.read.has(newest.id)).toBe(false);
  await page.goto("/updates");
  await expect(page.locator(".update-row")).toHaveCount(1);
  await expect(page.locator(".update-row")).toContainText(newest.text);
});

test("hidden and unfocused tabs never acknowledge fetched messages; returning and receipt retries persist", async ({
  page,
  context,
}) => {
  const state = serverState();
  await workspace(context, state);
  await page.goto("/team/avery");
  await expect(page.getByRole("log")).toBeAttached();
  await attention(page, true, false);
  const unfocused = state.append(
    "A background window must not consume this message.",
  );
  await expect(page.getByText(unfocused.text, { exact: true })).toBeAttached();
  await page.waitForTimeout(1500);
  expect(state.read.has(unfocused.id)).toBe(false);
  let releaseHistory!: () => void;
  state.historyDelay = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const fetchedBefore = state.historyFetches;
  const hidden = state.append("A hidden tab must retain this update.");
  await expect.poll(() => state.historyFetches).toBeGreaterThan(fetchedBefore);
  await attention(page, false, true);
  releaseHistory();
  state.historyDelay = undefined;
  await expect(page.getByText(hidden.text, { exact: true })).toBeAttached();
  await page.waitForTimeout(1500);
  expect(state.read.size).toBe(0);
  state.failReceipts = true;
  await attention(page, true, true);
  await expect(page.getByText(hidden.text, { exact: true })).toBeVisible();
  await expect(page.getByText(/Read status couldn’t be saved/)).toBeVisible();
  expect(state.read.size).toBe(0);
  state.failReceipts = false;
  await expect
    .poll(() => state.read.has(hidden.id), { timeout: 10_000 })
    .toBe(true);
  // On short viewports the earlier message may have scrolled away; it counts once seen again.
  await page
    .getByText(unfocused.text, { exact: true })
    .scrollIntoViewIfNeeded();
  await expect.poll(() => state.read.has(unfocused.id)).toBe(true);
  await page.reload();
  await page.goto("/updates");
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
});

test("scrolling away and open dialogs preserve unread delivery", async ({
  page,
  context,
}) => {
  const state = serverState();
  for (let index = 0; index < 35; index++)
    state.append(`Saved input ${index}`, "user");
  await workspace(context, state);
  await page.goto("/team/avery");
  await expect(page.getByRole("log").getByRole("article")).toHaveCount(35);
  await page.locator(".chat-history").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const reply = state.append(
    "You were reading earlier history when this arrived.",
  );
  await expect(page.getByText(reply.text, { exact: true })).toBeAttached();
  await page.waitForTimeout(1500);
  expect(state.read.has(reply.id)).toBe(false);
  await page.locator(".chat-history").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => state.read.has(reply.id)).toBe(true);
  // A real workspace dialog obscures the conversation while polling continues underneath it.
  await page.getByRole("button", { name: "Edit Avery", exact: true }).click();
  const behindDialog = state.append(
    "This should wait until the dialog closes.",
  );
  await expect(
    page.getByText(behindDialog.text, { exact: true }),
  ).toBeAttached();
  await page.waitForTimeout(1500);
  expect(state.read.has(behindDialog.id)).toBe(false);
  await page.keyboard.press("Escape");
  await expect.poll(() => state.read.has(behindDialog.id)).toBe(true);
});

test("another client observes durable receipts, feed pagination stays deduplicated, and reconnect failures can retry", async ({
  page,
  context,
  browser,
}) => {
  const state = serverState();
  for (let index = 0; index < 55; index++)
    state.append(`Unread result ${index}`);
  await workspace(context, state);
  await page.goto("/updates");
  await expect(page.locator(".update-row")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more updates" }).click();
  await expect(page.locator(".update-row")).toHaveCount(55);
  expect(state.read.size).toBe(0);
  const secondContext = await browser.newContext();
  try {
    await workspace(secondContext, state);
    const other = await secondContext.newPage();
    await other.goto(new URL("/updates", page.url()).href);
    const latest = state.messages.at(-1)!;
    await other.getByText(latest.text, { exact: true }).click();
    await expect.poll(() => state.read.has(latest.id)).toBe(true);
    await page.bringToFront();
    await expect(page.getByText(latest.text, { exact: true })).toHaveCount(0, {
      timeout: 10_000,
    });
    const ids = await page
      .locator(".update-row")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(new Set(ids).size).toBe(ids.length);
    state.failFeed = true;
    await page.reload();
    await expect(page.getByRole("alert")).toBeVisible();
    state.failFeed = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".update-row").first()).toBeVisible();
    state.failHistory = true;
    await page.locator(".update-row").first().click();
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await expect(
      page.getByText("This message is no longer available.", { exact: true }),
    ).toHaveCount(0);
    const receipts = state.receipts.length;
    await page.waitForTimeout(1000);
    expect(state.receipts.length).toBe(receipts);
    state.failHistory = false;
    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page.locator(".update-target")).toBeInViewport();
  } finally {
    await secondContext.close();
  }
});

test("an old update stays in view after reconnecting across more than one history page", async ({
  page,
  context,
}) => {
  const state = serverState();
  for (let index = 0; index < 80; index++)
    state.append(`Earlier input ${index}`, "user");
  const target = state.append(
    "Keep this original decision in view while catching up.",
  );
  for (let index = 0; index < 125; index++)
    state.append(`Saved input ${index}`, "user");
  await workspace(context, state);
  await page.goto("/updates");
  await page.getByText(target.text, { exact: true }).click();
  await expect(page.locator(".update-target")).toBeInViewport();
  await expect.poll(() => state.read.has(target.id)).toBe(true);
  await attention(page, false, false);
  for (let index = 0; index < 110; index++)
    state.append(`Arrived while away ${index}`, "user");
  const unread = state.append(
    "This new reply should remain unread while reviewing the old message.",
  );
  await attention(page, true, true);
  await expect(page.getByText(unread.text, { exact: true })).toBeAttached();
  await expect(page.locator(".update-target")).toBeInViewport();
  await page.waitForTimeout(1500);
  expect(state.read.has(unread.id)).toBe(false);
});

test("oversized update links open at the beginning and keep that alignment on reload", async ({
  page,
  context,
}) => {
  const state = serverState();
  for (let index = 0; index < 20; index++)
    state.append(`Earlier input ${index}`, "user");
  const target = state.append(
    "## Beginning of the report\n\n" +
      "This report contains detailed findings that need careful review.\n\n".repeat(
        60,
      ) +
      "End of the report.",
  );
  target.summary = "A detailed report is ready for review.";
  for (let index = 0; index < 125; index++)
    state.append(`Later input ${index}`, "user");
  await workspace(context, state);
  await context.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
  });
  await page.goto("/updates");
  await page.getByText(target.summary, { exact: true }).click();
  const article = page.locator(".update-target");
  /** Inspect the scroll viewport itself: CSS visibility alone accepts an offscreen beginning. */
  const beginningIsExposed = () =>
    article.evaluate((element) => {
      const viewport = element
        .closest(".chat-history")!
        .getBoundingClientRect();
      const message = element.getBoundingClientRect();
      return (
        message.height > viewport.height &&
        Math.abs(message.top - viewport.top) <= 1
      );
    });
  await expect.poll(beginningIsExposed).toBe(true);
  await page.waitForTimeout(1500);
  expect(state.read.has(target.id)).toBe(false);
  await page.reload();
  await expect(article).toBeAttached();
  await expect.poll(beginningIsExposed).toBe(true);
  await attention(page, true, true);
  await expect.poll(() => state.read.has(target.id)).toBe(true);
});

test("a long reply is read once its end or beginning is seen, but not its middle alone", async ({
  page,
  context,
}) => {
  const state = serverState();
  state.append("Please send the detailed report.", "user");
  await workspace(context, state);
  await page.goto("/team/avery");
  await expect(page.getByRole("log")).toBeAttached();
  await attention(page, true, true);
  const longReply = (label: string) =>
    `## Beginning of the ${label}\n\n` +
    "These findings take several screens to read.\n\n".repeat(60) +
    `End of the ${label}.`;

  // Following a new reply to its end while watching counts as seeing it.
  const followed = state.append(longReply("first report"));
  await expect(
    page.getByText("End of the first report.", { exact: true }),
  ).toBeInViewport();
  await expect.poll(() => state.read.has(followed.id)).toBe(true);

  // A reply delivered while unfocused stays unread while only its middle is in view.
  await attention(page, true, false);
  const reply = state.append(longReply("second report"));
  const article = page.locator(`[data-message-id="${reply.id}"]`);
  await expect(article).toBeAttached();
  await article.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await attention(page, true, true);
  await page.waitForTimeout(1500);
  expect(state.read.has(reply.id)).toBe(false);
  await article.evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  await page.waitForTimeout(300);
  await attention(page, false, false);
  await page.waitForTimeout(1500);
  expect(state.read.has(reply.id)).toBe(false);
  await attention(page, true, true);
  await expect.poll(() => state.read.has(reply.id)).toBe(true);
  await page.goto("/updates");
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
});

test("model summaries and labeled fallbacks retain source links and clear only seen messages", async ({
  page,
  context,
}, info) => {
  const state = serverState();
  const first = state.append(
    "I finished checking the build. All twelve checks passed, including the mobile layout and keyboard navigation checks. The release notes are drafted, but two questions remain before publication: the rollout date and whether to include the beta group. Please review those two questions.",
  );
  first.summaryStatus = "pending";
  for (let index = 0; index < 20; index++)
    state.append(`Earlier planning input ${index}`, "user");
  const second = state.append(
    "I compared the two onboarding flows. The shorter flow removes three steps, but the accessibility review has not finished. I need you to choose whether to wait for that review or continue with the longer flow for this release.",
  );
  second.summary =
    "Choose whether to wait for the shorter flow’s accessibility review or release the longer flow.";
  second.summaryStatus = "ready";
  const fallback = state.append(
    "The setup example uses `2 ** 3` in `__init__.py`. Please keep those identifiers unchanged.",
  );
  fallback.summaryStatus = "unavailable";
  await workspace(context, state);
  await page.goto("/updates");
  await expect(page.getByText("Summarizing…", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Message preview", { exact: true }),
  ).toBeVisible();
  expect(state.read.size).toBe(0);
  // The provider response is controlled test data; the real inference adapter is verified by API tests.
  first.summary =
    "Twelve build checks passed. Review the rollout date and beta-group scope before publication.";
  first.summaryStatus = "ready";
  await expect(page.getByText(first.summary, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  // Ready summaries need no label; only the unavailable one still reads as a preview.
  await expect(page.getByText("Summarizing…", { exact: true })).toHaveCount(0);
  await expect(page.locator(".update-label")).toHaveCount(1);
  await expect(page.locator(".update-label")).toHaveText("Message preview");
  await expect(page.getByText(first.text, { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("01-populated-summaries.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByText(first.summary, { exact: true }).click();
  await expect(page.locator(".update-target")).toContainText(first.text);
  await expect(page.locator(".update-target")).toBeInViewport();
  await expect.poll(() => state.read.has(first.id)).toBe(true);
  await page.screenshot({
    path: info.outputPath("02-original-message-seen.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto("/updates");
  await expect(page.locator(".update-row")).toHaveCount(2);
  await expect(page.getByText(first.summary, { exact: true })).toHaveCount(0);
  await expect(page.getByText(second.summary, { exact: true })).toBeVisible();
  expect(state.read.has(second.id)).toBe(false);
  expect(state.read.has(fallback.id)).toBe(false);
  await page.screenshot({
    path: info.outputPath("03-unseen-messages-remain.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("the Updates badge counts unread updates, refreshes after a receipt, and hides at zero", async ({
  page,
  context,
}, info) => {
  const state = serverState();
  state.append("An earlier result is ready.");
  state.append("A second result is ready.");
  // Keep the earlier replies out of view while the newest one is open.
  for (let index = 0; index < 40; index++)
    state.append(`Saved input ${index}`, "user");
  const newest = state.append("The newest result is ready for review.");
  await workspace(context, state);
  await page.goto("/");
  const updates = navigation(page).getByRole("link", { name: /^Updates/ });
  const badge = updates.locator(".update-count-badge");
  await expect(updates).toHaveAccessibleName("Updates, 3 unread");
  await expect(badge).toHaveText("3");
  await settled(page.locator(".route-content"));
  await navigation(page).screenshot({
    path: info.outputPath("nav-badge-dark.png"),
  });
  await page.getByText(newest.text, { exact: true }).click();
  await expect(page.locator(".update-target")).toContainText(newest.text);
  await expect.poll(() => state.read.has(newest.id)).toBe(true);
  // The receipt refreshes the count instead of waiting for the next poll.
  await expect(updates).toHaveAccessibleName("Updates, 2 unread", {
    timeout: 2_000,
  });
  await expect(badge).toHaveText("2");
  await page.goto("/updates?theme=daylight");
  for (let index = 0; index < 120; index++)
    state.append(`Another result ${index}`);
  await expect(badge).toHaveText("99+", { timeout: 10_000 });
  await expect(updates).toHaveAccessibleName("Updates, 122 unread");
  await settled(page.locator(".route-content"));
  await navigation(page).screenshot({
    path: info.outputPath("nav-badge-light.png"),
  });
  state.messages.forEach((message) => state.read.add(message.id));
  await expect(badge).toHaveCount(0, { timeout: 10_000 });
  await expect(updates).toHaveAccessibleName("Updates");
});

test("many updates scroll only the content area, keeping navigation in place", async ({
  page,
  context,
}, info) => {
  const state = serverState();
  for (let index = 0; index < 55; index++)
    state.append(
      `Result ${index} is ready. The checks passed and the preview is waiting for your review.`,
    );
  await workspace(context, state);
  const content = page.locator("#workspace-content");
  /** The document never scrolls; the routed content area is the single scroll container. */
  const layout = () =>
    content.evaluate((element) => ({
      documentScrolls:
        document.scrollingElement!.scrollHeight > window.innerHeight,
      contentScrolls: element.scrollHeight > element.clientHeight,
    }));
  await page.goto("/");
  await expect(page.locator(".update-row")).toHaveCount(8);
  await settled(page.locator(".route-content"));
  expect((await layout()).documentScrolls).toBe(false);
  for (const theme of ["midnight", "daylight"]) {
    await page.goto(`/updates?theme=${theme}`);
    await expect(page.locator(".update-row")).toHaveCount(50);
    await settled(page.locator(".route-content"));
    expect(await layout()).toEqual({
      documentScrolls: false,
      contentScrolls: true,
    });
    await content.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    await expect(
      page.getByRole("button", { name: "Load more updates" }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollTop),
    ).toBe(0);
    await expect(navigation(page)).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(
        `updates-scrolled-${theme === "midnight" ? "dark" : "light"}.png`,
      ),
    });
  }
  await page.getByRole("button", { name: "Load more updates" }).click();
  await expect(page.locator(".update-row")).toHaveCount(55);
  expect((await layout()).documentScrolls).toBe(false);
});
