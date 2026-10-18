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
    agents,
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
  // The sidebar reads the saved teammate order; an empty one keeps creation order.
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
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
              .map((id) => agents.find((agent) => agent.id === id))
              .filter(Boolean)
              .slice(0, 3),
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
        compactionStartedAt: null,
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
  await context.route("**/v1/artifacts", (route) =>
    route.fulfill({ json: { artifacts: [] } }),
  );
  return state;
}

/** Leave the compact phone chat before using workspace navigation, retaining cached history. */
async function home(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1000) < 650 && /\/team\//.test(page.url()))
    await page
      .getByRole("link", { name: "Back to your team", exact: true })
      .click();
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
  const shortcuts = page.getByRole("navigation", {
    name: "Recent teammate shortcuts",
  });
  await expect(shortcuts).toHaveCount(0);
  for (const id of ["avery", "blake", "casey", "devon"]) {
    await page.goto(`/team/${id}`);
    await expect.poll(() => state.recent[0]).toBe(id);
  }
  await home(page);
  const links = panel
    .getByRole("list", { name: "Recent teammates" })
    .getByRole("link");
  await expect(links).toHaveText(["Devon", "Casey", "Blake"]);
  await expect(shortcuts.getByRole("link")).toHaveCount(
    info.project.name === "phone" ? 3 : 0,
  );
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

test("desktop keeps direct header actions and phone shortcuts return to recent chats", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  state.recent = ["devon", "casey", "blake", "avery"];
  await page.goto("/apps");
  const shortcuts = page.getByRole("navigation", {
    name: "Recent teammate shortcuts",
  });
  if (info.project.name === "desktop") {
    const header = page.locator(".topbar");
    await expect(header.getByRole("button")).toHaveCount(4);
    for (const name of [
      /Model providers/,
      "Notification settings",
      "Settings",
      "Sign out",
    ])
      await expect(
        header.getByRole("button", { name, exact: typeof name === "string" }),
      ).toBeVisible();
    await expect(shortcuts).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Workspace menu" }),
    ).toHaveCount(0);
    await expect(
      page
        .locator(".sidebar")
        .getByRole("link", { name: "Blake", exact: true }),
    ).toBeVisible();
    await header.screenshot({ path: info.outputPath("desktop-header.png") });
    await page.setViewportSize({ width: 390, height: 664 });
    await expect(header.getByRole("button")).toHaveCount(1);
    await expect(page.locator(".sidebar")).toBeHidden();
  }
  const links = shortcuts.getByRole("link");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAccessibleName("Back to Blake");
  await expect(links.nth(1)).toHaveAccessibleName("Back to Casey");
  await expect(links.nth(2)).toHaveAccessibleName("Back to Devon");
  await links.nth(0).click();
  await expect(page).toHaveURL(/\/team\/blake$/);
  await expect(
    page.getByRole("region", { name: "Chat with Blake" }),
  ).toBeVisible();
  await expect.poll(() => state.recent[0]).toBe("blake");
  await home(page);
  await expect(links.nth(2)).toHaveAccessibleName("Back to Blake");
  const visits = [...state.visits];
  await page.reload();
  await expect(links.nth(2)).toHaveAccessibleName("Back to Blake");
  expect(state.visits).toEqual(visits);
  await page
    .locator(".topbar")
    .screenshot({ path: info.outputPath("teammate-shortcuts.png") });
  if (info.project.name === "phone") {
    await page.setViewportSize({ width: 320, height: 664 });
    for (const control of [
      ...(await links.all()),
      page.getByRole("button", { name: "Workspace menu" }),
    ]) {
      await expect(control).toBeInViewport();
      const bounds = await control.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const brand = await page.locator(".mobile-wordmark").boundingBox();
    const first = await links.first().boundingBox();
    expect(brand!.x + brand!.width).toBeLessThanOrEqual(first!.x);
    await page
      .locator(".topbar")
      .screenshot({ path: info.outputPath("teammate-shortcuts-320.png") });
  }
  state.agents.splice(
    state.agents.findIndex((agent) => agent.id === "blake"),
    1,
  );
  await page.reload();
  await expect(
    shortcuts.getByRole("link", { name: "Back to Blake" }),
  ).toHaveCount(0);
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAccessibleName("Back to Avery");
  if (info.project.name === "desktop") {
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(shortcuts).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Workspace menu" }),
    ).toHaveCount(0);
    await expect(page.locator(".topbar").getByRole("button")).toHaveCount(4);
    await expect(page.locator(".sidebar")).toBeVisible();
  }
});

test("workspace menu supports keyboard dismissal and restores focus after dialogs", async ({
  page,
  context,
}, info) => {
  test.skip(
    info.project.name !== "phone",
    "Desktop exposes actions directly in the header.",
  );
  const state = await workspace(context);
  state.recent = ["avery", "blake", "casey"];
  await page.goto("/");
  const trigger = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  const menu = page.getByRole("menu", { name: "Workspace menu" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(5);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect(menu.getByRole("menuitem").first()).toContainText(
    "No verified connection",
  );
  await page.screenshot({ path: info.outputPath("workspace-menu.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Notification settings" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.locator("html").click({ position: { x: 4, y: 80 } });
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await menu
    .getByRole("menuitem", { name: "Preferences", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
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
