import type { Page } from "@playwright/test";

/** Open or close the compact details panel while leaving the permanent desktop sidebar alone. */
export async function setConversationDetails(
  page: Page,
  expanded: boolean,
): Promise<void> {
  await page.locator(".chat-page").waitFor();
  const toggle = page.getByRole("button", { name: "Details", exact: true });
  if (await toggle.isVisible()) {
    const current = (await toggle.getAttribute("aria-expanded")) === "true";
    if (current !== expanded) await toggle.click();
  }
}
