import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { openWorkspaceAction } from "../../workspace/fixture/workspace-menu.js";

const subject = "notifications-owner";

interface Message {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

/** A notification the page created through the stubbed Notifications API. */
interface ShownNotification {
  title: string;
  body: string;
  tag: string;
  icon: string;
  closed: boolean;
}

/** Durable server state shared by every tab, with controllable delivery. */
function serverState() {
  return {
    messages: [] as Message[],
    read: new Set<string>(),
    feedFetches: 0,
    /** Deliver a message into the mock API. */
    append(
      text: string,
      agentId = "avery",
      role: Message["role"] = "assistant",
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

/**
 * Replace the browser's Notifications API before the app loads. The permission is kept in
 * session storage, so it survives reloads like a real browser's site permission.
 */
async function stubNotifications(
  context: BrowserContext,
  permission: NotificationPermission,
  answer: NotificationPermission,
) {
  await context.addInitScript(
    ({ permission, answer }) => {
      const key = "test-notification-permission";
      const record = {
        requests: 0,
        created: [] as Array<Record<string, unknown>>,
      };
      class FakeNotification {
        static get permission() {
          return sessionStorage.getItem(key) ?? permission;
        }
        static async requestPermission() {
          record.requests++;
          sessionStorage.setItem(key, answer);
          return answer;
        }
        onclick: (() => void) | null = null;
        closed = false;
        constructor(title: string, options: NotificationOptions = {}) {
          Object.assign(this, { title, ...options });
          record.created.push(this as unknown as Record<string, unknown>);
        }
        close() {
          this.closed = true;
        }
      }
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: FakeNotification,
      });
      Object.defineProperty(window, "testNotifications", { value: record });
    },
    { permission, answer },
  );
}

/** Turn notifications on for this device before the app loads, as an earlier visit would have. */
async function enableNotifications(context: BrowserContext) {
  await stubNotifications(context, "granted", "granted");
  await context.addInitScript((subject) => {
    localStorage.setItem(`everything-desktop-notifications:${subject}`, "on");
  }, subject);
}

/** Notifications this page created, newest last. */
function shown(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        testNotifications: { created: ShownNotification[] };
      }
    ).testNotifications.created.map(({ title, body, tag, icon, closed }) => ({
      title,
      body,
      tag,
      icon,
      closed,
    })),
  );
}

/** Click the switch's visible label, as a user does; the checkbox itself is visually hidden. */
async function toggleDesktopNotifications(page: Page) {
  await page
    .getByRole("dialog")
    .getByText("Desktop notifications", { exact: true })
    .click();
}

/** How many times this page asked for permission. */
function requests(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { testNotifications: { requests: number } })
        .testNotifications.requests,
  );
}

/** Headless tabs don't emulate OS attention; send the same document events the app listens to. */
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

/** Wait until every open tab has checked the feed a few more times. */
async function feedChecks(
  state: ReturnType<typeof serverState>,
  count: number,
) {
  const target = state.feedFetches + count;
  await expect
    .poll(() => state.feedFetches, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(target);
}

/** Serve the production UI against an owner-specific mock API. */
async function workspace(
  context: BrowserContext,
  state: ReturnType<typeof serverState>,
) {
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: { profile: { subject, displayName: "Notifications owner" } },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({
      json: {
        agents: [
          ["avery", "Avery", "avatar-03"],
          ["blake", "Blake", "avatar-07"],
        ].map(([id, name, avatarId]) => ({
          id,
          name,
          avatarId,
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
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) => {
    const agentId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      json: {
        messages: state.messages.filter(
          (message) => message.agentId === agentId,
        ),
        nextCursor: null,
      },
    });
  });
  await context.route("**/v1/agents/*/messages/read", (route) => {
    const { messageIds } = route.request().postDataJSON() as {
      messageIds: string[];
    };
    messageIds.forEach((id) => state.read.add(id));
    return route.fulfill({ status: 204 });
  });
  const unread = () =>
    state.messages.filter(
      (message) => message.role === "assistant" && !state.read.has(message.id),
    );
  await context.route(/\/v1\/updates(?:\/seen)?(?:\?.*)?$/, (route) => {
    const seen = new URL(route.request().url()).pathname.endsWith("/seen");
    if (!seen) state.feedFetches++;
    const items = seen
      ? state.messages.filter(
          (message) =>
            message.role === "assistant" && state.read.has(message.id),
        )
      : unread();
    return route.fulfill({
      json: {
        updates: [...items].reverse().map((message) => ({
          id: `update-${message.id}`,
          kind: "message",
          agentId: message.agentId,
          messageId: message.id,
          summary: message.text,
          summaryStatus: "pending",
          createdAt: message.createdAt,
        })),
        nextCursor: null,
      },
    });
  });
  await context.route(/\/v1\/updates\/count(?:\?.*)?$/, (route) => {
    const items = unread();
    const byAgent: Record<string, number> = {};
    for (const message of items)
      byAgent[message.agentId] = (byAgent[message.agentId] ?? 0) + 1;
    return route.fulfill({ json: { unread: items.length, byAgent } });
  });
}

test("turning on desktop notifications asks once from the switch and is remembered on this device", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Desktop notifications only");
  const state = serverState();
  await stubNotifications(context, "default", "granted");
  await workspace(context, state);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await requests(page)).toBe(0);
  await openWorkspaceAction(page, "Notification settings");
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("switch", { name: "Desktop notifications" });
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByRole("status")).toHaveText(
    "Your browser will ask for permission when you turn this on.",
  );
  expect(await requests(page)).toBe(0);
  await page.screenshot({ path: info.outputPath("notifications-off.png") });
  await toggleDesktopNotifications(page);
  await expect(toggle).toBeChecked();
  expect(await requests(page)).toBe(1);
  await expect(dialog.getByRole("status")).toContainText(
    "You’ll get a notification when a teammate sends you a message",
  );
  await page.screenshot({ path: info.outputPath("notifications-on.png") });
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await openWorkspaceAction(page, "Notification settings");
  await expect(toggle).toBeChecked();
  await toggleDesktopNotifications(page);
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByRole("status")).toContainText(
    "won’t send any on this device",
  );
  expect(await requests(page)).toBe(0);
  await page.reload();
  await openWorkspaceAction(page, "Notification settings");
  await expect(toggle).not.toBeChecked();
});

test("a dismissed request asks again only from the switch, and blocked notifications explain what to do", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Desktop notifications only");
  const state = serverState();
  await stubNotifications(context, "default", "default");
  await workspace(context, state);
  await page.goto("/");
  await openWorkspaceAction(page, "Notification settings");
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("switch", { name: "Desktop notifications" });
  await toggleDesktopNotifications(page);
  await expect(dialog.getByRole("alert")).toHaveText(
    "Your browser didn’t allow notifications. Turn on the switch to ask again.",
  );
  await expect(toggle).not.toBeChecked();
  expect(await requests(page)).toBe(1);

  await page.evaluate(() =>
    sessionStorage.setItem("test-notification-permission", "denied"),
  );
  await page.reload();
  await openWorkspaceAction(page, "Notification settings");
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByRole("status")).toContainText(
    "Your browser is blocking notifications from Everything",
  );
  expect(await requests(page)).toBe(0);
});

test("phones never ask for desktop notification permission and keep the Home Screen steps", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "phone", "Phone layout only");
  const state = serverState();
  await stubNotifications(context, "default", "granted");
  await workspace(context, state);
  await page.goto("/");
  await openWorkspaceAction(page, "Notification settings");
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("switch", { name: "Desktop notifications" });
  await expect(toggle).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText(
    "This browser can’t show desktop notifications",
  );
  await expect(dialog).toContainText("Add to Home Screen");
  await expect(dialog).toContainText(
    "Phone notifications aren’t available yet",
  );
  await toggle.click({ force: true });
  expect(await requests(page)).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("phone-notifications.png") });
});

test("new teammate messages notify in a background tab without replaying history or marking anything read", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Desktop notifications only");
  const state = serverState();
  const earlier = state.append("An earlier reply that is still unread.");
  await enableNotifications(context);
  await workspace(context, state);
  await page.goto("/");
  await feedChecks(state, 2);
  await page.reload();
  await feedChecks(state, 2);
  expect(await shown(page)).toEqual([]);

  await attention(page, false, false);
  state.append("A note from you.", "blake", "user");
  const reply = state.append(
    "**Draft** is ready for [review](https://example.com) <b>today</b>.",
    "blake",
  );
  await expect
    .poll(() => shown(page), { timeout: 20_000 })
    .toEqual([
      {
        title: "Blake",
        body: "Draft is ready for review today.",
        tag: `everything-message-${reply.id}`,
        icon: "/teammate-avatars/avatar-07.webp",
        closed: false,
      },
    ]);
  await feedChecks(state, 2);
  expect(await shown(page)).toHaveLength(1);
  // Notifying sends no receipts; the badge, which doesn't poll hidden tabs, catches up on return.
  expect(state.read.has(reply.id)).toBe(false);
  expect(state.read.has(earlier.id)).toBe(false);
  await attention(page, true, false);
  await expect(
    page.locator('.sidebar .nav-item[href="/updates"]'),
  ).toHaveAttribute("aria-label", "Updates, 2 unread", { timeout: 10_000 });

  await page.evaluate(() =>
    (
      window as unknown as {
        testNotifications: { created: { onclick: () => void }[] };
      }
    ).testNotifications.created[0]!.onclick(),
  );
  await expect(page).toHaveURL(
    new RegExp(`/team/blake\\?message=${reply.id}$`),
  );
  await expect(page.locator(".update-target")).toContainText("Draft");
  expect((await shown(page))[0]?.closed).toBe(true);
  // Opening the message doesn't read it; the chat's usual exposure rules do.
  await attention(page, true, true);
  await expect.poll(() => state.read.has(reply.id)).toBe(true);
});

test("an open chat notifies hidden replies once and stays quiet while the user is looking", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Desktop notifications only");
  const state = serverState();
  await enableNotifications(context);
  await workspace(context, state);
  await page.goto("/team/avery");
  await expect(page.getByRole("log")).toBeAttached();
  await feedChecks(state, 1);

  await attention(page, false, false);
  const hidden = state.append("The background job finished.");
  await expect
    .poll(async () => (await shown(page)).map(({ body }) => body), {
      timeout: 20_000,
    })
    .toEqual(["The background job finished."]);
  // The open chat receives the reply at once, so the feed never lists it.
  await expect.poll(() => state.read.has(hidden.id)).toBe(true);
  await feedChecks(state, 2);
  expect(await shown(page)).toHaveLength(1);

  await attention(page, true, true);
  const watched = state.append("You can see this one already.");
  await expect.poll(() => state.read.has(watched.id)).toBe(true);
  await feedChecks(state, 2);
  expect(await shown(page)).toHaveLength(1);

  state.append("Blake needs a decision.", "blake");
  await expect
    .poll(async () => (await shown(page)).map(({ title }) => title), {
      timeout: 20_000,
    })
    .toEqual(["Avery", "Blake"]);
});

test("returning to a chat doesn't notify replies delivered while it was closed", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Desktop notifications only");
  const state = serverState();
  state.append("The first reply.");
  await enableNotifications(context);
  await workspace(context, state);
  const sidebar = page.getByRole("navigation", {
    name: "Workspace",
    exact: true,
  });
  await page.goto("/team/avery");
  await expect(page.getByText("The first reply.")).toBeVisible();
  await sidebar.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  // Read on another device while this tab shows Home, so the feed never lists it.
  const elsewhere = state.append("Read on your phone already.");
  state.read.add(elsewhere.id);
  await feedChecks(state, 2);
  // The chat's cached page lacks the reply; its first fresh page has it as history. The window
  // isn't focused, as on a second screen, so looking at the chat can't be what keeps it quiet.
  await attention(page, true, false);
  await page.locator('.side-agent[href="/team/avery"]').click();
  await expect(page.getByText(elsewhere.text)).toBeVisible();
  await feedChecks(state, 2);
  expect(await shown(page)).toEqual([]);

  await attention(page, false, false);
  state.append("A genuinely new reply.");
  await expect
    .poll(async () => (await shown(page)).map(({ body }) => body), {
      timeout: 20_000,
    })
    .toEqual(["A genuinely new reply."]);
});

test("several tabs notify about each message once", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Desktop notifications only");
  const state = serverState();
  await enableNotifications(context);
  await workspace(context, state);
  const other = await context.newPage();
  await page.goto("/updates");
  await other.goto("/");
  await feedChecks(state, 3);
  await attention(page, false, false);
  await attention(other, false, false);
  state.append("One result for two tabs.", "blake");
  await expect
    .poll(
      async () => (await shown(page)).length + (await shown(other)).length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await feedChecks(state, 4);
  expect((await shown(page)).length + (await shown(other)).length).toBe(1);
});
