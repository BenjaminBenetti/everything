import { test, expect, type Page } from "@playwright/test";

/** Sign in on the application page; development defaults are the committed local seed. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#username").fill(process.env.UI_TEST_USERNAME ?? "owner");
  await page.locator("#password").fill(process.env.UI_TEST_PASSWORD ?? "owner");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.locator(".shell")).toBeVisible();
}

/** Select the visible navigation on desktop or phone. */
async function navigate(page: Page, label: string): Promise<void> {
  const nav = page.getByRole("navigation", {
    name:
      (page.viewportSize()?.width ?? 1000) < 650
        ? "Mobile workspace"
        : "Workspace",
    exact: true,
  });
  await nav.getByRole("link", { name: label }).click();
}

test("real sign-in, all non-chat pages, themes, deep links, and sign-out", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await navigate(
    page,
    (page.viewportSize()?.width ?? 1000) < 650 ? "Team" : "Your team",
  );
  await expect(
    page.getByRole("heading", { name: "Your team.", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your team.", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/team$/);
  await navigate(page, "Updates");
  await expect(
    page.getByRole("heading", { name: "Your updates." }),
  ).toBeVisible();
  await navigate(page, "Artifacts");
  await expect(
    page.getByRole("heading", { name: "Made together." }),
  ).toBeVisible();
  await page.locator('button[aria-label="Open preferences"]:visible').click();
  await expect(
    page.getByRole("dialog", { name: "Preferences", exact: true }),
  ).toBeVisible();
  await expect(page.locator("select")).toHaveCount(0);
  for (const theme of [
    "midnight",
    "midnight-dimmed",
    "graphite",
    "graphite-dimmed",
    "daylight",
    "sand",
  ]) {
    await page
      .locator(".choice-card")
      .filter({ has: page.locator('input[value="' + theme + '"]') })
      .click();
    await expect(page.getByRole("radio", { checked: true })).toHaveValue(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(
    page.getByRole("heading", { name: "Preferences", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeInViewport();
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: info.outputPath("preferences.png") });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('button[aria-label="Open preferences"]:visible'),
  ).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sand");
  await expect(
    page.getByRole("heading", { name: "Made together." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notification settings" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Push notifications aren’t available yet",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Notification settings" }),
  ).toBeFocused();
  await page.getByRole("button", { name: /Model providers/ }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "No account is connected",
  );
  await page.getByRole("button", { name: "Got it" }).click();
  await navigate(page, "Home");
  await page.locator('button[aria-label="Open preferences"]:visible').click();
  await expect(
    page.getByRole("radio", { name: "Sand", exact: true }),
  ).toBeChecked();
  await page.getByRole("radio", { name: "Sand", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "Midnight", exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.locator('button[aria-label="Open preferences"]:visible'),
  ).toBeFocused();
  await expect(page.locator(".route-content")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("home.png") });
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("installed shell shows an offline fallback without caching private responses", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  const cachedPaths = await page.evaluate(async () => {
    const cache = await caches.open("everything-offline-v1");
    return (await cache.keys())
      .map((request) => new URL(request.url).pathname)
      .sort();
  });
  expect(cachedPaths).toEqual([
    "/brand/icon.svg",
    "/offline.css",
    "/offline.html",
  ]);
  await context.setOffline(true);
  await page.goto("/team");
  await expect(
    page.getByRole("heading", { name: "A moment to reconnect." }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page.locator(".shell")).toBeVisible();
});

test("creates and renames a durable definition without invoking any chat endpoint", async ({
  page,
}, info) => {
  const chatRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/v1\/agents\/[^/]+\/(messages|runtime|interrupt)/.test(req.url()))
      chatRequests.push(req.url());
  });
  await signIn(page);
  await navigate(
    page,
    (page.viewportSize()?.width ?? 1000) < 650 ? "Team" : "Your team",
  );
  const name = `UI check ${crypto.randomUUID().slice(0, 8)}`;
  let agentId: string | undefined;
  try {
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page.getByRole("textbox", { name: "Agent name" }).fill(name);
    await page
      .getByRole("textbox", { name: "A little about them" })
      .fill("Keep this saved instruction unchanged.");
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/v1/agents"),
    );
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    const response = await created;
    expect(response.status()).toBe(201);
    agentId = (await response.json()).id;
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `Rename ${name}`, exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Agent name" })
      .fill(`${name} renamed`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("heading", { name: `${name} renamed`, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: `${name} renamed`, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "Search agents" })
      .fill("No matching name at all");
    await expect(
      page.getByText("No matching agents.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Search agents" }).fill(name);
    await page
      .getByRole("button", { name: `View ${name} renamed`, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Keep this saved instruction unchanged.",
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator(".route-content")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath("team.png") });
    expect(chatRequests).toEqual([]);
    const storedKeys = await page.evaluate(() => Object.keys(localStorage));
    expect(storedKeys).toEqual(["everything-theme"]);
  } finally {
    if (agentId)
      expect(
        (
          await page.request.delete(`/v1/agents/${agentId}`, {
            headers: { origin: new URL(page.url()).origin },
          })
        ).status(),
      ).toBe(204);
  }
});

test("API failure offers retry and dialogs preserve the unsaved name", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/v1/agents", (route) =>
    route.fulfill({ status: 503, json: { message: "Internal failure" } }),
  );
  await page.goto("/team");
  await expect(page.getByRole("alert")).toContainText("Please try again");
  await page.unroute("**/v1/agents");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Agent name" }).fill("Unsaved name");
  await page.route("**/v1/agents", (route) =>
    route.fulfill({ status: 503, json: { message: "Internal failure" } }),
  );
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Agent name" })).toHaveValue(
    "Unsaved name",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "New agent", exact: true }),
  ).toBeFocused();
});

test("inline credential errors, private cookies, deep-link sign-in and revoked-cookie replay", async ({
  page,
  context,
  request,
}, info) => {
  const providerRequests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/auth/"))
      providerRequests.push(req.url());
  });
  await page.goto("/team");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.locator("select")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open preferences" }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("login.png") });
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.UI_TEST_USERNAME ?? "owner");
  await page
    .getByLabel("Password", { exact: true })
    .fill("incorrect-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "username or password is incorrect",
  );
  await expect(page).toHaveURL(/\/team$/);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.UI_TEST_PASSWORD ?? "owner");
  const signedIn = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/session") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await signedIn;
  expect(response.status()).toBe(200);
  expect(Object.keys(await response.json())).toEqual(["profile"]);
  await expect(
    page.getByRole("heading", { name: "Your team.", exact: true }),
  ).toBeVisible();
  const cookie = (await context.cookies()).find((item) =>
    item.name.endsWith("everything-session"),
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Strict");
  expect(cookie.secure).toBe(new URL(page.url()).protocol === "https:");
  const storage = await page.evaluate(() => ({
    cookies: document.cookie,
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  expect(storage.cookies).not.toContain("everything-session");
  expect(storage.local.every((key) => key === "everything-theme")).toBe(true);
  expect(storage.session).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your team.", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const replay = await request.get("/v1/agents", {
    headers: { cookie: cookie.name + "=" + cookie.value },
  });
  expect(replay.status()).toBe(401);
  expect(providerRequests).toEqual([]);
});
