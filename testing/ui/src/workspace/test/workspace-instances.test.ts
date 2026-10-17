import { expect, test, type BrowserContext } from "@playwright/test";

/** Isolate directory controls from real instances while exercising the full UI. */
async function prepareWorkspaces(context: BrowserContext) {
  const state = {
    workspaces: [
      {
        type: "web",
        name: "dev-1",
        status: "running",
        resources: {
          cpuCores: 0.25 as number | null,
          memoryBytes: 536870912 as number | null,
        },
      },
      {
        type: "web",
        name: "preview-2",
        status: "stopped",
        resources: {
          cpuCores: 0 as number | null,
          memoryBytes: 0 as number | null,
        },
      },
      {
        type: "api",
        name: "dev-1",
        status: "running",
        resources: {
          cpuCores: null as number | null,
          memoryBytes: null as number | null,
        },
      },
      {
        type: "api",
        name: "worker-2",
        status: "starting",
        resources: {
          cpuCores: null as number | null,
          memoryBytes: null as number | null,
        },
      },
    ],
    failList: false,
    failAction: false,
    holdAction: false,
    release: undefined as (() => void) | undefined,
    actions: [] as { action: string; type: string; name: string }[],
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "workspace-instances-fixture",
          displayName: "Workspace check",
        },
      },
    }),
  );
  // The sidebar reads the saved teammate order; an empty one keeps creation order.
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/workspaces**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(
        state.failList
          ? { status: 503, json: { code: "WORKSPACE_INSTANCES_UNAVAILABLE" } }
          : { json: { workspaces: state.workspaces } },
      );
      return;
    }
    const target = route.request().postDataJSON() as {
      type: string;
      name: string;
    };
    expect(Object.keys(target).sort()).toEqual(["name", "type"]);
    const action =
      route.request().method() === "DELETE"
        ? "delete"
        : new URL(route.request().url()).pathname.split("/").at(-1)!;
    state.actions.push({ action, ...target });
    if (state.holdAction)
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    const workspace = state.workspaces.find(
      (item) => item.name === target.name && item.type === target.type,
    )!;
    if (
      state.failAction ||
      (action === "delete" && workspace.status !== "stopped")
    ) {
      await route.fulfill({
        status: 409,
        json: { code: "WORKSPACE_INSTANCE_CONFLICT" },
      });
      return;
    }
    if (action === "delete") {
      workspace.status = "deleting";
      await route.fulfill({ status: 202, json: {} });
    } else {
      workspace.status = action === "start" ? "running" : "stopped";
      await route.fulfill({ status: 204 });
    }
  });
  return state;
}

test("Workspaces navigation opens grouped cards with usage, search, and a responsive layout", async ({
  page,
  context,
}, info) => {
  await prepareWorkspaces(context);
  await page.goto("/");
  const navigation = page.getByRole("navigation", {
    name:
      (page.viewportSize()?.width ?? 1000) < 650
        ? "Mobile workspace"
        : "Workspace",
    exact: true,
  });
  await navigation
    .getByRole("link", { name: "Workspaces", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page).toHaveTitle("Workspaces · Everything");
  const web = page.getByRole("region", { name: "web workspaces", exact: true });
  const api = page.getByRole("region", { name: "api workspaces", exact: true });
  await expect(web.getByRole("article")).toHaveCount(2);
  await expect(api.getByRole("article")).toHaveCount(2);
  await expect(web.getByText("0.25 cores", { exact: true })).toBeVisible();
  await expect(web.getByText("512 MiB", { exact: true })).toBeVisible();
  await expect(
    api
      .getByRole("article", { name: "dev-1", exact: true })
      .getByTitle("CPU usage unavailable"),
  ).toContainText("—");
  await expect(
    web.getByRole("button", { name: "Delete dev-1", exact: true }),
  ).toHaveCount(0);
  await expect(
    web.getByRole("button", { name: "Delete preview-2", exact: true }),
  ).toBeVisible();
  await expect(
    api.getByRole("button", { name: "Start worker-2", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("workspaces.png"),
    fullPage: true,
    animations: "disabled",
  });
  const search = page.getByRole("searchbox", { name: "Search workspaces" });
  await search.fill(" WEB ");
  await expect(web).toBeVisible();
  await expect(api).toHaveCount(0);
  await search.fill("DEV-1");
  await expect(page.getByRole("article")).toHaveCount(2);
  await search.fill("no-such-workspace");
  await expect(
    page.getByRole("heading", { name: "No matching workspaces" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("article")).toHaveCount(4);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Workspaces", exact: true }),
  ).toBeVisible();
  if (info.project.name === "phone")
    await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("play and pause target one instance, disable pending actions, and update delete visibility", async ({
  page,
  context,
}) => {
  const state = await prepareWorkspaces(context);
  await page.goto("/workspaces");
  const card = page
    .getByRole("region", { name: "web workspaces", exact: true })
    .getByRole("article", { name: "dev-1", exact: true });
  state.holdAction = true;
  await card.getByRole("button", { name: "Stop dev-1", exact: true }).click();
  await expect(card.getByText("Stopping…", { exact: true })).toBeVisible();
  await expect(card.getByRole("button")).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "Delete dev-1", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => !!state.release).toBe(true);
  state.holdAction = false;
  state.release!();
  await expect(card.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Delete dev-1", exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Start dev-1", exact: true }).click();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Delete dev-1", exact: true }),
  ).toHaveCount(0);
  expect(state.actions).toEqual([
    { action: "stop", type: "web", name: "dev-1" },
    { action: "start", type: "web", name: "dev-1" },
  ]);
  expect(
    state.workspaces.find(
      (item) => item.type === "api" && item.name === "dev-1",
    )!.status,
  ).toBe("running");
});

test("deletion confirms saved-file removal, supports cancellation, and follows asynchronous completion", async ({
  page,
  context,
}) => {
  const state = await prepareWorkspaces(context);
  await page.goto("/workspaces");
  const card = page.getByRole("article", { name: "preview-2", exact: true });
  const opener = card.getByRole("button", {
    name: "Delete preview-2",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("alertdialog", { name: "Delete workspace?" });
  await expect(dialog).toContainText("saved files will be permanently deleted");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  expect(state.actions).toEqual([]);
  await opener.click();
  await dialog
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByText("Deleting…", { exact: true })).toBeVisible();
  await expect(opener).toHaveCount(0);
  state.workspaces = state.workspaces.filter(
    (item) => item.name !== "preview-2",
  );
  await expect(card).toHaveCount(0, { timeout: 12_000 });
  expect(state.actions).toEqual([
    { action: "delete", type: "web", name: "preview-2" },
  ]);
});

test("failed actions preserve the card and allow a retry", async ({
  page,
  context,
}) => {
  const state = await prepareWorkspaces(context);
  state.failAction = true;
  await page.goto("/workspaces");
  const card = page.getByRole("article", { name: "preview-2", exact: true });
  await card
    .getByRole("button", { name: "Start preview-2", exact: true })
    .click();
  await expect(card.getByRole("alert")).toContainText("couldn’t finish");
  await expect(card.getByText("Stopped", { exact: true })).toBeVisible();
  state.failAction = false;
  await card
    .getByRole("button", { name: "Start preview-2", exact: true })
    .click();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("a workspace that starts after opening deletion cannot be deleted", async ({
  page,
  context,
}) => {
  const state = await prepareWorkspaces(context);
  await page.goto("/workspaces");
  const card = page.getByRole("article", { name: "preview-2", exact: true });
  await card
    .getByRole("button", { name: "Delete preview-2", exact: true })
    .click();
  state.workspaces.find((item) => item.name === "preview-2")!.status =
    "running";
  const dialog = page.getByRole("alertdialog", { name: "Delete workspace?" });
  await dialog
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "may no longer be stopped",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Delete preview-2", exact: true }),
  ).toHaveCount(0);
});

test("load errors recover on retry and an empty directory explains how workspaces appear", async ({
  page,
  context,
}) => {
  const state = await prepareWorkspaces(context);
  state.failList = true;
  await page.goto("/workspaces");
  await expect(page.getByRole("alert")).toContainText(
    "Workspaces couldn’t load",
  );
  await expect(
    page.getByRole("heading", { name: "No workspaces yet" }),
  ).toHaveCount(0);
  state.failList = false;
  state.workspaces = [];
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No workspaces yet" }),
  ).toBeVisible();
});

test("background refresh updates usage and disables stale controls after a connection failure", async ({
  page,
  context,
}) => {
  const state = await prepareWorkspaces(context);
  await page.goto("/workspaces");
  const card = page.getByRole("article", { name: "preview-2", exact: true });
  await expect(
    card.getByRole("button", { name: "Start preview-2", exact: true }),
  ).toBeEnabled();
  state.workspaces.find((item) => item.name === "preview-2")!.status =
    "running";
  await expect(card.getByText("Running", { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  state.failList = true;
  await expect(page.getByRole("alert")).toContainText("couldn’t refresh", {
    timeout: 12_000,
  });
  await expect(
    card.getByRole("button", { name: "Stop preview-2", exact: true }),
  ).toBeDisabled();
});
