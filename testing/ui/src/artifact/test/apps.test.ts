import { expect, test, type BrowserContext } from "@playwright/test";

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
    url: `http://localhost:8081/app-${index}/`,
    release: status === "unpublished" ? 0 : 1,
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    createdBy: { id: "teammate", name: "Ada" },
    updatedBy: { id: "teammate", name: "Ada" },
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
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
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
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("article")).toHaveCount(7);
  if (info.project.name === "phone")
    await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
  await expect(card.getByRole("button")).toBeDisabled();
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
