import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { setConversationDetails } from "../../conversation/fixture/conversation-details.js";

interface Message {
  id: string;
  agentId: string;
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
    feedFetches: 0,
    seenFetches: 0,
    failSeenPages: false,
    /** Deliver public conversation content for the selected teammate into the mock API. */
    append(
      text: string,
      role: Message["role"] = "assistant",
      agentId = "avery",
    ) {
      const message: Message = {
        id: randomUUID(),
        agentId,
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
  // The sidebar reads the saved teammate order; an empty one keeps creation order.
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({
      json: {
        agents: ["Avery", "Blake", "Casey"].map((name) => ({
          id: name.toLowerCase(),
          name,
          avatarId: "avatar-03",
          systemPrompt: "Help with planning",
          createdAt: "2026-10-14T10:00:00Z",
          inference: {
            provider: "openai-compatible",
            model: "test-model",
            effort: "high",
          },
        })),
      },
    }),
  );
  await context.route("**/v1/agents/*/runtime", (route) =>
    route.fulfill({
      json: {
        status: "running",
        compacting: false,
        compactionStartedAt: null,
        typing: false,
        backgroundCount: 0,
        sessionId: null,
        runId: null,
        error: null,
      },
    }),
  );
  await context.route(
    /\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/,
    async (route) => {
      state.historyFetches++;
      if (state.failHistory) return route.fulfill({ status: 503, json: {} });
      const url = new URL(route.request().url());
      const agentId = url.pathname.split("/")[3];
      const history = state.messages.filter(
        (message) => message.agentId === agentId,
      );
      const cursor = url.searchParams.get("before");
      const end = cursor
        ? history.findIndex((message) => message.id === cursor)
        : history.length;
      const start = Math.max(0, end - 100);
      const messages = history.slice(start, end);
      return route.fulfill({
        json: { messages, nextCursor: start > 0 ? messages[0]!.id : null },
      });
    },
  );
  await context.route("**/v1/agents/*/messages/read", (route) => {
    const { messageIds } = route.request().postDataJSON() as {
      messageIds: string[];
    };
    state.receipts.push(messageIds);
    if (state.failReceipts) return route.fulfill({ status: 503, json: {} });
    const agentId = new URL(route.request().url()).pathname.split("/")[3];
    state.messages
      .filter(
        (message) =>
          message.agentId === agentId && messageIds.includes(message.id),
      )
      .forEach((message) => state.read.add(message.id));
    return route.fulfill({ status: 204 });
  });
  /** Unread teammate replies, oldest first, as the server derives updates from them. */
  const unread = () =>
    state.messages.filter(
      (message) => message.role === "assistant" && !state.read.has(message.id),
    );
  await context.route(/\/v1\/updates(?:\/seen)?(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const seen = url.pathname.endsWith("/seen");
    if (seen) state.seenFetches++;
    else state.feedFetches++;
    const cursor = url.searchParams.get("before");
    if ((!seen && state.failFeed) || (seen && cursor && state.failSeenPages))
      return route.fulfill({ status: 503, json: {} });
    const end = cursor
      ? state.messages.findIndex((message) => updateId(message) === cursor)
      : state.messages.length;
    const items = seen
      ? state.messages.filter(
          (message) =>
            message.role === "assistant" && state.read.has(message.id),
        )
      : unread();
    const older = items
      .filter((message) => state.messages.indexOf(message) < end)
      .reverse();
    const updates = older.slice(0, 50).map((message) => ({
      id: updateId(message),
      kind: "message",
      agentId: message.agentId,
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
  await context.route(/\/v1\/updates\/count(?:\?.*)?$/, (route) => {
    const updates = unread();
    return route.fulfill({
      json: {
        unread: updates.length,
        byAgent: Object.fromEntries(
          ["avery", "blake", "casey"]
            .map(
              (agentId) =>
                [
                  agentId,
                  updates.filter((message) => message.agentId === agentId)
                    .length,
                ] as const,
            )
            .filter(([, count]) => count > 0),
        ),
      },
    });
  });
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

test("compact caught-up card precedes muted seen history that scrolls through every page and opens old messages", async ({
  page,
  context,
}, info) => {
  const state = serverState();
  for (let index = 0; index < 105; index++) {
    const message = state.append(`Seen result ${index} is ready to revisit.`);
    state.read.add(message.id);
  }
  await workspace(context, state);
  await page.goto("/updates");
  const caughtUp = page.locator(".updates-caught-up");
  const history = page.getByRole("list", { name: "Seen updates" });
  const rows = history.getByRole("link");
  await expect(caughtUp).toBeVisible();
  await expect(rows).toHaveCount(50);
  const initialRequests = state.seenFetches;
  await expect(rows.first()).toContainText("Seen result 104");
  const card = await caughtUp.boundingBox();
  const row = await rows.first().boundingBox();
  const heading = await page
    .getByRole("heading", { name: "Seen", exact: true })
    .boundingBox();
  expect(card!.height).toBeLessThanOrEqual(row!.height + 30);
  expect(heading!.y - card!.y - card!.height).toBeGreaterThanOrEqual(32);
  expect(
    await rows
      .first()
      .locator(".update-summary")
      .evaluate((element) => getComputedStyle(element).color),
  ).toBe(
    await page
      .getByRole("heading", { name: "Seen", exact: true })
      .evaluate((element) => getComputedStyle(element).color),
  );
  await page.screenshot({
    path: info.outputPath("seen-history.png"),
    animations: "disabled",
  });
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(100);
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(105);
  await expect(
    page.getByRole("button", { name: "Load more updates" }),
  ).toHaveCount(0);
  expect(state.seenFetches - initialRequests).toBe(2);
  expect(state.receipts).toEqual([]);
  const links = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("href")),
  );
  expect(new Set(links).size).toBe(105);
  const oldest = state.messages[0]!;
  await rows.last().click();
  await expect(page).toHaveURL(
    new RegExp(`/team/avery\\?message=${oldest.id}$`),
  );
  await expect(page.locator(".update-target")).toContainText(oldest.text);
  await expect(page.locator(".update-target")).toBeInViewport();
  expect(state.historyFetches).toBeGreaterThan(1);
});

test("seen pagination failures retain cards and retry, and reading an unread update moves it into history", async ({
  page,
  context,
}) => {
  const state = serverState();
  for (let index = 0; index < 55; index++) {
    const message = state.append(`Earlier seen result ${index}.`);
    state.read.add(message.id);
  }
  const newest = state.append("This new result still needs attention.");
  state.failSeenPages = true;
  await workspace(context, state);
  await page.goto("/updates?theme=daylight");
  const unread = page.getByRole("list", { name: "Unread updates" });
  const seen = page.getByRole("list", { name: "Seen updates" });
  await expect(unread.getByRole("link")).toHaveCount(1);
  await expect(seen.getByRole("link")).toHaveCount(50);
  await seen.getByRole("link").last().scrollIntoViewIfNeeded();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn’t load older updates. Try again.",
  );
  await expect(seen.getByRole("link")).toHaveCount(50);
  const requests = state.seenFetches;
  await page.waitForTimeout(300);
  expect(state.seenFetches).toBe(requests);
  state.failSeenPages = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(seen.getByRole("link")).toHaveCount(55);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await unread.getByRole("link").click();
  await expect(page.locator(".update-target")).toContainText(newest.text);
  await expect.poll(() => state.read.has(newest.id)).toBe(true);
  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await navigation(page)
    .getByRole("link", { name: /^Updates/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
  await expect(seen.getByRole("link").first()).toContainText(newest.text);
  await expect(unread).toHaveCount(0);
});

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

test("teammate badges include every unread page and refresh independently on desktop and phones", async ({
  page,
  context,
}, info) => {
  const state = serverState();
  for (let index = 0; index < 105; index++)
    state.append(`Avery result ${index}`);
  state.append("Blake's first result", "assistant", "blake");
  state.append("Blake's second result", "assistant", "blake");
  state.append("Casey's request", "user", "casey");
  await workspace(context, state);
  await page.goto("/updates");
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(50);
  await expect(
    navigation(page).getByRole("link", {
      name: "Updates, 107 unread",
      exact: true,
    }),
  ).toContainText("99+");
  await navigation(page)
    .getByRole("link", { name: /^(Your team|Team)$/ })
    .click();
  const avery = page.locator('.agent-open[href="/team/avery"]');
  const blake = page.locator('.agent-open[href="/team/blake"]');
  const casey = page.locator('.agent-open[href="/team/casey"]');
  await expect(avery).toHaveAccessibleName("Chat with Avery, 105 unread");
  await expect(avery.locator(".update-count-badge")).toHaveText("99+");
  await expect(blake).toHaveAccessibleName("Chat with Blake, 2 unread");
  await expect(blake.locator(".update-count-badge")).toHaveText("2");
  await expect(casey).toHaveAccessibleName("Chat with Casey");
  await expect(casey.locator(".update-count-badge")).toHaveCount(0);
  if (info.project.name === "desktop") {
    await expect(
      page.locator('.side-agent[href="/team/avery"]'),
    ).toHaveAccessibleName("Avery, 105 unread");
    await expect(
      page.locator('.side-agent[href="/team/avery"] .update-count-badge'),
    ).toHaveText("99+");
    await expect(
      page.locator('.side-agent[href="/team/blake"] .update-count-badge'),
    ).toHaveText("2");
    await expect(
      page.locator('.side-agent[href="/team/casey"] .update-count-badge'),
    ).toHaveCount(0);
  }
  await settled(page.locator(".route-content"));
  await page.screenshot({
    path: info.outputPath("teammate-update-counts.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // A receipt in another client clears only Avery while new delivery increases Blake's count.
  state.messages
    .filter((message) => message.agentId === "avery")
    .forEach((message) => state.read.add(message.id));
  state.append("Blake's latest result", "assistant", "blake");
  await expect(avery).toHaveAccessibleName("Chat with Avery", {
    timeout: 10_000,
  });
  await expect(avery.locator(".update-count-badge")).toHaveCount(0);
  await expect(blake).toHaveAccessibleName("Chat with Blake, 3 unread");
  await expect(blake.locator(".update-count-badge")).toHaveText("3");
  await expect(
    navigation(page).getByRole("link", {
      name: "Updates, 3 unread",
      exact: true,
    }),
  ).toBeVisible();
  if (info.project.name === "desktop") {
    await expect(
      page.locator('.side-agent[href="/team/avery"] .update-count-badge'),
    ).toHaveCount(0);
    await expect(
      page.locator('.side-agent[href="/team/blake"]'),
    ).toHaveAccessibleName("Blake, 3 unread");
  }
});

test("reading a teammate clears its badges while other teammates stay unread", async ({
  page,
  context,
}) => {
  const state = serverState();
  const first = state.append("Avery's first reply");
  const second = state.append("Avery's second reply");
  const other = state.append("Blake's reply", "assistant", "blake");
  await workspace(context, state);
  await page.goto("/team");
  await page
    .getByRole("link", { name: "Chat with Avery, 2 unread", exact: true })
    .click();
  await expect.poll(() => state.read.has(second.id)).toBe(true);
  // Make the earlier reply visible even when the viewport cannot fit both replies.
  await page.getByText(first.text, { exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(() => state.read.has(first.id)).toBe(true);
  expect(state.read.has(other.id)).toBe(false);
  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await expect(
    navigation(page).getByRole("link", {
      name: "Updates, 1 unread",
      exact: true,
    }),
  ).toBeVisible();
  await navigation(page)
    .getByRole("link", { name: /^(Your team|Team)$/ })
    .click();
  await expect(
    page
      .getByRole("link", { name: "Chat with Avery", exact: true })
      .locator(".update-count-badge"),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Chat with Blake, 1 unread", exact: true })
    .click();
  await expect.poll(() => state.read.has(other.id)).toBe(true);
  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await expect(
    navigation(page)
      .getByRole("link", { name: "Updates", exact: true })
      .locator(".update-count-badge"),
  ).toHaveCount(0);
  await navigation(page)
    .getByRole("link", { name: /^(Your team|Team)$/ })
    .click();
  await expect(page.locator(".agent-card .update-count-badge")).toHaveCount(0);
  await expect(page.locator(".side-agent .update-count-badge")).toHaveCount(0);
});

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
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(1);
  expect(state.read.has(away.id)).toBe(false);
  await page.screenshot({
    path: info.outputPath("updates.png"),
    fullPage: true,
  });
  await page.goto("/");
  await expect(page.getByText(away.text, { exact: true })).toBeVisible();
  await page
    .getByRole("list", { name: "Unread updates" })
    .locator(".update-row")
    .click();
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
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toContainText(newest.text);
});

test("open chats receive unfocused and hidden replies, retry receipts, and keep other teammates unread", async ({
  page,
  context,
}) => {
  const state = serverState();
  await workspace(context, state);
  await page.goto("/team/avery");
  await expect(page.getByRole("log")).toBeAttached();
  await attention(page, true, false);
  state.failReceipts = true;
  const unfocused = state.append(
    "An open chat receives this even when another window has focus.",
  );
  const other = state.append(
    "Blake still needs your attention.",
    "assistant",
    "blake",
  );
  await expect(page.getByText(unfocused.text, { exact: true })).toBeAttached();
  await expect(page.getByText(/Read status couldn’t be saved/)).toBeVisible();
  expect(state.read.has(unfocused.id)).toBe(false);
  // Even while a receipt is retrying, only other teammates contribute to navigation badges.
  await expect(
    page.locator('.sidebar .nav-item[href="/updates"]'),
  ).toHaveAttribute("aria-label", "Updates, 1 unread", { timeout: 10_000 });
  await expect(
    page.locator('.side-agent[href="/team/avery"] .update-count-badge'),
  ).toHaveCount(0);
  await expect(
    page.locator('.side-agent[href="/team/blake"] .update-count-badge'),
  ).toHaveText("1");
  state.failReceipts = false;
  await expect
    .poll(() => state.read.has(unfocused.id), { timeout: 10_000 })
    .toBe(true);
  await attention(page, false, false);
  const fetchedBefore = state.historyFetches;
  const hidden = state.append(
    "An open chat also receives replies in a background tab.",
  );
  await expect.poll(() => state.historyFetches).toBeGreaterThan(fetchedBefore);
  await expect(page.getByText(hidden.text, { exact: true })).toBeAttached();
  await expect.poll(() => state.read.has(hidden.id)).toBe(true);
  expect(state.read.has(other.id)).toBe(false);
  await attention(page, true, true);
  await page.goto("/updates");
  await page.reload();
  await expect(
    page.getByRole("list", { name: "Unread updates" }).getByRole("link"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("list", { name: "Unread updates" }),
  ).toContainText(other.text);
  await page.getByText(other.text, { exact: true }).click();
  await expect.poll(() => state.read.has(other.id)).toBe(true);
  const away = state.append(
    "Avery should notify again after switching to Blake.",
  );
  await page.goto("/updates");
  await expect(
    page.getByRole("list", { name: "Unread updates" }),
  ).toContainText(away.text);
  expect(state.read.has(away.id)).toBe(false);
});

test("new replies in the open chat are received while scrolled up or behind a dialog", async ({
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
  await expect.poll(() => state.read.has(reply.id)).toBe(true);
  expect(
    await page
      .locator(".chat-history")
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await page.locator(".chat-history").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => state.read.has(reply.id)).toBe(true);
  // A real workspace dialog obscures the conversation while polling continues underneath it.
  await setConversationDetails(page, true);
  await page.getByRole("button", { name: "Edit Avery", exact: true }).click();
  const behindDialog = state.append(
    "The chat is still open while you edit this teammate.",
  );
  await expect(
    page.getByText(behindDialog.text, { exact: true }),
  ).toBeAttached();
  await expect.poll(() => state.read.has(behindDialog.id)).toBe(true);
  await page.keyboard.press("Escape");
  await setConversationDetails(page, false);
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
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(50);
  await page
    .getByRole("list", { name: "Unread updates" })
    .locator(".update-row")
    .last()
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(55);
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
    await expect(
      page
        .getByRole("list", { name: "Unread updates" })
        .getByText(latest.text, { exact: true }),
    ).toHaveCount(0, {
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
    await expect(
      page
        .getByRole("list", { name: "Unread updates" })
        .locator(".update-row")
        .first(),
    ).toBeVisible();
    state.failHistory = true;
    await page
      .getByRole("list", { name: "Unread updates" })
      .locator(".update-row")
      .first()
      .click();
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
    "This new reply is received while reviewing the old message.",
  );
  await attention(page, true, true);
  await expect(page.getByText(unread.text, { exact: true })).toBeAttached();
  await expect(page.locator(".update-target")).toBeInViewport();
  await expect.poll(() => state.read.has(unread.id)).toBe(true);
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

test("live long replies are received immediately while older replies still require seeing their beginning or end", async ({
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

  // Replies delivered after leaving the chat keep the historical exposure policy.
  await page.goto("/team");
  const reply = state.append(longReply("second report"));
  await page.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
  });
  await page.goto("/team/avery");
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
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(2);
  await expect(
    page
      .getByRole("list", { name: "Unread updates" })
      .getByText(first.summary, { exact: true }),
  ).toHaveCount(0);
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
  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
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
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(8);
  await settled(page.locator(".route-content"));
  expect((await layout()).documentScrolls).toBe(false);
  for (const theme of ["midnight", "daylight"]) {
    await page.goto(`/updates?theme=${theme}`);
    await expect(
      page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
    ).toHaveCount(50);
    await settled(page.locator(".route-content"));
    expect(await layout()).toEqual({
      documentScrolls: false,
      contentScrolls: true,
    });
    await content.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    await expect(
      page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
    ).toHaveCount(55);
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
  await page
    .getByRole("list", { name: "Unread updates" })
    .locator(".update-row")
    .last()
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("list", { name: "Unread updates" }).locator(".update-row"),
  ).toHaveCount(55);
  expect((await layout()).documentScrolls).toBe(false);
});
