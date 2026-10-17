import type { Locator, Page } from "@playwright/test";

/** Resolve the stable desktop action or phone menu button that receives restored focus. */
export function workspaceActionTrigger(
  page: Page,
  name: string | RegExp,
): Locator {
  return page
    .getByRole("button", {
      name:
        (page.viewportSize()?.width ?? 1000) <= 650
          ? "Workspace menu"
          : name === "Preferences"
            ? "Open preferences"
            : name,
      exact: typeof name === "string",
    })
    .last();
}

/** Use the direct desktop action or select it from the phone menu. */
export async function openWorkspaceAction(
  page: Page,
  name: string | RegExp,
): Promise<void> {
  await workspaceActionTrigger(page, name).click();
  if ((page.viewportSize()?.width ?? 1000) <= 650)
    await page
      .getByRole("menuitem", { name, exact: typeof name === "string" })
      .click();
}
