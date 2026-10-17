import { openWorkspaceAction } from "../../workspace/fixture/workspace-menu.js";
import { expect, test, type BrowserContext } from "@playwright/test";

/** An upgrade from rc7 to rc8 in the given state. */
function attempt(
  state: "running" | "succeeded" | "failed",
  failure: string | null = null,
) {
  return {
    fromVersion: "0.1.0-rc7",
    toVersion: "0.1.0-rc8",
    state,
    startedAt: "2026-10-17T10:00:00Z",
    finishedAt: state === "running" ? null : "2026-10-17T10:04:00Z",
    failure,
  };
}

/**
 * A workspace whose upgrade status the test sets. While `restarting` is above zero, status checks
 * fail as they do while Everything restarts during an upgrade.
 */
async function workspace(context: BrowserContext) {
  const state = {
    status: {
      availability: "ready",
      currentVersion: "0.1.0-rc7",
      latestVersion: "0.1.0-rc8",
      versionsChecked: true,
      lastUpgrade: null,
    } as Record<string, unknown>,
    afterStart: null as Record<string, unknown> | null,
    restarting: 0,
    afterRestart: null as Record<string, unknown> | null,
    started: [] as unknown[],
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "version-settings-owner",
          displayName: "Version check",
        },
      },
    }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/settings/workers", (route) =>
    route.fulfill({ json: { privileged: false } }),
  );
  await context.route("**/v1/settings/general", (route) =>
    route.fulfill({ json: { summarizeUpdates: false } }),
  );
  await context.route("**/v1/updates/count", (route) =>
    route.fulfill({ json: { unread: 0, byAgent: {} } }),
  );
  await context.route(/\/v1\/updates(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { updates: [], nextCursor: null } }),
  );
  await context.route("**/v1/upgrade", async (route) => {
    if (route.request().method() === "POST") {
      state.started.push(route.request().postDataJSON());
      state.status = state.afterStart ?? state.status;
      return route.fulfill({ status: 202, json: state.status });
    }
    if (state.afterRestart && state.status.lastUpgrade) {
      if (state.restarting > 0) {
        state.restarting--;
        return route.fulfill({ status: 502, body: "Bad gateway" });
      }
      state.status = state.afterRestart;
      state.afterRestart = null;
    }
    return route.fulfill({ json: state.status });
  });
  return state;
}

test("Version offers the newer release, follows the upgrade through Everything's restart, and offers to reload", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  state.afterStart = { ...state.status, lastUpgrade: attempt("running") };
  state.restarting = 2;
  state.afterRestart = {
    ...state.status,
    currentVersion: "0.1.0-rc8",
    latestVersion: null,
    lastUpgrade: attempt("succeeded"),
  };
  await page.goto("/");
  await openWorkspaceAction(page, "Settings");
  const version = page.getByRole("region", { name: "Version", exact: true });
  await expect(version).toContainText(
    "Version 0.1.0-rc8 is available. You’re on version 0.1.0-rc7.",
  );
  await version.getByRole("button", { name: "Upgrade to 0.1.0-rc8" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Upgrade to 0.1.0-rc8?",
  });
  await expect(confirmation).toContainText(
    "Everything restarts during the upgrade",
  );
  await expect(confirmation).toContainText("returns to version 0.1.0-rc7");
  await confirmation
    .getByRole("button", { name: "Upgrade", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  await expect(version.getByRole("status")).toContainText(
    "Upgrading to version 0.1.0-rc8…",
  );
  await expect(version).toContainText("Everything is restarting.", {
    timeout: 15_000,
  });
  await expect(version.getByRole("status")).toContainText(
    "Everything is now on version 0.1.0-rc8. Reload the page to use it.",
    { timeout: 20_000 },
  );
  await expect(version.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(version).toContainText(
    "You’re on the newest version, 0.1.0-rc8.",
  );
  expect(state.started).toEqual([{ version: "0.1.0-rc8" }]);
});

test("Version explains a failed upgrade, and says when the installer upgrades the installation", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  state.status = {
    ...state.status,
    lastUpgrade: attempt(
      "failed",
      "Error: UPGRADE FAILED: release everything failed, and has been rolled back",
    ),
  };
  await page.goto("/");
  await openWorkspaceAction(page, "Settings");
  const version = page.getByRole("region", { name: "Version", exact: true });
  await expect(version.getByRole("alert")).toContainText(
    "The upgrade to version 0.1.0-rc8 didn’t finish, so Everything stayed on version 0.1.0-rc7.",
  );
  await expect(version.getByRole("alert")).toContainText(
    "has been rolled back",
  );
  await expect(
    version.getByRole("button", { name: "Upgrade to 0.1.0-rc8" }),
  ).toBeVisible();

  state.status = {
    ...state.status,
    availability: "needs-installer",
    lastUpgrade: null,
  };
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await openWorkspaceAction(page, "Settings");
  await expect(version).toContainText(
    "Run the installer once more to let Everything upgrade itself from here.",
  );
  await expect(version.getByRole("button", { name: /Upgrade/ })).toHaveCount(0);
});
