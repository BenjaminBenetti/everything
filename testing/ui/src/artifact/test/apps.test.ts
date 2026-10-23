import { expect, test, type BrowserContext } from "@playwright/test";

/** A synthetic API key; no real app or key is involved. */
const apiKey = `everything_app_key_${"T".repeat(21)}-${"e".repeat(21)}`;

/** Create a complete summary without touching real app data. */
function app(
  index: number,
  title: string,
  status: string,
  daysAgo: number,
  kind = "dynamic",
) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    title,
    status,
    kind,
    description: title === "Planner" ? "Weekend itinerary" : "Shared app",
    database: [1, 2, 6].includes(index),
    capabilities: [
      ...([1, 2, 3].includes(index) ? ["everything-api"] : []),
      ...(index === 3 ? ["api-key"] : []),
    ],
    url: `http://localhost:8081/app-${index}/`,
    release: status === "unpublished" ? 0 : 1,
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    createdBy:
      index === 5
        ? { id: "deleted", name: "Lin" }
        : [3, 4, 7].includes(index)
          ? { id: "grace", name: "Grace" }
          : { id: "ada", name: "Ada" },
    updatedBy: { id: "grace", name: "Grace" },
  };
}

/** Intercept app operations while exercising the deployed UI and independent card controls. */
async function prepareApps(context: BrowserContext) {
  const state = {
    apps: [
      app(1, "Notes", "stopped", 1),
      app(2, "Planner", "running", 8),
      app(3, "Dashboard", "running", 2),
      app(4, "Report", "live", 5, "static"),
      app(5, "Draft", "unpublished", 1),
      app(6, "Starting", "starting", 1),
      app(7, "Broken", "failing", 1),
    ],
    actions: [] as { id: string; action: string }[],
    keyReads: [] as string[],
    failKey: false,
    failAction: false,
    failList: false,
    holdAction: false,
    release: undefined as (() => void) | undefined,
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: { profile: { subject: "apps-fixture", displayName: "Apps check" } },
    }),
  );
  // The sidebar reads the saved teammate order; an empty one keeps creation order.
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "ada",
            name: "Ada",
            avatarId: "avatar-03",
            systemPrompt: "Help",
            inference: null,
          },
          {
            id: "grace",
            name: "Grace",
            avatarId: "avatar-07",
            systemPrompt: "Help",
            inference: null,
          },
        ],
      },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/artifact-views", (route) =>
    route.fulfill({
      json: { url: new URL("/app-preview", route.request().url()).href },
    }),
  );
  await context.route("**/app-preview", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>App preview</h1>" }),
  );
  await context.route("**/v1/artifacts**", async (route) => {
    const keyPath = new URL(route.request().url()).pathname.match(
      /^\/v1\/artifacts\/([^/]+)\/api-key$/,
    );
    if (keyPath && route.request().method() === "GET") {
      state.keyReads.push(keyPath[1]!);
      await route.fulfill(
        state.failKey
          ? { status: 409, json: { code: "APP_API_KEY_UNAVAILABLE" } }
          : { headers: { "cache-control": "no-store" }, json: { apiKey } },
      );
      return;
    }
    if (route.request().method() === "GET") {
      await route.fulfill(
        state.failList
          ? { status: 503, json: {} }
          : { json: { artifacts: state.apps } },
      );
      return;
    }
    const path = new URL(route.request().url()).pathname.split("/");
    const id = path[3]!;
    const action = route.request().method() === "DELETE" ? "delete" : path[4]!;
    state.actions.push({ id, action });
    if (state.holdAction)
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    const target = state.apps.find((item) => item.id === id)!;
    if (
      state.failAction ||
      (action === "delete" &&
        !["stopped", "unpublished"].includes(target.status))
    ) {
      await route.fulfill({
        status: 409,
        json: { code: "APP_ACTION_CONFLICT" },
      });
      return;
    }
    if (action === "delete")
      state.apps = state.apps.filter((item) => item.id !== id);
    else {
      target.status =
        action === "stop"
          ? "stopped"
          : target.kind === "static"
            ? "live"
            : "running";
      target.updatedAt = new Date().toISOString();
    }
    await route.fulfill({ status: 204 });
  });
  return state;
}

test("apps search titles, slugs, and descriptions, sorting by state and newest update", async ({
  page,
  context,
}, info) => {
  await prepareApps(context);
  await page.goto("/apps");
  const titles = page.getByRole("article").getByRole("heading");
  await expect(titles).toHaveText([
    "Dashboard",
    "Report",
    "Planner",
    "Starting",
    "Broken",
    "Notes",
    "Draft",
  ]);
  await expect(
    page.getByRole("button", { name: "Start Draft", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete Dashboard", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Delete Notes", exact: true }),
  ).toBeVisible();
  if (info.project.name === "desktop") {
    const controls = [
      page.getByRole("searchbox", { name: "Search apps" }).locator(".."),
      page.getByRole("combobox", { name: "Filter by teammate" }),
      page.getByRole("combobox", { name: "Filter by app type" }),
      page.getByRole("button", { name: "Filter by capabilities" }),
    ];
    const boxes = await Promise.all(
      controls.map((control) => control.boundingBox()),
    );
    for (const box of boxes)
      expect(
        Math.abs(
          box!.y + box!.height / 2 - (boxes[0]!.y + boxes[0]!.height / 2),
        ),
      ).toBeLessThan(2);
    expect(boxes[2]!.width).toBeLessThanOrEqual(120);
    expect(boxes[0]!.width).toBeLessThanOrEqual(240);
    expect(boxes[0]!.height).toBe(42);
    for (const box of boxes.slice(1)) {
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBe(boxes[1]!.height);
    }
  }
  await page.screenshot({
    path: info.outputPath("apps.png"),
    fullPage: true,
    animations: "disabled",
  });
  const search = page.getByRole("searchbox", { name: "Search apps" });
  for (const term of [" PLANNER ", "itinerary"]) {
    await search.fill(term);
    await expect(titles).toHaveText(["Planner"]);
  }
  await search.fill("no-match");
  await expect(
    page.getByRole("heading", { name: "No matching apps" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset search and filters" }).click();
  await expect(page.getByRole("article")).toHaveCount(7);
  if (info.project.name === "phone")
    await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("creator and capability icons explain apps without opening them", async ({
  page,
  context,
}, info) => {
  await prepareApps(context);
  await page.goto("/apps");
  const card = page.getByRole("article", { name: "Planner", exact: true });
  await expect(card.locator('[data-avatar-id="avatar-03"]')).toBeVisible();
  await expect(
    card.getByRole("img", { name: "Created by Ada", exact: true }),
  ).toBeVisible();
  let popups = 0;
  page.on("popup", () => popups++);
  for (const [label, description] of [
    ["Dynamic app", "Dynamic app: runs a backend service."],
    ["Database", "Database: stores app data in PostgreSQL."],
    [
      "Everything API",
      "API: acts as you through the Everything API. It can ask your teammates to do things, including changing apps and their credentials.",
    ],
  ] as const) {
    const icon = card.getByRole("img", { name: label, exact: true });
    if (info.project.name === "phone") await icon.tap();
    else await icon.hover();
    await expect(card.getByRole("tooltip")).toHaveText(description);
    await page.mouse.move(0, 0);
    await icon.focus();
    await expect(card.getByRole("tooltip")).toHaveText(description);
    await page.keyboard.press("Escape");
    await expect(card.getByRole("tooltip")).toHaveCount(0);
    await icon.blur();
  }
  expect(popups).toBe(0);
  const report = page.getByRole("article", { name: "Report", exact: true });
  await expect(
    report.getByRole("img", { name: "Static app", exact: true }),
  ).toBeVisible();
  await expect(
    report.getByRole("img", { name: "Database", exact: true }),
  ).toHaveCount(0);
  await expect(
    report.getByRole("img", { name: "Everything API", exact: true }),
  ).toHaveCount(0);
});

test("only apps with an API key show the key icon, which reveals the key on request and forgets it on close", async ({
  page,
  context,
}, info) => {
  const state = await prepareApps(context);
  const phone = info.project.name === "phone";
  await page.goto("/apps");
  await expect(page.getByRole("article")).toHaveCount(7);
  await expect(page.getByRole("button", { name: /^API Key for / })).toHaveCount(
    1,
  );
  const card = page.getByRole("article", { name: "Dashboard", exact: true });
  const trigger = card.getByRole("button", {
    name: "API Key for Dashboard",
    exact: true,
  });
  const key = card.getByText(apiKey, { exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(key).toHaveCount(0);
  expect(state.keyReads, "listing apps never reads a key").toEqual([]);
  let popups = 0;
  page.on("popup", () => popups++);

  if (phone) await trigger.tap();
  else await trigger.hover();
  await expect(key).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByText(/X-Api-Key header/)).toBeVisible();
  if (!phone) {
    await page.mouse.move(0, 0);
    await expect(key).toHaveCount(0);
  }
  await trigger.focus();
  await expect(key).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(key).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  if (phone) await trigger.tap();
  else await trigger.click();
  await expect(key).toBeVisible();
  if (!phone) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await card.getByRole("button", { name: "Copy API key" }).click();
    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      apiKey,
    );
  }
  await page.screenshot({
    path: info.outputPath("api-key.png"),
    animations: "disabled",
  });
  await page.getByRole("heading", { name: "Apps", exact: true }).click();
  await expect(key).toHaveCount(0);
  expect(popups, "revealing a key never opens the app").toBe(0);
  expect(new Set(state.keyReads)).toEqual(new Set([state.apps[2]!.id]));
  expect(page.url()).not.toContain(apiKey);
  expect(
    await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    ),
  ).not.toContain(apiKey);
  expect(await page.content()).not.toContain(apiKey);

  state.failKey = true;
  await trigger.focus();
  await expect(
    card.getByText(
      "The API key isn’t available right now. Try again in a moment.",
    ),
  ).toBeVisible();
  await expect(key).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Escape from the copy button closes the key and returns focus without reopening it", async ({
  page,
  context,
}, info) => {
  const state = await prepareApps(context);
  const phone = info.project.name === "phone";
  await page.goto("/apps");
  const card = page.getByRole("article", { name: "Dashboard", exact: true });
  const trigger = card.getByRole("button", {
    name: "API Key for Dashboard",
    exact: true,
  });
  const key = card.getByText(apiKey, { exact: true });
  if (phone) await trigger.tap();
  else await trigger.click();
  await expect(key).toBeVisible();
  const reads = state.keyReads.length;
  const copy = card.getByRole("button", { name: "Copy API key" });
  await copy.focus();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(key).toHaveCount(0);
  await expect(card.getByText(/X-Api-Key header/)).toHaveCount(0);
  // A reopened panel would request the key again; give a late reopen time to show.
  await page.waitForTimeout(300);
  await expect(key).toHaveCount(0);
  expect(state.keyReads.length).toBe(reads);

  // Clicking or tapping outside still dismisses a panel opened by a tap or click.
  if (phone) await trigger.tap();
  else await trigger.click();
  await expect(key).toBeVisible();
  const heading = page.getByRole("heading", { name: "Apps", exact: true });
  if (phone) await heading.tap();
  else await heading.click();
  await expect(key).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("teammate, type, DB, API, and search filters combine and reset to all apps", async ({
  page,
  context,
}, info) => {
  await prepareApps(context);
  await page.goto("/apps");
  const teammate = page.getByRole("combobox", { name: "Filter by teammate" });
  const type = page.getByRole("combobox", { name: "Filter by app type" });
  const capabilities = page.getByRole("button", {
    name: "Filter by capabilities",
  });
  const titles = page.getByRole("article").getByRole("heading");
  await expect(teammate).toHaveText("All teammates");
  await expect(type).toHaveText("All types");
  await teammate.click();
  await expect(
    page
      .getByRole("option", { name: "Ada", exact: true })
      .locator('[data-avatar-id="avatar-03"]'),
  ).toBeVisible();
  await expect(
    page
      .getByRole("option", { name: "Grace", exact: true })
      .locator('[data-avatar-id="avatar-07"]'),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("teammate-filter.png"),
    animations: "disabled",
  });
  await page.getByRole("option", { name: "Ada", exact: true }).click();
  await expect(teammate.locator('[data-avatar-id="avatar-03"]')).toBeVisible();
  await expect(titles).toHaveText(["Planner", "Starting", "Notes"]);
  await type.click();
  await page.getByRole("option", { name: "Dynamic", exact: true }).click();
  expect(
    await type
      .locator(".select-value")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await capabilities.click();
  await page.getByRole("menuitemcheckbox", { name: "DB", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "API", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "DB", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "API", exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: info.outputPath("capability-filter.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(capabilities).toBeFocused();
  await expect(capabilities).toHaveText("DB, API");
  await expect(titles).toHaveText(["Planner", "Notes"]);
  await page.getByRole("searchbox", { name: "Search apps" }).fill("itinerary");
  await expect(titles).toHaveText(["Planner"]);
  await type.click();
  await page.getByRole("option", { name: "Static", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching apps" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset search and filters" }).click();
  await expect(page.getByRole("article")).toHaveCount(7);
  await expect(teammate).toHaveText("All teammates");
  await expect(type).toHaveText("All types");
  await expect(capabilities).toHaveText("All capabilities");
  await capabilities.focus();
  await page.keyboard.press("ArrowDown");
  const database = page.getByRole("menuitemcheckbox", {
    name: "DB",
    exact: true,
  });
  await expect(database).toBeFocused();
  await page.keyboard.press("Space");
  await expect(database).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(titles).toHaveText(["Planner", "Starting", "Notes"]);
  await capabilities.press("ArrowDown");
  await expect(database).toBeFocused();
  await page.keyboard.press("Space");
  await expect(database).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(capabilities).toHaveText("All capabilities");
  await teammate.click();
  await page.getByRole("option", { name: "Lin", exact: true }).click();
  await expect(titles).toHaveText(["Draft"]);
  await expect(
    page.getByRole("img", { name: "Created by Lin", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(7);
});

test("the whole card and keyboard open apps while pause and play never open a tab", async ({
  page,
  context,
}) => {
  const state = await prepareApps(context);
  await page.goto("/apps");
  const card = page.getByRole("article", { name: "Planner", exact: true });
  let popups = 0;
  page.on("popup", () => popups++);
  const opened = page.waitForEvent("popup");
  await card.click({ position: { x: 28, y: 95 } });
  const preview = await opened;
  await expect(
    preview.getByRole("heading", { name: "App preview" }),
  ).toBeVisible();
  await preview.close();
  const keyboardOpened = page.waitForEvent("popup");
  await card.getByRole("link").focus();
  await page.keyboard.press("Enter");
  const keyboardPreview = await keyboardOpened;
  await expect(
    keyboardPreview.getByRole("heading", { name: "App preview" }),
  ).toBeVisible();
  await keyboardPreview.close();
  state.holdAction = true;
  await card.getByRole("button", { name: "Stop Planner", exact: true }).click();
  await expect(card.getByText("Stopping…", { exact: true })).toBeVisible();
  // Every control on the card, including Credentials, waits for the pending action.
  for (const control of await card.getByRole("button").all())
    await expect(control).toBeDisabled();
  await expect(card.getByRole("link")).toHaveCount(0);
  await expect.poll(() => !!state.release).toBe(true);
  state.holdAction = false;
  state.release!();
  await expect(
    card.getByRole("button", { name: "Delete Planner", exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Start Planner", exact: true })
    .click();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Planner",
  );
  expect(popups).toBe(2);
  expect(state.actions.map((item) => item.action)).toEqual(["stop", "start"]);
  const report = page.getByRole("article", { name: "Report", exact: true });
  await report
    .getByRole("button", { name: "Stop Report", exact: true })
    .click();
  await expect(report.getByText("Stopped", { exact: true })).toBeVisible();
  await report
    .getByRole("button", { name: "Start Report", exact: true })
    .click();
  await expect(report.getByText("Live", { exact: true })).toBeVisible();
});

test("deletion confirms data removal, supports cancellation and retry, and disables pending actions", async ({
  page,
  context,
}) => {
  const state = await prepareApps(context);
  await page.goto("/apps");
  const card = page.getByRole("article", { name: "Notes", exact: true });
  const opener = card.getByRole("button", {
    name: "Delete Notes",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("alertdialog", { name: "Delete app?" });
  await expect(dialog).toContainText("saved data will be permanently deleted");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(state.actions).toEqual([]);
  state.failAction = true;
  await opener.click();
  await dialog.getByRole("button", { name: "Delete app", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Notes",
      exact: true,
      includeHidden: true,
    }),
  ).toBeVisible();
  state.failAction = false;
  state.holdAction = true;
  await dialog.getByRole("button", { name: "Delete app", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Deleting…", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => !!state.release).toBe(true);
  state.holdAction = false;
  state.release!();
  await expect(dialog).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

test("an app restarted while deletion is open is retained and its latest state is shown", async ({
  page,
  context,
}) => {
  const state = await prepareApps(context);
  await page.goto("/apps");
  const card = page.getByRole("article", { name: "Notes", exact: true });
  await card.getByRole("button", { name: "Delete Notes", exact: true }).click();
  state.apps.find((item) => item.title === "Notes")!.status = "running";
  const dialog = page.getByRole("alertdialog", { name: "Delete app?" });
  await dialog.getByRole("button", { name: "Delete app", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "may no longer be stopped",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Delete Notes", exact: true }),
  ).toHaveCount(0);
});

test("background updates reorder apps and stale controls disable until a successful refresh", async ({
  page,
  context,
}) => {
  const state = await prepareApps(context);
  await page.goto("/apps");
  const card = page.getByRole("article", { name: "Notes", exact: true });
  const notes = state.apps.find((item) => item.title === "Notes")!;
  notes.status = "running";
  notes.updatedAt = new Date().toISOString();
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Notes",
    { timeout: 12_000 },
  );
  state.failList = true;
  await expect(page.getByRole("alert")).toContainText("couldn’t refresh", {
    timeout: 12_000,
  });
  await expect(
    card.getByRole("button", { name: "Stop Notes", exact: true }),
  ).toBeDisabled();
  state.failList = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Stop Notes", exact: true }),
  ).toBeEnabled();
});
