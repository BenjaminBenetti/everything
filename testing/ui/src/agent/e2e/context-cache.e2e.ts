import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { activityWorkspace } from "../../conversation/fixture/teammate-activity.js";
import { setConversationDetails } from "../../conversation/fixture/conversation-details.js";

const cacheKey = "everything.model-context.v1";
const day = 24 * 60 * 60 * 1000;
const terra = {
  provider: "chatgpt",
  model: "gpt-6.1-terra",
  contextWindow: 200000,
  contextSource: "fallback",
  imageInput: true,
  imageSource: "documentation",
};

/** Entirely intercepted synthetic HTTP, including auth and connection actions. Never contacts a provider. */
async function fixture(context: BrowserContext) {
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  const activity = await activityWorkspace(context);
  activity.avery.sessionId = null;
  const state = {
    selected: { ...terra },
    applied: null as typeof terra | null,
    selectionError: false,
    error: false,
    hold: null as Promise<void> | null,
    model: terra.model,
    effort: "off",
    name: "Avery",
    owner: "compact-owner-a" as string | null,
    requests: 0,
    discoveries: 0,
    runtimeRequests: 0,
    checks: 0,
    connection: {
      provider: "chatgpt",
      configured: true,
      status: "verified",
      baseUrl: null,
      model: null,
      account: "Synthetic account",
      verifiedAt: null as string | null,
      lastCheckedAt: null as string | null,
      message: null,
    },
  };
  const agent = () => ({
    id: "avery",
    name: state.name,
    avatarId: "avatar-03",
    systemPrompt: "Help with project planning.",
    createdAt: "2026-10-30T09:00:00Z",
    inference: {
      provider: "chatgpt",
      model: state.model,
      effort: state.effort,
    },
  });
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: state.owner
          ? { subject: state.owner, displayName: "Demo owner" }
          : null,
      },
    }),
  );
  await context.route("**/v1/session/logout", (route) => {
    state.owner = null;
    return route.fulfill({ status: 204 });
  });
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [state.connection] } }),
  );
  await context.route("**/v1/providers/*/models", (route) => {
    state.discoveries++;
    return route.fulfill({ json: { models: [] } });
  });
  await context.route("**/v1/providers/chatgpt/authorize", (route) =>
    route.fulfill({
      json: {
        url: "https://synthetic.invalid/authorize?state=fixture",
        redirectUri: "http://127.0.0.1:8080/",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    }),
  );
  await context.route("**/v1/providers/chatgpt/verify", (route) => {
    state.checks++;
    return route.fulfill({ json: state.connection });
  });
  for (const pattern of ["**/v1/agents", "**/v1/agents/recent"])
    await context.route(pattern, (route) =>
      route.fulfill({ json: { agents: [agent()] } }),
    );
  await context.route("**/v1/agents/*/attachments", (route) =>
    route.fulfill({ json: { attachments: [] } }),
  );
  await context.route("**/v1/agents/avery/runtime", (route) => {
    state.runtimeRequests++;
    return route.fulfill({ json: activity.avery });
  });
  await context.route("**/v1/agents/avery/model-info", async (route) => {
    state.requests++;
    // Capture at request time: a released delayed response must retain its original identity.
    const response = {
      selected: state.selectionError ? null : { ...state.selected },
      applied: state.applied ? { ...state.applied } : null,
      selectionError: state.selectionError,
    };
    const error = state.error;
    if (state.hold) await state.hold;
    return route.fulfill(
      error
        ? {
            status: 503,
            json: { code: "UNAVAILABLE", message: "Synthetic unavailable" },
          }
        : { json: response },
    );
  });
  return { state, activity };
}

/** Same production grid on desktop and phone, with no replacement explanatory UI. */
async function compact(grid: Locator, value: string, profile = false) {
  await expect(grid.locator("dt")).toHaveText([
    "Provider",
    "Model",
    profile ? "Effort level" : "Effort",
    "Context",
  ]);
  await expect(grid.locator("dd").last()).toHaveText(value);
  await expect(grid.locator("dt").last()).toHaveText("Context");
  await expect(grid).not.toContainText(
    /Applied|Selected model|Source|Image input|Documentation|Loading model|pinning/,
  );
  expect(
    await grid
      .locator("dt")
      .last()
      .evaluate((element) => getComputedStyle(element.parentElement!).display),
  ).toBe("grid");
}
async function chat(page: Page) {
  await setConversationDetails(page, true);
  return page.locator(".chat-teammate-model");
}
async function team(page: Page) {
  const back = page.getByRole("link", {
    name: "Back to your team",
    exact: true,
  });
  if (await back.isVisible()) await back.click();
  else
    await page
      .getByRole("navigation", { name: "Workspace", exact: true })
      .getByRole("link", { name: "Your team", exact: true })
      .click();
  await expect(
    page.getByRole("heading", { name: "Your team", exact: true }),
  ).toBeVisible();
}
async function quiet(page: Page) {
  // Allow async connection hashing / enabled-query effects to finish before checking a zero delta.
  await page.waitForTimeout(250);
  await expect(
    page.getByText(
      /Loading model details|Applied to loaded runtime|Selected model · next runtime/,
    ),
  ).toHaveCount(0);
}
async function age(page: Page, milliseconds: number) {
  await page.evaluate(
    ({ key, milliseconds }) => {
      const data = JSON.parse(localStorage.getItem(key)!);
      for (const entry of data.entries)
        entry.updatedAt = Date.now() - milliseconds;
      localStorage.setItem(key, JSON.stringify(data));
    },
    { key: cacheKey, milliseconds },
  );
}
async function artifact(name: string, value: unknown) {
  const directory = path.join(process.env.MODEL_INFO_E2E_ROOT!, "evidence");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, name),
    JSON.stringify(value, null, 2) + "\n",
    { flag: "wx" },
  );
}
async function workspaceAction(
  page: Page,
  action: "Model providers" | "Sign out",
) {
  const button = page
    .getByRole("button", {
      name: action === "Sign out" ? "Sign out" : /^Model providers —/,
    })
    .first();
  if (await button.isVisible()) await button.click();
  else {
    await page
      .getByRole("button", { name: "Workspace menu", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: new RegExp(`^${action}`) })
      .click();
  }
}

test("one Context row; reopen, routes, focus, message polling and full reload reuse one persistent request", async ({
  context,
  page,
}, testInfo) => {
  const { state, activity } = await fixture(context);
  state.applied = { ...terra };
  state.selected.contextWindow = 16384;
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const counts: Record<string, number> = {};
  try {
    await page.goto("/team/avery");
    let grid = await chat(page);
    await compact(grid, "—");
    await expect.poll(() => state.requests).toBe(1);
    state.hold = null;
    release();
    await compact(grid, "200,000 tokens");
    counts.initial = state.requests;
    await setConversationDetails(page, false);
    await setConversationDetails(page, true);
    await quiet(page);
    expect(state.requests).toBe(1);
    counts.reopened = state.requests;
    const reads = state.runtimeRequests;
    activity.avery.runId = "synthetic-new-turn";
    await expect
      .poll(() => state.runtimeRequests, { timeout: 10_000 })
      .toBeGreaterThan(reads);
    expect(state.requests).toBe(1);
    counts.messagePoll = state.requests;
    await team(page);
    await page.getByRole("button", { name: "View Avery", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Avery", exact: true });
    await compact(
      dialog.locator(".teammate-model-details"),
      "200,000 tokens",
      true,
    );
    const evidence = path.join(process.env.MODEL_INFO_E2E_ROOT!, "evidence");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: path.join(evidence, `${testInfo.project.name}-profile-after.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "View Avery", exact: true }).click();
    await compact(
      page.locator(".teammate-model-details"),
      "200,000 tokens",
      true,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Chat with Avery", exact: true })
      .click();
    grid = await chat(page);
    await compact(grid, "200,000 tokens");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await quiet(page);
    expect(state.requests).toBe(1);
    counts.routeAndFocus = state.requests;
    await page.reload();
    grid = await chat(page);
    await compact(grid, "200,000 tokens");
    await quiet(page);
    expect(state.requests).toBe(1);
    counts.fullReload = state.requests;
    expect(state.discoveries).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(evidence, `${testInfo.project.name}-chat-after.png`),
      fullPage: true,
    });
    await artifact(`${testInfo.project.name}-fresh-counts.json`, {
      counts,
      providerDiscoveries: state.discoveries,
      allHttpMocked: true,
    });
  } finally {
    release?.();
  }
});

test("24h persisted freshness; stale count stays visible during refresh and errors; first failure stays quiet", async ({
  context,
  page,
}, testInfo) => {
  const { state } = await fixture(context);
  state.error = true;
  await page.goto("/team/avery");
  await compact(await chat(page), "—");
  await quiet(page);
  expect(state.requests).toBe(1);
  state.error = false;
  await page.reload();
  await compact(await chat(page), "200,000 tokens");
  expect(state.requests).toBe(2);
  await age(page, day - 60_000);
  await page.reload();
  await compact(await chat(page), "200,000 tokens");
  await quiet(page);
  expect(state.requests).toBe(2);
  await age(page, day + 1000);
  let release!: () => void;
  state.error = true;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.reload();
    await compact(await chat(page), "200,000 tokens");
    await expect.poll(() => state.requests).toBe(3);
    state.hold = null;
    release();
    await quiet(page);
    await compact(await chat(page), "200,000 tokens");
    expect(state.requests).toBe(3);
    state.error = false;
    state.selected.contextWindow = 8192;
    await page.reload();
    await compact(await chat(page), "8,192 tokens");
    expect(state.requests).toBe(4);
    await artifact(`${testInfo.project.name}-ttl-counts.json`, {
      firstFailure: 1,
      initialSuccess: 2,
      before24h: 2,
      after24hFailure: 3,
      recovered: state.requests,
      allHttpMocked: true,
      timeMethod: "Only persisted updatedAt was aged; no 24h wall-clock wait",
    });
  } finally {
    release?.();
  }
});

test("new model and inference isolate counts; cosmetic edits reuse; changed public connection invalidates", async ({
  context,
  page,
}, testInfo) => {
  const { state } = await fixture(context);
  await page.goto("/team/avery");
  await compact(await chat(page), "200,000 tokens");
  state.applied = { ...terra };
  state.model = "synthetic-smaller-model";
  state.selected = { ...terra, model: state.model, contextWindow: 8192 };
  let release!: () => void;
  const held = () => {
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    held();
    await page.reload();
    let grid = await chat(page);
    await expect(grid).toContainText(state.model);
    await compact(grid, "—");
    await expect.poll(() => state.requests).toBe(2);
    expect(await grid.textContent()).not.toContain("200,000");
    state.hold = null;
    release();
    await compact(grid, "8,192 tokens");
    state.effort = "high";
    held();
    await page.reload();
    grid = await chat(page);
    await compact(grid, "—");
    await expect.poll(() => state.requests).toBe(3);
    state.hold = null;
    release();
    await compact(grid, "8,192 tokens");
    state.name = "Avery Demo";
    await page.reload();
    grid = await chat(page);
    await compact(grid, "8,192 tokens");
    await quiet(page);
    expect(state.requests).toBe(3);
    state.connection.account = "Changed synthetic account";
    state.selected.contextWindow = 16384;
    held();
    await page.reload();
    grid = await chat(page);
    await expect.poll(() => state.requests).toBe(4);
    await compact(grid, "—");
    state.hold = null;
    release();
    await compact(grid, "16,384 tokens");
    await artifact(`${testInfo.project.name}-identity-counts.json`, {
      initial: 1,
      newModel: 2,
      newEffort: 3,
      cosmeticEdit: 3,
      connectionChange: state.requests,
      allHttpMocked: true,
    });
  } finally {
    release?.();
  }
});

test("actual connection-action and logout consumers invalidate persisted metadata; another owner starts empty", async ({
  context,
  page,
}, testInfo) => {
  const { state } = await fixture(context);
  await page.goto("/team/avery");
  await compact(await chat(page), "200,000 tokens");
  await team(page);
  await workspaceAction(page, "Model providers");
  await page.locator(".provider-option").filter({ hasText: "ChatGPT" }).click();
  state.selected.contextWindow = 8192;
  await page
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect.poll(() => state.checks).toBe(1);
  await expect(
    page.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Chat with Avery", exact: true })
    .click();
  await compact(await chat(page), "8,192 tokens");
  expect(state.requests).toBe(2);
  await team(page);
  await workspaceAction(page, "Sign out");
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), cacheKey))
    .toBeNull();
  state.owner = "compact-owner-b";
  state.selected.contextWindow = 16384;
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto("/team/avery");
    const grid = await chat(page);
    await compact(grid, "—");
    await expect.poll(() => state.requests).toBe(3);
    state.hold = null;
    release();
    await compact(grid, "16,384 tokens");
    const stored = await page.evaluate(
      (key) => localStorage.getItem(key),
      cacheKey,
    );
    expect(stored).toContain("compact-owner-b");
    expect(stored).not.toContain("compact-owner-a");
    await artifact(`${testInfo.project.name}-owner-counts.json`, {
      initial: 1,
      explicitMockedConnectionCheck: 2,
      ownerChange: state.requests,
      logoutClearedStorage: true,
      allHttpMocked: true,
    });
  } finally {
    release?.();
  }
});
