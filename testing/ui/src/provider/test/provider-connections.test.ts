import { test, expect, type BrowserContext } from "@playwright/test";

/** Isolate provider UI checks from account data and the live authentication rate limit. */
async function prepareWorkspace(context: BrowserContext): Promise<void> {
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: {
          subject: "provider-browser-fixture",
          displayName: "Provider check",
        },
      },
    }),
  );
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await context.route("**/v1/providers/chatgpt/authorize", (route) =>
    route.fulfill({
      json: {
        url: "https://auth.openai.com/api/accounts/authorize?state=picker-fixture",
        redirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
  );
}

/** Keep this browser test independent from the owner's actual saved providers. */
function disconnectedProviders() {
  return ["chatgpt", "anthropic", "openai-compatible"].map((provider) => ({
    provider,
    configured: false,
    status: "disconnected",
    baseUrl: null as string | null,
    model: null as string | null,
    account: null as string | null,
    verifiedAt: null as string | null,
    lastCheckedAt: null as string | null,
    message: null as string | null,
  }));
}

test("saved connection status stays connected and automatically displays new check results", async ({
  page,
  context,
}) => {
  await prepareWorkspace(context);
  await page.clock.install({ time: new Date("2026-10-12T12:00:00Z") });
  const providers = disconnectedProviders();
  const connection = providers[2]!;
  Object.assign(connection, {
    configured: true,
    status: "verified",
    baseUrl: "http://localhost:11434/v1",
    verifiedAt: "2026-10-11T11:00:00Z",
    lastCheckedAt: "2026-10-11T11:00:00Z",
  });
  let explicitChecks = 0;
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers } }),
  );
  await context.route("**/v1/providers/*/verify", (route) => {
    explicitChecks++;
    return route.fulfill({ json: connection });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Model providers/ }).click();
  const option = page.getByRole("button", { name: /^OpenAI-compatible API/ });
  await expect(option).toContainText("Connected");
  await option.click();
  const dialog = page.getByRole("dialog", {
    name: "OpenAI-compatible API",
    exact: true,
  });
  await expect(dialog.locator("time")).toHaveAttribute(
    "datetime",
    connection.lastCheckedAt!,
  );
  await expect(
    dialog.getByText(/Checked automatically every 24 hours/),
  ).toBeVisible();
  connection.lastCheckedAt = "2026-10-12T12:00:00Z";
  await page.clock.fastForward(60_000);
  await expect(dialog.locator("time")).toHaveAttribute(
    "datetime",
    connection.lastCheckedAt,
  );
  await expect(dialog.getByRole("status")).toHaveText("Connected");
  connection.status = "error";
  connection.verifiedAt = null;
  connection.message = "The provider could not complete the connection check.";
  await page.clock.fastForward(60_000);
  await expect(dialog.getByRole("status")).toHaveText("Check failed");
  await expect(dialog.getByRole("alert")).toHaveText(connection.message);
  expect(explicitChecks).toBe(0);
});

test("provider choices open one compact setup page and Back restores the list and focus", async ({
  page,
  context,
}, info) => {
  await prepareWorkspace(context);
  const providers = disconnectedProviders();
  let saves = 0;
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers } }),
  );
  await context.route("**/v1/providers/openai-compatible", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({
      apiKey: "browser-fixture-key",
      baseUrl: "http://localhost:11434/v1",
      model: "",
    });
    saves += 1;
    Object.assign(providers[2]!, {
      configured: true,
      status: "verified",
      baseUrl: "http://localhost:11434/v1",
      model: "fixture-mini",
      verifiedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
    });
    await route.fulfill({ json: providers[2] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Model providers/ }).click();
  await expect(page.locator(".provider-picker button")).toHaveCount(3);
  await expect(page.getByRole("dialog").locator("input")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^OpenAI-compatible API/ }),
  ).toBeInViewport();
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: info.outputPath("provider-list.png") });

  for (const title of ["Claude", "ChatGPT"]) {
    await page.getByRole("button", { name: new RegExp("^" + title) }).click();
    await expect(
      page.getByRole("dialog", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".provider-picker")).toHaveCount(0);
    if (title === "Claude")
      await expect(page.getByLabel("API key", { exact: true })).toBeFocused();
    else
      await expect(
        page.getByRole("link", { name: "Continue with ChatGPT" }),
      ).toBeFocused();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByRole("button", { name: new RegExp("^" + title) }),
    ).toBeFocused();
  }
  expect(saves).toBe(0);
  await page.getByRole("button", { name: /^OpenAI-compatible API/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "OpenAI-compatible API",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("API base address")).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Back", exact: true }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Save and check" }),
  ).toBeInViewport();
  await expect(page.locator(".connection-page")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("provider-setup.png") });
  await page.getByLabel("API base address").fill("http://localhost:11434/v1");
  await page.getByLabel(/API key/).fill("browser-fixture-key");
  await dialog.getByRole("button", { name: "Save and check" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Connected");
  await expect(dialog.getByText(/Last checked/)).toContainText(
    "Checked automatically every 24 hours.",
  );
  await expect(page.getByLabel(/API key/)).toHaveValue("");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  const savedOption = page.getByRole("button", {
    name: /^OpenAI-compatible API/,
  });
  await expect(savedOption).toBeFocused();
  await expect(savedOption).toContainText("Connected");
  await expect(page.locator(".provider-button")).toHaveClass(/connected/);
  await savedOption.click();
  await expect(page.getByLabel("API base address")).toHaveValue(
    "http://localhost:11434/v1",
  );
  await expect(page.getByLabel(/API key/)).toHaveValue("");
  expect(saves).toBe(1);
});

test("ChatGPT returns through loopback after opener isolation and consumes browser state once", async ({
  page,
  context,
}) => {
  await prepareWorkspace(context);
  const providers = disconnectedProviders();
  const state = "browser-state-" + crypto.randomUUID();
  const callback =
    "http://127.0.0.1:8080/v1/providers/chatgpt/callback" +
    "?code=browser-fixture&client_id=browser-client&state=" +
    state;
  let completions = 0;
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers } }),
  );
  await context.route("**/v1/providers/chatgpt/authorize", (route) =>
    route.fulfill({
      json: {
        url: "https://auth.openai.com/api/accounts/authorize?state=" + state,
        redirectUri: callback.split("?")[0],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
  );
  await context.route("https://auth.openai.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "Cross-Origin-Opener-Policy": "same-origin" },
      body: `<script>location.replace(${JSON.stringify(callback)})</script>`,
    }),
  );
  await context.route("**/v1/providers/chatgpt/complete", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ callback });
    completions += 1;
    Object.assign(providers[0]!, {
      configured: true,
      status: "verified",
      account: "Browser fixture",
      model: "fixture-mini",
      verifiedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
    });
    await route.fulfill({ json: providers[0] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Model providers/ }).click();
  await page.getByRole("button", { name: /^ChatGPT/ }).click();
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Continue with ChatGPT" }).click();
  const returned = await opened;
  await expect(
    returned
      .getByRole("region", { name: "ChatGPT", exact: true })
      .getByRole("status"),
  ).toHaveText("Connected");
  await expect(returned.locator(".provider-button")).toHaveClass(/connected/);
  expect(new URL(returned.url()).hash).toBe("");
  expect(completions).toBe(1);
  expect(await returned.evaluate(() => Object.keys(sessionStorage))).toEqual(
    [],
  );
  await returned.close();
});

test("ChatGPT exposes a copyable authorization link and accepts the matching pasted return URL", async ({
  page,
  context,
}) => {
  await prepareWorkspace(context);
  const providers = disconnectedProviders();
  const state = "copy-link-" + crypto.randomUUID();
  const url = "https://auth.openai.com/api/accounts/authorize?state=" + state;
  const callback =
    "http://127.0.0.1:8080/v1/providers/chatgpt/callback?code=copy-fixture&client_id=copy-client&state=" +
    state;
  let authorizations = 0;
  let completions = 0;
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers } }),
  );
  await context.route("**/v1/providers/chatgpt/authorize", (route) => {
    authorizations += 1;
    return route.fulfill({
      json: {
        url,
        redirectUri: callback.split("?")[0],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
  });
  await context.route("**/v1/providers/chatgpt/complete", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ callback });
    completions += 1;
    Object.assign(providers[0]!, {
      configured: true,
      status: "verified",
      verifiedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
    });
    await route.fulfill({ json: providers[0] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Model providers/ }).click();
  await page.getByRole("button", { name: /^ChatGPT/ }).click();
  const link = page.getByRole("link", { name: "Continue with ChatGPT" });
  await expect(link).toHaveAttribute("href", url);
  await link.click({ button: "right" });
  expect(context.pages()).toHaveLength(1);
  expect(authorizations).toBe(1);
  await page.getByText("Sign-in didn’t return here?").click();
  await page.getByLabel("Return address").fill(callback);
  await page.getByRole("button", { name: "Finish connection" }).click();
  await expect(
    page
      .getByRole("region", { name: "ChatGPT", exact: true })
      .getByRole("status"),
  ).toHaveText("Connected");
  expect(completions).toBe(1);
  expect(authorizations).toBe(1);
});

test("a ChatGPT callback without matching browser state never submits a code", async ({
  page,
  context,
}) => {
  await prepareWorkspace(context);
  let completions = 0;
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: disconnectedProviders() } }),
  );
  await context.route("**/v1/providers/chatgpt/complete", async (route) => {
    completions += 1;
    await route.fulfill({ status: 400, json: {} });
  });
  await page.goto(
    "/v1/providers/chatgpt/callback?code=foreign&client_id=foreign&state=foreign",
  );
  await expect(page.getByRole("alert")).toContainText(
    "This sign-in did not start in this browser or has expired",
  );
  expect(new URL(page.url()).hash).toBe("");
  expect(completions).toBe(0);
  await expect(page.locator(".provider-button")).not.toHaveClass(/connected/);
});
