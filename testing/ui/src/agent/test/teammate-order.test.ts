import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/** Keep the saved order outside the browser, like the owner-scoped API, and record every save. */
async function workspace(context: BrowserContext, savedOrder: string[] = []) {
  const agents = ["Avery", "Blake", "Casey", "Devon"].map((name, index) => ({
    id: name.toLowerCase(),
    name,
    avatarId: `avatar-0${index + 1}`,
    systemPrompt: index % 2 ? "Plan the launch." : "Review the budget.",
    inference: null,
    createdAt: `2026-10-1${index}T00:00:00Z`,
  }));
  const state = {
    agents,
    teammateIds: savedOrder,
    saves: [] as string[][],
    failRead: false,
    failSave: false,
    /** When set, each save waits until the test releases it as saved or failed. */
    holdSaves: false,
    held: [] as ((saved: boolean) => void)[],
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "teammate-order-owner",
          displayName: "Teammate order check",
        },
      },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: state.agents } }),
  );
  await context.route("**/v1/agents/recent", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await context.route("**/v1/agents/*/interactions", (route) =>
    route.fulfill({ status: 204 }),
  );
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
  await context.route("**/v1/settings/teammate-order", async (route) => {
    if (route.request().method() === "PUT") {
      const teammateIds = route.request().postDataJSON().teammateIds;
      const saved = state.holdSaves
        ? await new Promise<boolean>((resolve) => state.held.push(resolve))
        : !state.failSave;
      if (!saved) return route.fulfill({ status: 503, json: {} });
      state.teammateIds = teammateIds;
      state.saves.push(teammateIds);
    } else if (state.failRead) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: { teammateIds: state.teammateIds } });
  });
  await context.route("**/v1/updates/count", (route) =>
    route.fulfill({ json: { unread: 2, byAgent: { casey: 2 } } }),
  );
  await context.route(/\/v1\/updates(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { updates: [], nextCursor: null } }),
  );
  await context.route("**/v1/artifacts", (route) =>
    route.fulfill({ json: { artifacts: [] } }),
  );
  return state;
}

/** Names in the sidebar's teammate list, top to bottom. */
function sidebarNames(page: Page) {
  return page.locator(".sidebar-agents .side-agent-name");
}

/** A teammate's reorder handle in the sidebar. */
function handle(page: Page, name: string) {
  return page.getByRole("button", { name: `Reorder ${name}`, exact: true });
}

/** Pick up the focused handle and wait for its arrow keys, which listen from the next task. */
async function pickUp(page: Page, announcement: string): Promise<void> {
  await page.keyboard.press("Space");
  await expect(page.locator("[id^=DndLiveRegion]")).toHaveText(announcement);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
}

/** Drag a teammate's handle with the mouse until it is over another teammate, then drop. */
async function drag(page: Page, name: string, onto: string): Promise<void> {
  const source = handle(page, name);
  await source.hover();
  const from = (await source.boundingBox())!;
  const to = (await page
    .locator(".side-agent-row")
    .filter({ hasText: onto })
    .boundingBox())!;
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2 + 8, { steps: 4 });
  await page.mouse.move(x, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("Teammates are dragged into an order that survives reloads, while rows still open chats", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Phones have no sidebar.");
  const state = await workspace(context);
  await page.goto("/team/blake");
  await expect(sidebarNames(page)).toHaveText([
    "Avery",
    "Blake",
    "Casey",
    "Devon",
  ]);
  await expect(page.locator(".side-agent.active")).toHaveText("Blake");
  await expect(
    page.getByRole("link", { name: "Casey, 2 unread", exact: true }),
  ).toBeVisible();

  // A plain click opens the chat; clicking a handle without dragging moves nobody.
  await page.locator(".side-agent").filter({ hasText: "Avery" }).click();
  await expect(page).toHaveURL(/\/team\/avery$/);
  await handle(page, "Devon").click();
  await expect(page).toHaveURL(/\/team\/avery$/);
  await expect(sidebarNames(page)).toHaveText([
    "Avery",
    "Blake",
    "Casey",
    "Devon",
  ]);

  await drag(page, "Devon", "Avery");
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Avery",
    "Blake",
    "Casey",
  ]);
  await expect(page).toHaveURL(/\/team\/avery$/);
  await expect(page.locator(".side-agent.active")).toHaveText("Avery");
  await expect(
    page.getByRole("link", { name: "Casey, 2 unread", exact: true }),
  ).toBeVisible();
  await drag(page, "Avery", "Casey");
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Blake",
    "Casey",
    "Avery",
  ]);
  expect(state.saves).toEqual([
    ["devon", "avery", "blake", "casey"],
    ["devon", "blake", "casey", "avery"],
  ]);

  // The saved order comes back from the server and also arranges the team page and its search.
  await page.reload();
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Blake",
    "Casey",
    "Avery",
  ]);
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Your team", exact: true })
    .click();
  await expect(page.locator(".agent-card h2 > span:first-child")).toHaveText([
    "Devon",
    "Blake",
    "Casey",
    "Avery",
  ]);
  await page
    .getByRole("searchbox", { name: "Search teammates" })
    .fill("budget");
  await expect(page.locator(".agent-card h2 > span:first-child")).toHaveText([
    "Casey",
    "Avery",
  ]);
  expect(state.saves).toHaveLength(2);
});

test("Keyboard users pick up, move, drop, and cancel with announcements", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Phones have no sidebar.");
  const state = await workspace(context);
  await page.goto("/");
  await expect(sidebarNames(page)).toHaveText([
    "Avery",
    "Blake",
    "Casey",
    "Devon",
  ]);
  const announcement = page.locator("[id^=DndLiveRegion]");

  // Tab reaches each handle right after its teammate's link.
  await page.locator(".side-agent").filter({ hasText: "Avery" }).focus();
  await page.keyboard.press("Tab");
  await expect(handle(page, "Avery")).toBeFocused();
  await expect(handle(page, "Avery")).toHaveAccessibleDescription(
    /Press Space or Enter to pick up this teammate/,
  );

  // Moving past the top changes nothing and saves nothing.
  await pickUp(page, "Picked up Avery in position 1 of 4.");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await expect(announcement).toHaveText("Avery dropped in position 1 of 4.");
  expect(state.saves).toEqual([]);

  await pickUp(page, "Picked up Avery in position 1 of 4.");
  await page.keyboard.press("ArrowDown");
  await expect(announcement).toHaveText("Avery moved to position 2 of 4.");
  await page.keyboard.press("ArrowDown");
  await expect(announcement).toHaveText("Avery moved to position 3 of 4.");
  await page.keyboard.press("Enter");
  await expect(announcement).toHaveText("Avery dropped in position 3 of 4.");
  await expect(sidebarNames(page)).toHaveText([
    "Blake",
    "Casey",
    "Avery",
    "Devon",
  ]);
  await expect(handle(page, "Avery")).toBeFocused();
  await expect(page).toHaveURL(/\/$/);

  // Escape puts the teammate back where they started.
  await pickUp(page, "Picked up Avery in position 3 of 4.");
  await page.keyboard.press("ArrowUp");
  await expect(announcement).toHaveText("Avery moved to position 2 of 4.");
  await page.keyboard.press("ArrowUp");
  await expect(announcement).toHaveText("Avery moved to position 1 of 4.");
  await page.keyboard.press("Escape");
  await expect(announcement).toHaveText(
    "Reordering cancelled. Avery is back in position 3 of 4.",
  );
  await expect(sidebarNames(page)).toHaveText([
    "Blake",
    "Casey",
    "Avery",
    "Devon",
  ]);
  await expect(handle(page, "Avery")).toBeFocused();

  // After sorting, the link still opens the chat from the keyboard.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/team\/avery$/);
  expect(state.saves).toEqual([["blake", "casey", "avery", "devon"]]);
});

test("A failed save restores the saved order and explains what happened", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Phones have no sidebar.");
  const state = await workspace(context, ["casey", "avery"]);
  await page.goto("/");
  await expect(sidebarNames(page)).toHaveText([
    "Casey",
    "Avery",
    "Blake",
    "Devon",
  ]);
  state.failSave = true;
  await drag(page, "Devon", "Casey");
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn’t save your teammate order. Try again.",
  );
  await expect(sidebarNames(page)).toHaveText([
    "Casey",
    "Avery",
    "Blake",
    "Devon",
  ]);
  state.failSave = false;
  await drag(page, "Devon", "Casey");
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Casey",
    "Avery",
    "Blake",
  ]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.saves).toEqual([["devon", "casey", "avery", "blake"]]);
});

test("Quick drops save one at a time, keep the newest order, and recover when the last save fails", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Phones have no sidebar.");
  const state = await workspace(context);
  state.holdSaves = true;
  const alert = page.getByRole("alert");
  /** Finish the save the server is holding once it arrives. */
  async function release(saved: boolean): Promise<void> {
    await expect.poll(() => state.held.length).toBe(1);
    state.held.shift()!(saved);
  }
  await page.goto("/");
  await expect(sidebarNames(page)).toHaveText([
    "Avery",
    "Blake",
    "Casey",
    "Devon",
  ]);

  // The second drop waits for the first save, and finishing the first keeps the newest order.
  await drag(page, "Devon", "Avery");
  await drag(page, "Casey", "Avery");
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Casey",
    "Avery",
    "Blake",
  ]);
  await release(true);
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Casey",
    "Avery",
    "Blake",
  ]);
  await release(true);
  await expect
    .poll(() => state.saves)
    .toEqual([
      ["devon", "avery", "blake", "casey"],
      ["devon", "casey", "avery", "blake"],
    ]);
  await expect(alert).toHaveCount(0);

  // A failed earlier save is covered by the queued save, which already includes its move.
  await drag(page, "Blake", "Devon");
  await drag(page, "Avery", "Devon");
  await release(false);
  await expect(sidebarNames(page)).toHaveText([
    "Blake",
    "Avery",
    "Devon",
    "Casey",
  ]);
  await release(true);
  await expect
    .poll(() => state.teammateIds)
    .toEqual(["blake", "avery", "devon", "casey"]);
  await expect(alert).toHaveCount(0);

  // When the last save fails, the list returns to the order the server kept.
  await drag(page, "Casey", "Blake");
  await drag(page, "Devon", "Blake");
  await expect(sidebarNames(page)).toHaveText([
    "Casey",
    "Devon",
    "Blake",
    "Avery",
  ]);
  await release(true);
  await release(false);
  await expect(alert).toHaveText(
    "Couldn’t save your teammate order. Try again.",
  );
  await expect(sidebarNames(page)).toHaveText([
    "Casey",
    "Blake",
    "Avery",
    "Devon",
  ]);
  expect(state.teammateIds).toEqual(["casey", "blake", "avery", "devon"]);
});

test("Saved orders skip removed and repeated teammates and place new ones last", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Phones have no sidebar.");
  const state = await workspace(context, ["gone", "devon", "blake", "devon"]);
  await page.goto("/");
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Blake",
    "Avery",
    "Casey",
  ]);
  await drag(page, "Casey", "Devon");
  await expect(sidebarNames(page)).toHaveText([
    "Casey",
    "Devon",
    "Blake",
    "Avery",
  ]);
  expect(state.saves).toEqual([["casey", "devon", "blake", "avery"]]);
});

test("Dropping outside the sidebar keeps the order and saves nothing", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "phone", "Phones have no sidebar.");
  const state = await workspace(context);
  await page.goto("/team/blake");
  const source = handle(page, "Devon");
  await source.hover();
  const from = (await source.boundingBox())!;
  const content = (await page.locator("#workspace-content").boundingBox())!;
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y - 40, { steps: 6 });
  await expect(page.locator(".side-agent-row.dragging")).toHaveCount(1);
  await page.mouse.move(content.x + content.width / 2, from.y - 80, {
    steps: 12,
  });
  await expect(page.locator(".sidebar-agents.outside")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator("[id^=DndLiveRegion]")).toHaveText(
    "Devon dropped outside the sidebar. The order didn’t change.",
  );
  await expect(page.locator(".side-agent-row.dragging")).toHaveCount(0);
  await expect(sidebarNames(page)).toHaveText([
    "Avery",
    "Blake",
    "Casey",
    "Devon",
  ]);
  await expect(page).toHaveURL(/\/team\/blake$/);
  expect(state.saves).toEqual([]);
});

test("When the order can't load, links keep working in creation order until a retry restores it", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context, ["devon"]);
  state.failRead = true;
  await page.goto("/team");
  await expect(page.locator(".agent-card h2 > span:first-child")).toHaveText([
    "Avery",
    "Blake",
    "Casey",
    "Devon",
  ]);
  if (info.project.name === "phone") return;
  const sidebar = page.locator(".sidebar-agents");
  await expect(sidebar.getByRole("alert")).toContainText(
    "Your teammate order couldn’t load, so teammates are shown in the order you created them.",
  );
  await expect(sidebarNames(page)).toHaveText([
    "Avery",
    "Blake",
    "Casey",
    "Devon",
  ]);
  await expect(page.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
  await page.locator(".side-agent").filter({ hasText: "Casey" }).click();
  await expect(page).toHaveURL(/\/team\/casey$/);
  await expect(page.locator(".side-agent.active")).toHaveText("Casey");

  state.failRead = false;
  await sidebar.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(sidebar.getByRole("alert")).toHaveCount(0);
  await expect(sidebarNames(page)).toHaveText([
    "Devon",
    "Avery",
    "Blake",
    "Casey",
  ]);
  await expect(handle(page, "Avery")).toHaveCount(1);
  expect(state.saves).toEqual([]);
});

test("The team page follows the saved order on every screen size", async ({
  page,
  context,
}) => {
  await workspace(context, ["casey", "avery"]);
  await page.goto("/team");
  await expect(page.locator(".agent-card h2 > span:first-child")).toHaveText([
    "Casey",
    "Avery",
    "Blake",
    "Devon",
  ]);
});
