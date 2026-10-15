import {
  expect,
  test,
  type BrowserContext,
  type Locator,
} from "@playwright/test";

/** Isolate chat workspace feedback from provider inference and real workspace lifecycle actions. */
async function prepare(context: BrowserContext) {
  const now = new Date().toISOString();
  const recent = new Date(Date.now() - 10_000).toISOString();
  const old = new Date(Date.now() - 60_000).toISOString();
  const state = {
    fail: false,
    observedAt: () => new Date().toISOString(),
    avery: Array.from({ length: 10 }, (_, index) => ({
      type: index > 4 ? "research" : "web",
      name: index === 0 ? "shared-preview" : `workspace-${index}`,
      status: index === 0 ? "creating" : index % 2 ? "running" : "stopped",
      lastInteractedAt: index === 0 ? recent : old,
    })),
    blake: [
      {
        type: "web",
        name: "shared-preview",
        status: "running",
        lastInteractedAt: old,
      },
    ],
  };
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "workspace-activity-fixture",
          displayName: "Workspace check",
        },
      },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({
      json: {
        agents: ["Avery", "Blake"].map((name, index) => ({
          id: name.toLowerCase(),
          name,
          avatarId: index === 0 ? "avatar-03" : "avatar-41",
          systemPrompt: "Help.",
          createdAt: now,
          inference: {
            provider: "openai-compatible",
            model: "o3-mini",
            effort: "high",
          },
        })),
      },
    }),
  );
  await context.route("**/v1/agents/*/runtime", (route) =>
    route.fulfill({
      json: {
        status: "idle",
        compacting: false,
        typing: false,
        backgroundCount: 0,
        sessionId: null,
        runId: null,
        error: null,
      },
    }),
  );
  await context.route("**/v1/agents/*/messages**", (route) =>
    route.fulfill({ json: { messages: [], nextCursor: null } }),
  );
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill(
      state.fail
        ? { status: 503, json: {} }
        : {
            json: {
              observedAt: state.observedAt(),
              workspaces: route.request().url().includes("/avery/")
                ? state.avery
                : state.blake,
            },
          },
    ),
  );
  return state;
}

/** Seek the actual typing animation so both hand positions can be checked without timing races. */
async function seekTyping(hand: Locator, fraction: number): Promise<void> {
  await hand.evaluate((element, progress) => {
    const animation = element.getAnimations()[0]!;
    const timing = animation.effect!.getTiming();
    animation.pause();
    animation.currentTime =
      Number(timing.delay) + Number(timing.duration) * (1 + progress);
  }, fraction);
}

test("the card sits below model details, updates workspace states, and isolates activity when switching chats", async ({
  page,
  context,
}, info) => {
  const state = await prepare(context);
  await page.goto("/team/avery");
  const card = page.getByRole("complementary", {
    name: "Workspaces",
    exact: true,
  });
  await expect(card.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(10);
  await expect(card.getByRole("listitem").first()).toContainText(
    "shared-preview",
  );
  await expect(card.getByRole("listitem").first()).toContainText("Creating");
  const activity = card.getByRole("img", {
    name: "Avery is using this workspace",
  });
  await expect(activity).toBeVisible();
  await expect(activity).toHaveAttribute(
    "title",
    "Avery is using this workspace",
  );
  await expect(activity.locator(".teammate-avatar")).toHaveAttribute(
    "data-avatar-id",
    "avatar-03",
  );
  await expect(activity.locator(".avatar-laptop")).toBeAttached();
  const laptop = await activity.locator(".avatar-laptop").innerHTML();
  const model = await page.locator(".chat-teammate-card").boundingBox();
  const overview = await card.boundingBox();
  expect(overview!.y).toBeGreaterThanOrEqual(model!.y + model!.height);
  state.avery[0]!.status = "running";
  await expect(card.getByRole("listitem").first()).toContainText("Running");
  await page.screenshot({
    path: info.outputPath("chat-workspaces.png"),
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await expect(
    page.getByRole("textbox", { name: "Message Avery", exact: true }),
  ).toBeVisible();

  const row = card.getByRole("listitem").first();
  const nameBefore = await row.locator(".chat-workspace-name").boundingBox();
  const statusBefore = await row
    .locator(".workspace-instance-status")
    .boundingBox();
  const rowBefore = await row.boundingBox();
  state.avery[0]!.lastInteractedAt = new Date(
    Date.now() - 60_000,
  ).toISOString();
  await expect(activity).toHaveCount(0);
  expect(await row.locator(".chat-workspace-name").boundingBox()).toEqual(
    nameBefore,
  );
  expect(await row.locator(".workspace-instance-status").boundingBox()).toEqual(
    statusBefore,
  );
  expect(await row.boundingBox()).toEqual(rowBefore);

  await page
    .getByRole("link", { name: "Back to your team", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Chat with Blake", exact: true })
    .click();
  await expect(card.getByRole("listitem")).toHaveCount(1);
  await expect(card.getByRole("listitem").first()).toContainText(
    "shared-preview",
  );
  await expect(card.getByRole("img")).toHaveCount(0);
  await expect(card.getByText("workspace-1", { exact: true })).toHaveCount(0);
  state.blake[0]!.lastInteractedAt = new Date().toISOString();
  const blakeActivity = card.getByRole("img", {
    name: "Blake is using this workspace",
  });
  await expect(blakeActivity.locator(".teammate-avatar")).toHaveAttribute(
    "data-avatar-id",
    "avatar-41",
  );
  await expect(blakeActivity.locator(".avatar-laptop")).toBeAttached();
  expect(await blakeActivity.locator(".avatar-laptop").innerHTML()).toBe(
    laptop,
  );
  await page.screenshot({
    path: info.outputPath("robot-workspace.png"),
    animations: "disabled",
  });
  state.blake = [];
  await expect(
    card.getByText("Blake isn't using a workspace right now"),
  ).toBeVisible();
});

test("the 30-second indication expires despite a failed poll and a different browser clock", async ({
  page,
  context,
}) => {
  const state = await prepare(context);
  state.observedAt = () => "2020-01-01T00:00:26.000Z";
  state.avery = [
    {
      type: "web",
      name: "shared-preview",
      status: "running",
      lastInteractedAt: "2020-01-01T00:00:00.000Z",
    },
  ];
  const clock = new Date("2036-01-01T00:00:00.000Z");
  await page.clock.install({ time: clock });
  await page.goto("/team/avery");
  const card = page.getByRole("complementary", {
    name: "Workspaces",
    exact: true,
  });
  await expect(card.getByRole("img")).toHaveCount(1);
  state.fail = true;
  await expect(
    card.getByText("Workspace updates unavailable. Reconnecting…"),
  ).toBeVisible();
  await expect(card.getByRole("img")).toHaveCount(1);
  await expect(card.getByRole("img")).toHaveCount(0, { timeout: 6_000 });
  await expect(card.getByText("shared-preview", { exact: true })).toBeVisible();
  await expect(
    card.getByText("Status unavailable", { exact: true }),
  ).toBeVisible();
});

test("the avatar types on its laptop and keeps a still pose with reduced motion", async ({
  page,
  context,
}, info) => {
  const state = await prepare(context);
  state.avery = [state.avery[0]!];
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/team/avery");
  const activity = page.getByRole("img", {
    name: "Avery is using this workspace",
  });
  const playback = activity.locator(".avatar-animation");
  await expect(playback).toHaveAttribute("data-animation-active", "true");
  const hand = activity.locator(".hand-left");
  await seekTyping(hand, 0);
  const raised = await hand.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await seekTyping(hand, 0.2);
  const pressed = await hand.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  expect(pressed).not.toBe(raised);
  await activity.screenshot({ path: info.outputPath("typing-avatar.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(playback).toHaveAttribute("data-animation-active", "false");
  await expect(activity.locator("img")).toBeVisible();
  await expect(activity.locator(".avatar-laptop")).toBeAttached();
  expect(
    await activity.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(playback).toHaveAttribute("data-animation-active", "true");
  expect(
    await activity.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBeGreaterThan(0);
});
