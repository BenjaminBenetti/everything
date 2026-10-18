import {
  expect,
  test,
  type BrowserContext,
  type Locator,
} from "@playwright/test";

/** Provide repeatable teammates without changing the user's saved team. */
async function workspace(context: BrowserContext): Promise<void> {
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "avatar-motion-fixture",
          displayName: "Avatar preview",
        },
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
        agents: ["Cat", "Another cat", "Fox"].map((name, index) => ({
          id: `animation-teammate-${index}`,
          name,
          avatarId: index === 2 ? "avatar-03" : "avatar-01",
          systemPrompt: "Help with everyday tasks.",
          inference: null,
          createdAt: "2026-01-01T00:00:00Z",
        })),
      },
    }),
  );
}

/** Seek a real browser animation to a reproducible point in its repeating cycle. */
async function seekBlink(eyes: Locator, fraction: number): Promise<void> {
  await eyes.evaluate((element, progress) => {
    const animation = element.getAnimations()[0]!;
    const timing = animation.effect!.getTiming();
    animation.pause();
    animation.currentTime =
      (timing.delay ?? 0) + Number(timing.duration) * (1 + progress);
  }, fraction);
}

test("team avatars blink independently while sidebar and editor artwork stay still", async ({
  page,
  context,
}, info) => {
  await workspace(context);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/team");
  const cards = page.locator(".agent-card");
  const first = cards.first();
  const second = cards.nth(1);
  const eyes = first.locator(".avatar-idle-eyes");
  await expect(eyes).toBeAttached();
  await second.scrollIntoViewIfNeeded();
  await expect(second.locator(".avatar-idle-eyes")).toBeAttached();
  const firstTiming = await eyes.evaluate((element) => ({
    duration: getComputedStyle(element).animationDuration,
    delay: getComputedStyle(element).animationDelay,
  }));
  const secondTiming = await second
    .locator(".avatar-idle-eyes")
    .evaluate((element) => ({
      duration: getComputedStyle(element).animationDuration,
      delay: getComputedStyle(element).animationDelay,
    }));
  expect(firstTiming).not.toEqual(secondTiming);
  const sidebar = page.locator(".sidebar .teammate-avatar");
  await expect(sidebar).toHaveCount(3);
  expect(
    await sidebar.evaluateAll(
      (elements) =>
        elements.flatMap((element) => element.getAnimations({ subtree: true }))
          .length,
    ),
  ).toBe(0);
  await expect(sidebar.locator(".avatar-animation")).toHaveCount(0);

  await first.scrollIntoViewIfNeeded();
  await expect(eyes).toBeAttached();
  await seekBlink(eyes, 0.1);
  await expect(eyes).toHaveCSS("opacity", "0");
  const open = await first.locator(".teammate-avatar").screenshot();
  await seekBlink(eyes, 0.34);
  await expect(eyes).toHaveCSS("opacity", "1");
  const closed = await first.locator(".teammate-avatar").screenshot();
  expect(open.equals(closed)).toBe(false);
  await page.screenshot({ path: info.outputPath("team-idle-blink.png") });

  await page.getByRole("button", { name: "Edit Cat", exact: true }).click();
  await expect(page.locator(".teammate-avatar-field img")).toBeVisible();
  await expect(
    page.getByRole("dialog").locator(".avatar-animation"),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Change avatar", exact: true })
    .click();
  await expect(page.locator(".avatar-choice")).toHaveCount(64);
  await expect(
    page.getByRole("dialog").locator(".avatar-animation"),
  ).toHaveCount(0);
});

test("reduced motion keeps the original artwork and responds to preference changes", async ({
  page,
  context,
}) => {
  await workspace(context);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/team");
  const avatar = page.locator(".agent-card .teammate-avatar").first();
  await expect(avatar.locator("img")).toBeVisible();
  await expect(page.locator(".avatar-idle-eyes")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(avatar.locator(".avatar-idle-eyes")).toBeAttached();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".avatar-idle-eyes")).toHaveCount(0);
  await expect(avatar.locator("img")).toBeVisible();
});

test("effects wait for the artwork to load", async ({ page, context }) => {
  await workspace(context);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let releaseImages: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    releaseImages = resolve;
  });
  await context.route("**/teammate-avatars/*.webp", async (route) => {
    await ready;
    await route.continue();
  });
  try {
    await page.goto("/team", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".agent-card")).toHaveCount(3);
    await expect(page.locator(".avatar-animation")).toHaveCount(0);
    releaseImages();
    await expect(
      page.locator(".agent-card .avatar-idle-eyes").first(),
    ).toBeAttached();
  } finally {
    releaseImages();
  }
});

test("offscreen avatars release their effects and leaving the team removes playback", async ({
  page,
  context,
}) => {
  await workspace(context);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/team");
  const avatar = page.locator(".agent-card .teammate-avatar").first();
  await expect(avatar.locator(".avatar-idle-eyes")).toBeAttached();
  await page.locator(".agent-grid").evaluate((element) => {
    (element as HTMLElement).style.marginTop = "200vh";
  });
  await expect(avatar.locator(".avatar-idle-eyes")).toHaveCount(0);
  await expect(avatar.locator(".avatar-animation")).toHaveAttribute(
    "data-animation-active",
    "false",
  );
  await page.locator(".agent-grid").evaluate((element) => {
    (element as HTMLElement).style.marginTop = "";
  });
  await expect(avatar.locator(".avatar-idle-eyes")).toBeAttached();
  await page
    .getByRole("navigation", {
      name:
        (page.viewportSize()?.width ?? 1000) < 650
          ? "Mobile workspace"
          : "Workspace",
      exact: true,
    })
    .getByRole("link", { name: "Home", exact: true })
    .click();
  await expect(page.locator(".avatar-animation")).toHaveCount(0);
});
