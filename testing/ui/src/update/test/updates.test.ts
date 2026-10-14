import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  summary?: string;
  summaryStatus?: "pending" | "ready" | "unavailable";
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
  await context.route(/\/v1\/updates(?:\?.*)?$/, (route) => {
    state.feedFetches++;
    if (state.failFeed) return route.fulfill({ status: 503, json: {} });
    const cursor = new URL(route.request().url()).searchParams.get("before");
    const end = cursor
      ? state.messages.findIndex((message) => message.id === cursor)
      : state.messages.length;
    const unread = state.messages
      .slice(0, end)
      .filter(
        (message) =>
          message.role === "assistant" && !state.read.has(message.id),
      )
      .reverse();
    const updates = unread.slice(0, 50).map((message) => ({
      messageId: message.id,
      agentId: "avery",
      summary: message.summary ?? message.text,
      summaryStatus: message.summaryStatus ?? "ready",
      createdAt: message.createdAt,
    }));
    return route.fulfill({
      json: {
        updates,
        nextCursor: unread.length > 50 ? updates.at(-1)!.messageId : null,
      },
    });
  });
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
  await page.screenshot({
    path: info.outputPath("original-message.png"),
    fullPage: true,
  });
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
  await expect(
    page.getByText("Preparing summary · Message preview", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Summary unavailable · Message preview", { exact: true }),
  ).toBeVisible();
  expect(state.read.size).toBe(0);
  // The provider response is controlled test data; the real inference adapter is verified by API tests.
  first.summary =
    "Twelve build checks passed. Review the rollout date and beta-group scope before publication.";
  first.summaryStatus = "ready";
  await expect(page.getByText(first.summary, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("AI summary", { exact: true })).toHaveCount(2);
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
