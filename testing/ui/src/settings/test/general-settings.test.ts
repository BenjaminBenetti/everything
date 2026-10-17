import { openWorkspaceAction } from "../../workspace/fixture/workspace-menu.js";
import { expect, test, type BrowserContext } from "@playwright/test";

/** Start with saved opt-in preferences outside the page so reloads exercise server-backed state. */
async function workspace(context: BrowserContext) {
  const state = {
    summarizeUpdates: true,
    failRead: false,
    failSave: false,
    changes: [] as unknown[],
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "general-settings-owner",
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
  await context.route("**/v1/settings/workers", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Workers aren’t available right now." },
    }),
  );
  await context.route("**/v1/settings/general", async (route) => {
    if (route.request().method() === "PUT") {
      if (state.failSave) return route.fulfill({ status: 503, json: {} });
      state.changes.push(route.request().postDataJSON());
      state.summarizeUpdates = route.request().postDataJSON().summarizeUpdates;
    } else if (state.failRead) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: { summarizeUpdates: state.summarizeUpdates },
    });
  });
  await context.route("**/v1/updates/count", (route) =>
    route.fulfill({ json: { unread: 1, byAgent: { avery: 1 } } }),
  );
  await context.route(/\/v1\/updates(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        updates: [
          {
            id: "update",
            kind: "message",
            agentId: "avery",
            messageId: "message",
            summary: state.summarizeUpdates
              ? "Needs your approval of the report."
              : "I finished the report. Could you review the attached findings?",
            summaryStatus: state.summarizeUpdates ? "ready" : "disabled",
            createdAt: "2026-10-15T10:00:00Z",
          },
        ],
        nextCursor: null,
      },
    }),
  );
  return state;
}

test("General saves summary preferences across reloads and immediately refreshes update cards", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  await page.goto("/");
  await expect(page.locator(".update-summary")).toHaveText(
    "Needs your approval of the report.",
  );
  await openWorkspaceAction(page, "Settings");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const general = dialog.getByRole("region", { name: "General", exact: true });
  const toggle = general.getByRole("switch", { name: "Summarize updates" });
  await expect(toggle).toBeChecked();
  await expect(general).toContainText(
    "Use AI to summarize teammate messages on update cards.",
  );
  await general.getByText("Summarize updates", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".update-summary")).toHaveText(
    "I finished the report. Could you review the attached findings?",
  );
  await expect(page.locator(".update-label")).toHaveText("Message preview");
  await page.reload();
  await openWorkspaceAction(page, "Settings");
  await expect(toggle).not.toBeChecked();
  await general.getByText("Summarize updates", { exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".update-summary")).toHaveText(
    "Needs your approval of the report.",
  );
  await expect(page.locator(".update-label")).toHaveCount(0);
  expect(state.changes).toEqual([
    { summarizeUpdates: false },
    { summarizeUpdates: true },
  ]);
});

test("General retries loading and restores the saved toggle after a failed save", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  state.failRead = true;
  await page.goto("/");
  await openWorkspaceAction(page, "Settings");
  const general = page.getByRole("region", { name: "General", exact: true });
  await expect(general.getByRole("alert")).toContainText(
    "General settings aren’t available",
  );
  state.failRead = false;
  await general.getByRole("button", { name: "Try again" }).click();
  const toggle = general.getByRole("switch", { name: "Summarize updates" });
  await expect(toggle).toBeChecked();
  state.failSave = true;
  await general.getByText("Summarize updates", { exact: true }).click();
  await expect(general.getByRole("alert")).toHaveText(
    "Couldn’t change this setting. Try again.",
  );
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(state.summarizeUpdates).toBe(true);
  state.failSave = false;
  await general.getByText("Summarize updates", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(general.getByRole("alert")).toHaveCount(0);
});
