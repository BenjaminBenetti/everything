import type { BrowserContext, Page } from "@playwright/test";

/** The runtime status Avery's conversation reads, as the API sends it. */
export interface Runtime {
  status: "idle" | "running" | "error";
  mainRunning: boolean;
  compacting: boolean;
  compactionStartedAt: string | null;
  typing: boolean;
  backgroundCount: number;
  monitorCount: number;
  sessionId: string | null;
  runId: string | null;
  error: string | null;
}

/** A loaded teammate with nothing running. */
export const idle: Runtime = {
  status: "idle",
  mainRunning: false,
  compacting: false,
  compactionStartedAt: null,
  typing: false,
  backgroundCount: 0,
  monitorCount: 0,
  sessionId: "private-session-id",
  runId: null,
  error: null,
};

/** Synthetic teammates and history; Avery's runtime status is controlled by each test. */
export async function activityWorkspace(context: BrowserContext) {
  const state = {
    avery: { ...idle },
    failRuntime: false,
    /** While set, Avery's status reads wait until the test releases them. */
    hold: null as Promise<void> | null,
  };
  // Registered first, so it only answers what no specific route below handles.
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: { subject: "thinking-test-owner", displayName: "Demo owner" },
      },
    }),
  );
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  const teammates = ["Avery", "Blake"].map((name) => ({
    id: name.toLowerCase(),
    name,
    avatarId: name === "Avery" ? "avatar-03" : "avatar-26",
    systemPrompt: "Help with project planning.",
    createdAt: "2026-10-12T10:00:00Z",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  }));
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: teammates } }),
  );
  await context.route("**/v1/agents/recent", (route) =>
    route.fulfill({ json: { agents: teammates } }),
  );
  await context.route("**/v1/agents/*/interactions", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/v1/agents/*/runtime", async (route) => {
    if (!route.request().url().includes("/avery/"))
      return route.fulfill({ json: idle });
    if (state.hold) await state.hold;
    if (state.failRuntime)
      return route.fulfill({
        status: 503,
        json: { code: "UNAVAILABLE", message: "Service unavailable" },
      });
    return route.fulfill({ json: state.avery });
  });
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [], observedAt: new Date().toISOString() },
    }),
  );
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        messages: route.request().url().includes("/avery/")
          ? [
              {
                id: "message-1",
                role: "user",
                text: "Can you draft the launch checklist?",
                createdAt: "2026-10-12T10:00:00Z",
              },
              {
                id: "message-2",
                role: "assistant",
                text: "Sure. I'll check the open tasks first.",
                createdAt: "2026-10-12T10:00:30Z",
              },
            ]
          : [],
        nextCursor: null,
      },
    }),
  );
  await context.route("**/v1/agents/*/messages/read", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/v1/updates", (route) =>
    route.fulfill({ json: { updates: [], nextCursor: null } }),
  );
  await context.route("**/v1/updates/count", (route) =>
    route.fulfill({ json: { unread: 0, byAgent: {} } }),
  );
  return state;
}

/** The main teammate's avatar where this layout shows it: the header on narrow screens, otherwise the info card. */
export function mainAvatar(page: Page) {
  return (page.viewportSize()?.width ?? 1440) <= 1100
    ? page.locator(".chat-mobile-header .teammate-avatar")
    : page.locator(".chat-teammate-card .teammate-avatar");
}

/** The element around that avatar that takes focus and shows the monitor count while watching. */
export function mainPresence(page: Page) {
  return (page.viewportSize()?.width ?? 1440) <= 1100
    ? page.locator(".chat-mobile-header .teammate-presence-trigger")
    : page.locator(".chat-teammate-card .teammate-presence-trigger");
}

/** The heading beside that avatar, used to confirm the layout doesn't move. */
export function mainHeading(page: Page) {
  return (page.viewportSize()?.width ?? 1440) <= 1100
    ? page.locator(".chat-mobile-identity h1")
    : page.locator(".chat-teammate-identity h1");
}

/** Let the page's entrance animation finish so measurements compare the final layout. */
export async function settled(page: Page): Promise<void> {
  await page
    .locator(".route-content")
    .evaluate((element) =>
      Promise.all(element.getAnimations().map((motion) => motion.finished)),
    );
}

/** Count running browser animations inside an element. */
export function animations(page: Page) {
  return mainAvatar(page).evaluate(
    (element) => element.getAnimations({ subtree: true }).length,
  );
}
