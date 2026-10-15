import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/** Keep interaction order outside the browser, like the owner-scoped API. */
async function workspace(context: BrowserContext) {
  const agents = ["Avery", "Blake", "Casey", "Devon"].map((name, index) => ({
    id: name.toLowerCase(),
    name,
    avatarId: `avatar-0${index + 1}`,
    systemPrompt: "Help with planning.",
    inference: null,
    createdAt: "2026-10-15T00:00:00Z",
  }));
  const state = {
    recent: [] as string[],
    visits: [] as string[],
    failRecent: false,
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "recent-teammates-owner",
          displayName: "Recent teammates check",
        },
      },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents } }),
  );
  await context.route("**/v1/agents/recent", (route) =>
    state.failRecent
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({
          json: {
            agents: state.recent
              .slice(0, 3)
              .map((id) => agents.find((agent) => agent.id === id)),
          },
        }),
  );
  await context.route("**/v1/agents/*/interactions", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    expect(route.request().method()).toBe("POST");
    state.visits.push(id);
    state.recent = [id, ...state.recent.filter((previous) => previous !== id)];
    return route.fulfill({ status: 204 });
  });
  await context.route("**/v1/agents/*/runtime", (route) =>
    route.fulfill({
      json: {
        status: "idle",
        compacting: false,
        typing: false,
        backgroundCount: 0,
        sessionId: null,
        runId: null,
        error: null,
      },
    }),
  );
  await context.route("**/v1/agents/*/messages", (route) =>
    route.fulfill({ json: { messages: [], nextCursor: null } }),
  );
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [], observedAt: new Date().toISOString() },
    }),
  );
  await context.route("**/v1/updates/count", (route) =>
    route.fulfill({ json: { unread: 0, byAgent: {} } }),
  );
  await context.route("**/v1/updates", (route) =>
    route.fulfill({ json: { updates: [], nextCursor: null } }),
  );
  return state;
}

/** Return through the visible navigation without resetting the query cache. */
async function home(page: Page): Promise<void> {
  const name =
    (page.viewportSize()?.width ?? 1000) < 650
      ? "Mobile workspace"
      : "Workspace";
  await page
    .getByRole("navigation", { name, exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click();
}

test("Home lists the last three distinct teammates and jumps back into their ongoing chats", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "Recent teammates" });
  await expect(
    panel.getByRole("heading", { name: "Recent teammates" }),
  ).toBeVisible();
  await expect(panel).toContainText("Open a teammate to find them here.");
  for (const id of ["avery", "blake", "casey", "devon"]) {
    await page.goto(`/team/${id}`);
    await expect.poll(() => state.recent[0]).toBe(id);
  }
  await home(page);
  const links = panel
    .getByRole("list", { name: "Recent teammates" })
    .getByRole("link");
  await expect(links).toHaveText(["Devon", "Casey", "Blake"]);
  await page.reload();
  await expect(links).toHaveText(["Devon", "Casey", "Blake"]);
  await links.filter({ hasText: "Blake" }).click();
  await expect(page).toHaveURL(/\/team\/blake$/);
  await expect(
    page.getByRole("region", { name: "Chat with Blake" }),
  ).toBeVisible();
  await expect.poll(() => state.recent[0]).toBe("blake");
  await home(page);
  await expect(links).toHaveText(["Blake", "Devon", "Casey"]);
  await expect(panel.locator(".teammate-avatar")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.screenshot({ path: info.outputPath("recent-teammates.png") });
});

test("Home offers retry when recent teammates cannot load", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  state.recent = ["avery"];
  state.failRecent = true;
  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "Recent teammates" });
  await expect(panel.getByRole("alert")).toContainText(
    "Recent teammates couldn’t load.",
  );
  state.failRecent = false;
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(panel.getByRole("list").getByRole("link")).toHaveText(["Avery"]);
  expect(state.visits).toEqual([]);
});
