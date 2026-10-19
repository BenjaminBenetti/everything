import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface Runtime {
  status: "idle" | "running" | "error";
  mainRunning: boolean;
  compacting: boolean;
  compactionStartedAt: string | null;
  typing: boolean;
  backgroundCount: number;
  sessionId: string | null;
  runId: string | null;
  error: string | null;
}

/** A loaded teammate with nothing running. */
const idle: Runtime = {
  status: "idle",
  mainRunning: false,
  compacting: false,
  compactionStartedAt: null,
  typing: false,
  backgroundCount: 0,
  sessionId: "private-session-id",
  runId: null,
  error: null,
};

/** Synthetic teammates and history; Avery's runtime status is controlled by each test. */
async function workspace(context: BrowserContext) {
  const state = {
    avery: { ...idle },
    failRuntime: false,
    /** While set, Avery's status reads wait until the test releases them. */
    hold: null as Promise<void> | null,
  };
  // Registered first, so it only answers what no specific route below handles.
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: { subject: "thinking-test-owner", displayName: "Demo owner" },
      },
    }),
  );
  await context.route("**/v1/settings/teammate-order", (route) =>
    route.fulfill({ json: { teammateIds: [] } }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  const teammates = ["Avery", "Blake"].map((name) => ({
    id: name.toLowerCase(),
    name,
    avatarId: name === "Avery" ? "avatar-03" : "avatar-26",
    systemPrompt: "Help with project planning.",
    createdAt: "2026-10-12T10:00:00Z",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  }));
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: teammates } }),
  );
  await context.route("**/v1/agents/recent", (route) =>
    route.fulfill({ json: { agents: teammates } }),
  );
  await context.route("**/v1/agents/*/interactions", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/v1/agents/*/runtime", async (route) => {
    if (!route.request().url().includes("/avery/"))
      return route.fulfill({ json: idle });
    if (state.hold) await state.hold;
    if (state.failRuntime)
      return route.fulfill({
        status: 503,
        json: { code: "UNAVAILABLE", message: "Service unavailable" },
      });
    return route.fulfill({ json: state.avery });
  });
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [], observedAt: new Date().toISOString() },
    }),
  );
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        messages: route.request().url().includes("/avery/")
          ? [
              {
                id: "message-1",
                role: "user",
                text: "Can you draft the launch checklist?",
                createdAt: "2026-10-12T10:00:00Z",
              },
              {
                id: "message-2",
                role: "assistant",
                text: "Sure. I'll check the open tasks first.",
                createdAt: "2026-10-12T10:00:30Z",
              },
            ]
          : [],
        nextCursor: null,
      },
    }),
  );
  await context.route("**/v1/agents/*/messages/read", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/v1/updates", (route) =>
    route.fulfill({ json: { updates: [], nextCursor: null } }),
  );
  await context.route("**/v1/updates/count", (route) =>
    route.fulfill({ json: { unread: 0, byAgent: {} } }),
  );
  return state;
}

/** The main teammate's avatar where this layout shows it: the header on narrow screens, otherwise the info card. */
function mainAvatar(page: Page) {
  return (page.viewportSize()?.width ?? 1440) <= 1100
    ? page.locator(".chat-mobile-header > .teammate-avatar")
    : page.locator(".chat-teammate-card .teammate-avatar");
}

/** The heading beside that avatar, used to confirm the layout doesn't move. */
function mainHeading(page: Page) {
  return (page.viewportSize()?.width ?? 1440) <= 1100
    ? page.locator(".chat-mobile-identity h1")
    : page.locator(".chat-teammate-identity h1");
}

/** Let the page's entrance animation finish so measurements compare the final layout. */
async function settled(page: Page): Promise<void> {
  await page
    .locator(".route-content")
    .evaluate((element) =>
      Promise.all(element.getAnimations().map((motion) => motion.finished)),
    );
}

/** Count running browser animations inside an element. */
function animations(page: Page) {
  return mainAvatar(page).evaluate(
    (element) => element.getAnimations({ subtree: true }).length,
  );
}

test("only the main teammate's own work shows the thinking pose, beside the background count", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/team/avery");
  const avatar = mainAvatar(page);
  const thinking = avatar.locator('[data-avatar-animation="thinking"]');
  const working = page.getByText("Avery is working", { exact: true });
  const background = page.getByRole("status", {
    name: "Active background teammates",
  });
  await expect(page.getByRole("log")).toContainText("launch checklist");
  await expect(avatar.locator("img")).toBeVisible();
  await expect(page.locator('[data-avatar-animation="thinking"]')).toHaveCount(
    0,
  );
  await expect(working).toHaveCount(0);
  await settled(page);
  const resting = (await avatar.boundingBox())!;
  const heading = (await mainHeading(page).boundingBox())!;
  await page.screenshot({ path: info.outputPath("idle.png") });

  state.avery = { ...idle, status: "running", backgroundCount: 2 };
  await expect(background).toHaveText("2 background", { timeout: 10_000 });
  await expect(page.locator('[data-avatar-animation="thinking"]')).toHaveCount(
    0,
  );
  await expect(working).toHaveCount(0);
  // The phone header's background line moves the name up; thinking must not move anything further.
  const besideBackground = (await mainHeading(page).boundingBox())!;
  await page.screenshot({ path: info.outputPath("background-only.png") });

  state.avery = { ...state.avery, mainRunning: true };
  await expect(thinking).toBeAttached();
  await expect(thinking).toHaveAttribute("data-animation-active", "true");
  await expect(thinking.locator(".avatar-thought-cloud")).toBeVisible();
  await expect(thinking.locator(".avatar-thinking-paw")).toBeVisible();
  await expect(working).toBeAttached();
  await expect(background).toHaveText("2 background");
  expect(await animations(page)).toBeGreaterThan(0);
  expect(await avatar.boundingBox()).toEqual(resting);
  expect(await mainHeading(page).boundingBox()).toEqual(besideBackground);
  // Teammates in navigation keep their still artwork; only the open conversation knows main's state.
  await expect(page.locator(".sidebar .avatar-animation")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("thinking-with-background.png"),
  });
  await avatar.screenshot({ path: info.outputPath("thinking-avatar.png") });

  state.avery = { ...state.avery, backgroundCount: 0, typing: true };
  await expect(background).toHaveCount(0);
  await expect(page.locator(".chat-typing-bubble")).toBeVisible();
  await expect(thinking).toBeAttached();
  expect(await avatar.boundingBox()).toEqual(resting);
  expect(await mainHeading(page).boundingBox()).toEqual(heading);

  state.avery = {
    ...idle,
    status: "error",
    error:
      "Your teammate couldn’t finish replying. Check the model provider, then send a message to continue.",
  };
  await expect(
    page.getByRole("alert").filter({ hasText: "couldn’t finish" }),
  ).toBeVisible();
  await expect(thinking).toHaveCount(0);
  await expect(working).toHaveCount(0);
  expect(await avatar.boundingBox()).toEqual(resting);

  // A fork's result can wake the main teammate without a new message.
  state.avery = { ...idle, status: "running", mainRunning: true };
  await expect(thinking).toBeAttached({ timeout: 10_000 });
  state.avery = { ...idle };
  await expect(thinking).toHaveCount(0);
  await expect(working).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1440) > 1100)
    await expect(
      avatar.locator('[data-avatar-animation="idle"]'),
    ).toBeAttached();
});

test("reduced motion holds a still thinking pose at the same size", async ({
  page,
  context,
}, info) => {
  const state = await workspace(context);
  state.avery = { ...idle, status: "running", mainRunning: true };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/team/avery");
  const avatar = mainAvatar(page);
  const thinking = avatar.locator('[data-avatar-animation="thinking"]');
  await expect(thinking).toBeAttached();
  await expect(thinking).toHaveAttribute("data-animation-active", "false");
  await expect(thinking.locator(".avatar-thought-cloud")).toBeVisible();
  await expect(thinking.locator(".avatar-thinking-paw")).toBeVisible();
  await expect(
    page.getByText("Avery is working", { exact: true }),
  ).toBeAttached();
  expect(await animations(page)).toBe(0);
  await settled(page);
  const still = (await avatar.boundingBox())!;
  await avatar.screenshot({ path: info.outputPath("thinking-still.png") });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(thinking).toHaveAttribute("data-animation-active", "true");
  expect(await animations(page)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(thinking).toHaveAttribute("data-animation-active", "false");
  expect(await animations(page)).toBe(0);

  state.avery = { ...idle };
  await expect(thinking).toHaveCount(0);
  expect(await avatar.boundingBox()).toEqual(still);
});

test("stale work never lingers after a failed refresh or on returning to the conversation", async ({
  page,
  context,
}) => {
  const state = await workspace(context);
  state.avery = { ...idle, status: "running", mainRunning: true };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/team/avery");
  const thinking = mainAvatar(page).locator(
    '[data-avatar-animation="thinking"]',
  );
  await expect(thinking).toBeAttached();

  state.failRuntime = true;
  const reconnect = page.getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible();
  await expect(thinking).toHaveCount(0);
  state.failRuntime = false;
  await reconnect.click();
  await expect(thinking).toBeAttached();

  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Chat with Blake", exact: true })
    .click();
  await expect(page.getByRole("log")).toBeEmpty();
  await expect(page.locator('[data-avatar-animation="thinking"]')).toHaveCount(
    0,
  );

  // Avery finished while away; the cached snapshot from the earlier visit still says running.
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
    await expect(thinking).toHaveCount(0);
    const fresh = page.waitForResponse("**/v1/agents/avery/runtime");
    state.hold = null;
    release();
    await fresh;
    await expect(thinking).toHaveCount(0);
  } finally {
    state.hold = null;
    release();
  }
  state.avery = { ...idle, status: "running", mainRunning: true };
  await expect(thinking).toBeAttached({ timeout: 10_000 });
});
