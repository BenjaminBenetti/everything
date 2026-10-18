import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

/** Keep focus checks independent of real teammates, model providers, and workspaces. */
async function prepareControls(context: BrowserContext): Promise<void> {
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: { subject: "input-focus-fixture", displayName: "Focus check" },
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
    route.fulfill({
      json: {
        agents: [
          {
            id: "avery",
            name: "Avery",
            avatarId: "avatar-03",
            systemPrompt: "Help with project planning.",
            createdAt: "2026-10-14T10:00:00Z",
            inference: {
              provider: "openai-compatible",
              model: "o3-mini",
              effort: "high",
            },
          },
        ],
      },
    }),
  );
  await context.route("**/v1/workspaces", (route) =>
    route.fulfill({
      json: {
        workspaces: [
          {
            type: "web",
            name: "preview-1",
            status: "stopped",
            resources: { cpuCores: 0, memoryBytes: 0 },
          },
        ],
      },
    }),
  );
  await context.route("**/v1/agents/avery/runtime", (route) =>
    route.fulfill({
      json: {
        status: "idle",
        compacting: false,
        compactionStartedAt: null,
        typing: false,
        backgroundCount: 0,
        sessionId: "focus-session",
        runId: null,
        error: null,
      },
    }),
  );
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [], observedAt: new Date().toISOString() },
    }),
  );
  await context.route("**/v1/agents/avery/messages**", (route) =>
    route.fulfill({ json: { messages: [], nextCursor: null } }),
  );
}

/** The text control has no inner ring; its full surrounding surface carries the active border. */
async function expectOuterFocus(field: Locator): Promise<void> {
  await expect(field).toBeFocused();
  await expect(field).toHaveCSS("outline-style", "none");
  const surface = field.locator("..");
  await expect(surface).toHaveCSS("outline-style", "solid");
  await expect(surface).toHaveCSS("outline-width", "2px");
  const colors = await surface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineColor, border: style.borderTopColor };
  });
  expect(colors.outline).toBe(colors.border);
}

/** Both clicking the icon and tabbing back into the control highlight the same outer boundary. */
async function checkSearchFocus(page: Page, label: string): Promise<Locator> {
  const field = page.getByRole("searchbox", { name: label, exact: true });
  const surface = field.locator("..");
  await surface.locator("svg").click();
  await expectOuterFocus(field);
  await field.press("Tab");
  await expect(surface).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Shift+Tab");
  await expectOuterFocus(field);
  return field;
}

for (const theme of ["midnight", "daylight"]) {
  test(`searches and chat share outer focus while standalone fields and buttons keep keyboard focus (${theme})`, async ({
    page,
    context,
  }, info) => {
    await prepareControls(context);
    await page.goto(`/workspaces?theme=${theme}`);
    const workspaceSearch = await checkSearchFocus(page, "Search workspaces");
    await workspaceSearch.fill("preview");
    await expect(
      page.getByRole("article", { name: "preview-1" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`workspaces-focus-${theme}.png`),
      animations: "disabled",
    });

    await page.goto("/team");
    const teamSearch = await checkSearchFocus(page, "Search teammates");
    await teamSearch.fill("Avery");
    await expect(
      page.getByRole("link", { name: "Chat with Avery" }),
    ).toBeVisible();
    await teamSearch.fill("no matching teammate");
    await expect(
      page.getByText("No matching teammates. Try another name."),
    ).toBeVisible();
    await teamSearch.clear();
    await page
      .getByRole("button", { name: "New teammate", exact: true })
      .click();
    const name = page.getByRole("textbox", {
      name: "Teammate name",
      exact: true,
    });
    await name.click();
    await expect(name).toHaveCSS("outline-style", "solid");
    await page
      .getByRole("button", { name: "Change avatar", exact: true })
      .click();
    const avatarSearch = await checkSearchFocus(page, "Search avatars");
    await avatarSearch.fill("Fox");
    await expect(
      page.getByRole("radio", { name: "Fox", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(1);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page
      .getByRole("link", { name: "Chat with Avery", exact: true })
      .click();
    const message = page.getByRole("textbox", {
      name: "Message Avery",
      exact: true,
    });
    await message.fill("A draft to check keyboard focus");
    await expectOuterFocus(message);
    await page.screenshot({
      path: info.outputPath(`composer-focus-${theme}.png`),
      animations: "disabled",
    });
    await message.press("Tab");
    const send = page.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    await expect(send).toBeFocused();
    await expect(send).toHaveCSS("outline-style", "solid");
    await expect(message.locator("..")).toHaveCSS("outline-style", "solid");
    await send.press("Tab");
    await expect(message.locator("..")).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Shift+Tab");
    await expect(send).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expectOuterFocus(message);
  });
}
