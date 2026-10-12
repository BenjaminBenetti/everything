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

/** Use a connected provider for live creation checks without sending an inference request. */
async function chooseModel(page: Page): Promise<void> {
  const response = await page.request.get("/v1/providers");
  expect(response.status()).toBe(200);
  const { providers } = (await response.json()) as {
    providers: {
      provider: "chatgpt" | "anthropic" | "openai-compatible";
      configured: boolean;
      verifiedAt: string | null;
      status: string;
    }[];
  };
  const active = providers.filter(
    (provider) =>
      provider.configured &&
      provider.verifiedAt &&
      !["error", "disconnected"].includes(provider.status),
  );
  const provider =
    active.find((item) => item.provider === "openai-compatible") ?? active[0];
  test.skip(!provider, "Live teammate creation requires a connected provider.");
  const catalog = await page.request.get(
    `/v1/providers/${provider!.provider}/models`,
  );
  expect(catalog.status()).toBe(200);
  const { models } = (await catalog.json()) as { models: { name: string }[] };
  test.skip(
    models.length === 0,
    "The connected provider has no available models.",
  );
  const labels = {
    chatgpt: "ChatGPT",
    anthropic: "Claude",
    "openai-compatible": "OpenAI-compatible API",
  };
  await page.getByText("Model settings", { exact: true }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page
    .getByRole("option", { name: labels[provider!.provider], exact: true })
    .click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page
    .getByRole("option", { name: models[0]!.name, exact: true })
    .first()
    .click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByText("Model settings", { exact: true }).click();
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
    page.getByRole("heading", { name: "Your team", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your team", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/team$/);
  await navigate(page, "Updates");
  await expect(
    page.getByRole("heading", { name: "Updates", exact: true }),
  ).toBeVisible();
  await navigate(page, "Artifacts");
  await expect(
    page.getByRole("heading", { name: "Artifacts", exact: true }),
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
    page.getByRole("heading", { name: "Artifacts", exact: true }),
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
  for (const name of ["ChatGPT", "Claude", "OpenAI-compatible API"])
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: new RegExp("^" + name) }),
    ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
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
    const cache = await caches.open("everything-offline-v2");
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
    page.getByRole("heading", { name: "You’re offline" }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page.locator(".shell")).toBeVisible();
});

test("creates and edits a durable teammate profile without invoking any chat endpoint", async ({
  page,
}, info) => {
  const chatRequests: string[] = [];
  const profileMutations: string[] = [];
  page.on("request", (req) => {
    if (/\/v1\/agents\/[^/]+\/(messages|runtime|interrupt)/.test(req.url()))
      chatRequests.push(req.url());
    if (
      /\/v1\/agents(?:\/[^/]+)?$/.test(req.url()) &&
      ["POST", "PATCH"].includes(req.method())
    )
      profileMutations.push(req.method());
  });
  await signIn(page);
  await navigate(
    page,
    (page.viewportSize()?.width ?? 1000) < 650 ? "Team" : "Your team",
  );
  const name = `UI check ${crypto.randomUUID().slice(0, 8)}`;
  let agentId: string | undefined;
  try {
    await page
      .getByRole("button", { name: "New teammate", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Teammate name" }).fill(name);
    await page
      .getByRole("textbox", { name: "Description" })
      .fill("Research and summarize findings.");
    await page.getByRole("button", { name: "Change avatar" }).click();
    await expect(page.getByRole("radio")).toHaveCount(64);
    await expect(page.locator("select")).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search avatars" }).fill("Fox");
    await page.getByRole("radio", { name: "Fox", exact: true }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Use avatar" }).click();
    await expect(
      page.getByRole("textbox", { name: "Teammate name" }),
    ).toHaveValue(name);
    await expect(
      page.getByRole("textbox", { name: "Description" }),
    ).toHaveValue("Research and summarize findings.");
    expect(profileMutations).toEqual([]);
    await chooseModel(page);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/v1/agents"),
    );
    await page
      .getByRole("button", { name: "Create teammate", exact: true })
      .click();
    const response = await created;
    expect(response.status()).toBe(201);
    const profile = await response.json();
    agentId = profile.id;
    expect(profile.avatarId).toBe("avatar-03");
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `View ${name}`, exact: true })
      .click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Edit teammate", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Description" }),
    ).toHaveValue("Research and summarize findings.");
    await expect(
      page.locator(".teammate-avatar-field .teammate-avatar"),
    ).toHaveAttribute("data-avatar-id", "avatar-03");
    await page
      .getByRole("textbox", { name: "Teammate name" })
      .fill(`${name} edited`);
    await page
      .getByRole("textbox", { name: "Description" })
      .fill("Review drafts and suggest clear, concise wording.");
    await page.getByRole("button", { name: "Change avatar" }).click();
    await page.getByRole("button", { name: "Creatures", exact: true }).click();
    await expect(page.getByRole("radio")).toHaveCount(16);
    await page
      .locator(".choice-card")
      .filter({ has: page.getByRole("radio", { name: "Robot", exact: true }) })
      .click();
    await expect(
      page.getByRole("button", { name: "Use avatar" }),
    ).toBeInViewport();
    await page.screenshot({ path: info.outputPath("avatar-picker.png") });
    await page.getByRole("button", { name: "Use avatar" }).click();
    expect(profileMutations).toEqual(["POST"]);
    const updated = page.waitForResponse(
      (reply) =>
        reply.request().method() === "PATCH" &&
        reply.url().endsWith(`/v1/agents/${agentId}`),
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const updateResponse = await updated;
    expect(updateResponse.status()).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      name: `${name} edited`,
      systemPrompt: "Review drafts and suggest clear, concise wording.",
      avatarId: "avatar-41",
    });
    await expect(
      page.getByRole("button", { name: `View ${name} edited`, exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("heading", { name: `${name} edited`, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: `${name} edited`, exact: true }),
    ).toBeVisible();
    const card = page.locator(".agent-card").filter({
      has: page.getByRole("heading", { name: `${name} edited`, exact: true }),
    });
    await expect(card.locator(".teammate-avatar")).toHaveAttribute(
      "data-avatar-id",
      "avatar-41",
    );
    await expect(card).toContainText(
      "Review drafts and suggest clear, concise wording.",
    );
    const sidebarItem = page
      .locator(".side-agent")
      .filter({ hasText: `${name} edited` });
    await expect(sidebarItem.locator(".teammate-avatar")).toHaveAttribute(
      "data-avatar-id",
      "avatar-41",
    );
    await expect
      .poll(() =>
        card
          .locator("img")
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: `Edit ${name} edited`, exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Teammate name" })
      .fill("Discarded name");
    await page
      .getByRole("textbox", { name: "Description" })
      .fill("Discarded description");
    await page.getByRole("button", { name: "Change avatar" }).click();
    await page.getByRole("searchbox", { name: "Search avatars" }).fill("Moon");
    await page
      .locator(".choice-card")
      .filter({ has: page.getByRole("radio", { name: "Moon", exact: true }) })
      .click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Change avatar" }),
    ).toBeFocused();
    await expect(
      page.getByRole("textbox", { name: "Description" }),
    ).toHaveValue("Discarded description");
    await expect(
      page.locator(".teammate-avatar-field .teammate-avatar"),
    ).toHaveAttribute("data-avatar-id", "avatar-41");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(profileMutations).toEqual(["POST", "PATCH"]);
    const afterCancel = await page.request.get(`/v1/agents/${agentId}`);
    expect(await afterCancel.json()).toMatchObject({
      name: `${name} edited`,
      systemPrompt: "Review drafts and suggest clear, concise wording.",
      avatarId: "avatar-41",
    });
    await page
      .getByRole("searchbox", { name: "Search teammates" })
      .fill("No matching name at all");
    await expect(
      page.getByText("No matching teammates.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Search teammates" }).fill(name);
    await page
      .getByRole("button", { name: `View ${name} edited`, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Review drafts and suggest clear, concise wording.",
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator(".route-content")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath("team.png") });
    expect(chatRequests).toEqual([]);
    const storedKeys = await page.evaluate(() => Object.keys(localStorage));
    expect(storedKeys).toEqual(["everything-theme"]);
  } finally {
    // Clean up even if an unexpected premature submission failed the draft assertions.
    if (!agentId) {
      const response = await page.request.get("/v1/agents");
      const { agents } = await response.json();
      agentId = agents.find(
        (candidate: { name: string }) => candidate.name === name,
      )?.id;
    }
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

test("API failure offers retry and dialogs preserve every unsaved profile field", async ({
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
  await page.getByRole("button", { name: "New teammate", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Teammate name" })
    .fill("Unsaved name");
  await page
    .getByRole("textbox", { name: "Description" })
    .fill("Unsaved description");
  await page.getByRole("button", { name: "Change avatar" }).click();
  await page.getByRole("searchbox", { name: "Search avatars" }).fill("Potion");
  await page
    .locator(".choice-card")
    .filter({ has: page.getByRole("radio", { name: "Potion", exact: true }) })
    .click();
  await page.getByRole("button", { name: "Use avatar" }).click();
  await chooseModel(page);
  await page.route("**/v1/agents", (route) =>
    route.fulfill({ status: 503, json: { message: "Internal failure" } }),
  );
  await page
    .getByRole("button", { name: "Create teammate", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Teammate name" }),
  ).toHaveValue("Unsaved name");
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Unsaved description",
  );
  await expect(
    page.locator(".teammate-avatar-field .teammate-avatar"),
  ).toHaveAttribute("data-avatar-id", "avatar-64");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "New teammate", exact: true }),
  ).toBeFocused();
});

test("deletion requires confirmation, preserves teammates on cancellation or failure, and updates every listing", async ({
  page,
}, info) => {
  await signIn(page);
  const name = `UI delete ${crypto.randomUUID().slice(0, 8)}`;
  const origin = new URL(page.url()).origin;
  const created = await page.request.post("/v1/agents", {
    headers: { origin },
    data: {
      name,
      systemPrompt: "Temporary deletion check.",
      avatarId: "avatar-29",
    },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const endpoint = `/v1/agents/${id}`;
  const routePattern = `**${endpoint}`;
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().endsWith(endpoint))
      requests.push(request.url());
  });
  let releaseDelete: (() => void) | undefined;
  try {
    await page.goto("/team");
    const card = page.locator(".agent-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await page
      .getByRole("button", { name: `View ${name}`, exact: true })
      .click();
    const deleteButton = page.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    const editButton = page.getByRole("button", { name: "Edit", exact: true });
    const deleteBox = await deleteButton.boundingBox();
    const editBox = await editButton.boundingBox();
    expect(deleteBox!.x + deleteBox!.width).toBeLessThan(editBox!.x);
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    await page.screenshot({ path: info.outputPath("teammate-details.png") });
    await deleteButton.click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Delete teammate?",
    });
    await expect(confirmation).toContainText(name);
    await expect(confirmation).toContainText("This can’t be undone.");
    await expect(
      confirmation.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    expect(requests).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(deleteButton).toBeFocused();
    await deleteButton.click();
    await page.keyboard.press("Escape");
    await expect(deleteButton).toBeFocused();
    expect(requests).toEqual([]);

    await page.route(routePattern, (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({
            status: 503,
            json: { message: "Private upstream failure" },
          })
        : route.continue(),
    );
    await deleteButton.click();
    await expect(
      confirmation.getByRole("button", {
        name: "Delete teammate",
        exact: true,
      }),
    ).toBeInViewport();
    await page.screenshot({ path: info.outputPath("delete-confirmation.png") });
    await confirmation
      .getByRole("button", { name: "Delete teammate", exact: true })
      .click();
    await expect(confirmation.getByRole("alert")).toContainText(
      "Please try again.",
    );
    await expect(confirmation.getByRole("alert")).not.toContainText("Private");
    await expect(card).toHaveCount(1);
    expect((await page.request.get(endpoint)).status()).toBe(200);
    await page.unroute(routePattern);

    const gate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    await page.route(routePattern, async (route) => {
      if (route.request().method() === "DELETE") await gate;
      await route.continue();
    });
    const completed = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(endpoint),
    );
    await confirmation
      .getByRole("button", { name: "Delete teammate", exact: true })
      .click();
    await expect(
      confirmation.getByRole("button", { name: "Deleting…", exact: true }),
    ).toBeDisabled();
    await expect(
      confirmation.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      confirmation.getByRole("button", { name: "Close dialog" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeVisible();
    await expect.poll(() => requests.length).toBe(2);
    releaseDelete!();
    expect((await completed).status()).toBe(204);
    await expect(confirmation).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(
      page.locator(".side-agent").filter({ hasText: name }),
    ).toHaveCount(0);
    await expect(page.locator("#workspace-content")).toBeFocused();
    await expect(
      page.getByRole("status").filter({ hasText: "Teammate deleted." }),
    ).toBeVisible();
    expect((await page.request.get(endpoint)).status()).toBe(404);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Your team", exact: true }),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(
      page.locator(".side-agent").filter({ hasText: name }),
    ).toHaveCount(0);
  } finally {
    releaseDelete?.();
    await page.unroute(routePattern);
    const cleanup = await page.request.delete(endpoint, {
      headers: { origin },
    });
    expect([204, 404]).toContain(cleanup.status());
  }
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
    page.getByRole("heading", { name: "Your team", exact: true }),
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
    page.getByRole("heading", { name: "Your team", exact: true }),
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
