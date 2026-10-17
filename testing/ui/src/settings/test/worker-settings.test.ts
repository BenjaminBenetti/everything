import {
  openWorkspaceAction,
  workspaceActionTrigger,
} from "../../workspace/fixture/workspace-menu.js";
import { test, expect, type BrowserContext } from "@playwright/test";

/** Isolate settings checks from account data and from the workspace's real worker settings. */
async function prepareWorkspace(context: BrowserContext): Promise<void> {
  await context.route("**/v1/settings/general", (route) =>
    route.fulfill({ json: { summarizeUpdates: true } }),
  );
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "settings-browser-fixture",
          displayName: "Settings check",
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
  await context.route("**/v1/upgrade", (route) =>
    route.fulfill({
      json: {
        availability: "ready",
        currentVersion: "0.1.0",
        latestVersion: null,
        versionsChecked: true,
        lastUpgrade: null,
      },
    }),
  );
}

test("Settings turns privileged workers on and off and shows the saved state", async ({
  page,
  context,
}) => {
  await prepareWorkspace(context);
  const saved = { privileged: false };
  const updates: unknown[] = [];
  await context.route("**/v1/settings/workers", async (route) => {
    if (route.request().method() === "PUT") {
      updates.push(route.request().postDataJSON());
      Object.assign(saved, route.request().postDataJSON());
    }
    await route.fulfill({ json: saved });
  });
  await page.goto("/");
  const opener = workspaceActionTrigger(page, "Settings");
  await expect(opener).toBeInViewport();
  await openWorkspaceAction(page, "Settings");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const privileged = dialog.getByRole("switch", {
    name: "Privileged workers",
  });
  await expect(privileged).not.toBeChecked();
  await expect(dialog.getByText("Enables Docker support.")).toBeVisible();
  await dialog.getByText("Privileged workers", { exact: true }).click();
  await expect(privileged).toBeChecked();
  await expect(privileged).toBeEnabled();
  await dialog.getByText("Privileged workers", { exact: true }).click();
  await expect(privileged).not.toBeChecked();
  await expect(privileged).toBeEnabled();
  expect(updates).toEqual([{ privileged: true }, { privileged: false }]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("Settings explains when workers are unavailable and loads them on retry", async ({
  page,
  context,
}) => {
  await prepareWorkspace(context);
  let starting = true;
  await context.route("**/v1/settings/workers", (route) =>
    starting
      ? route.fulfill({
          status: 503,
          json: {
            code: "WORKERS_UNAVAILABLE",
            message: "Workers aren’t available right now.",
          },
        })
      : route.fulfill({ json: { privileged: true } }),
  );
  await page.goto("/");
  await openWorkspaceAction(page, "Settings");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("alert")).toContainText(
    "Worker settings aren’t available right now.",
  );
  starting = false;
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    dialog.getByRole("switch", { name: "Privileged workers" }),
  ).toBeChecked();
});
