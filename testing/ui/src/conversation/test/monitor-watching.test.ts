import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  activityWorkspace,
  animations,
  idle,
  mainAvatar,
  mainHeading,
  mainPresence,
  settled,
} from "../fixture/teammate-activity.js";

/** Idle status reads repeat every five seconds, so changes from rest can take that long to appear. */
const idlePoll = { timeout: 10_000 };

/** Open the count the way this device would: a tap on touch screens, otherwise the pointer. */
async function point(page: Page, info: TestInfo): Promise<void> {
  if (info.project.use.hasTouch) await mainPresence(page).tap();
  else await mainPresence(page).hover();
}

test("while only monitors run, the avatar watches and names their count on hover, focus, and touch", async ({
  page,
  context,
}, info) => {
  const state = await activityWorkspace(context);
  state.avery = { ...idle, monitorCount: 1 };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/team/avery");
  const avatar = mainAvatar(page);
  const presence = mainPresence(page);
  const watching = avatar.locator('[data-avatar-animation="watching"]');
  const thinking = avatar.locator('[data-avatar-animation="thinking"]');
  const tooltip = page.getByRole("tooltip");
  const background = page.getByRole("status", {
    name: "Active background teammates",
  });
  await expect(page.getByRole("log")).toContainText("launch checklist");
  await expect(watching).toBeAttached();
  await expect(watching).toHaveAttribute("data-animation-active", "true");
  await expect(watching.locator(".avatar-magnifier")).toBeVisible();
  await expect(page.locator('[data-avatar-animation="thinking"]')).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Avery is watching 1 monitor", { exact: true }),
  ).toBeAttached();
  await expect(background).toHaveCount(0);
  expect(await animations(page)).toBeGreaterThan(0);
  await settled(page);
  const resting = (await avatar.boundingBox())!;
  const heading = (await mainHeading(page).boundingBox())!;
  await expect(tooltip).toHaveCount(0);

  await point(page, info);
  await expect(tooltip).toHaveText("1 monitor running");
  await expect(presence).toHaveAccessibleName("Avery is watching monitors");
  await expect(presence).toHaveAccessibleDescription("1 monitor running");
  await page.screenshot({ path: info.outputPath("watching-count.png") });
  await avatar.screenshot({ path: info.outputPath("watching-avatar.png") });
  await presence.focus();
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(presence).toBeFocused();
  // The avatar sits in the normal tab order while it watches.
  await page.keyboard.press("Shift+Tab");
  await expect(presence).not.toBeFocused();
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(presence).toBeFocused();
  await expect(tooltip).toHaveText("1 monitor running");

  state.avery = { ...state.avery, monitorCount: 3 };
  await expect(tooltip).toHaveText("3 monitors running", idlePoll);
  await expect(
    page.getByText("Avery is watching 3 monitors", { exact: true }),
  ).toBeAttached();
  await presence.blur();
  await expect(tooltip).toHaveCount(0);

  // Background teammates keep their own indicator; they don't change the pose.
  state.avery = {
    ...state.avery,
    status: "running",
    backgroundCount: 2,
  };
  await expect(background).toHaveText("2 background", idlePoll);
  await expect(watching).toBeAttached();
  await expect(thinking).toHaveCount(0);

  // The main session's own work outranks its monitors.
  state.avery = { ...state.avery, mainRunning: true };
  await expect(thinking).toBeAttached();
  await expect(watching).toHaveCount(0);
  await expect(presence).not.toHaveAttribute("tabindex");
  await expect(presence).not.toHaveAttribute("role");
  await expect(
    page.getByText("Avery is working", { exact: true }),
  ).toBeAttached();
  await point(page, info);
  await expect(tooltip).toHaveCount(0);
  expect(await avatar.boundingBox()).toEqual(resting);

  // The turn ends and two monitors have finished or stopped.
  state.avery = { ...idle, monitorCount: 1 };
  await expect(watching).toBeAttached();
  await expect(thinking).toHaveCount(0);
  await expect(
    page.getByText("Avery is watching 1 monitor", { exact: true }),
  ).toBeAttached();

  state.avery = { ...idle };
  await expect(watching).toHaveCount(0, idlePoll);
  await expect(presence).not.toHaveAttribute("tabindex");
  await expect(page.getByText(/Avery is (watching|working)/)).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1440) > 1100)
    await expect(
      avatar.locator('[data-avatar-animation="idle"]'),
    ).toBeAttached();
  expect(await avatar.boundingBox()).toEqual(resting);
  expect(await mainHeading(page).boundingBox()).toEqual(heading);
  // Teammates in navigation keep their still artwork.
  await expect(page.locator(".sidebar .avatar-animation")).toHaveCount(0);
});

test("monitor counts clear after a failed refresh and on returning to the conversation", async ({
  page,
  context,
}) => {
  const state = await activityWorkspace(context);
  state.avery = { ...idle, monitorCount: 2 };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/team/avery");
  const presence = mainPresence(page);
  const watching = mainAvatar(page).locator(
    '[data-avatar-animation="watching"]',
  );
  await expect(watching).toBeAttached();

  state.failRuntime = true;
  const reconnect = page.getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible(idlePoll);
  await expect(watching).toHaveCount(0);
  await expect(presence).not.toHaveAttribute("tabindex");
  state.failRuntime = false;
  state.avery = { ...idle, monitorCount: 1 };
  await reconnect.click();
  await expect(watching).toBeAttached();
  await expect(
    page.getByText("Avery is watching 1 monitor", { exact: true }),
  ).toBeAttached();

  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Chat with Blake", exact: true })
    .click();
  await expect(page.getByRole("log")).toBeEmpty();
  await expect(page.locator('[data-avatar-animation="watching"]')).toHaveCount(
    0,
  );

  // Avery's monitor finished while away; the cached snapshot from the earlier visit still counts it.
  state.avery = { ...idle };
  let release: () => void = () => undefined;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page
      .getByRole("link", { name: "Back to your team", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Chat with Avery", exact: true })
      .click();
    await expect(page.getByRole("log")).toContainText("launch checklist");
    await expect(mainAvatar(page).locator("img")).toBeVisible();
    await expect(watching).toHaveCount(0);
    const fresh = page.waitForResponse("**/v1/agents/avery/runtime");
    state.hold = null;
    release();
    await fresh;
    await expect(watching).toHaveCount(0);
  } finally {
    state.hold = null;
    release();
  }
  state.avery = { ...idle, monitorCount: 1 };
  await expect(watching).toBeAttached(idlePoll);
});

test("reduced motion holds a still watching pose that still names its count", async ({
  page,
  context,
}, info) => {
  const state = await activityWorkspace(context);
  state.avery = { ...idle, monitorCount: 2 };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/team/avery");
  const avatar = mainAvatar(page);
  const watching = avatar.locator('[data-avatar-animation="watching"]');
  await expect(watching).toBeAttached();
  await expect(watching).toHaveAttribute("data-animation-active", "false");
  await expect(watching.locator(".avatar-magnifier")).toBeVisible();
  expect(await animations(page)).toBe(0);
  await mainPresence(page).focus();
  await expect(page.getByRole("tooltip")).toHaveText("2 monitors running");
  await mainPresence(page).blur();
  await settled(page);
  const still = (await avatar.boundingBox())!;
  await avatar.screenshot({ path: info.outputPath("watching-still.png") });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(watching).toHaveAttribute("data-animation-active", "true");
  expect(await animations(page)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(watching).toHaveAttribute("data-animation-active", "false");
  expect(await animations(page)).toBe(0);

  state.avery = { ...idle };
  await expect(watching).toHaveCount(0, idlePoll);
  expect(await avatar.boundingBox()).toEqual(still);
});
