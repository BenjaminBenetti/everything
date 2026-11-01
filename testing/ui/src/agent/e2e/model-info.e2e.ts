import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { activityWorkspace } from "../../conversation/fixture/teammate-activity.js";
import { setConversationDetails } from "../../conversation/fixture/conversation-details.js";

/** Synthetic backend resolution; parser/runtime truth is covered by service tests, not these fixtures. */
const terra = {
  provider: "chatgpt",
  model: "gpt-6.1-terra",
  contextWindow: 200000,
  contextSource: "fallback",
  imageInput: true,
  imageSource: "documentation",
};

/** Intercept every API request; only the Vite server and its same-origin assets can be reached. */
async function fixture(context: BrowserContext) {
  await context.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return ["localhost", "127.0.0.1"].includes(hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  const activity = await activityWorkspace(context);
  activity.avery.sessionId = null;
  const state = {
    selected: { ...terra },
    applied: null as typeof terra | null,
    selectionError: false,
    error: false,
    hold: null as Promise<void> | null,
    model: terra.model,
    requests: 0,
  };
  const agent = () => ({
    id: "avery",
    name: "Avery",
    avatarId: "avatar-03",
    systemPrompt: "Help with project planning.",
    createdAt: "2026-10-30T09:00:00Z",
    inference: { provider: "chatgpt", model: state.model, effort: "off" },
  });
  for (const pattern of ["**/v1/agents", "**/v1/agents/recent"])
    await context.route(pattern, (route) =>
      route.fulfill({ json: { agents: [agent()] } }),
    );
  await context.route("**/v1/agents/*/attachments", (route) =>
    route.fulfill({ json: { attachments: [] } }),
  );
  await context.route("**/v1/agents/avery/model-info", async (route) => {
    state.requests++;
    if (state.hold) await state.hold;
    if (state.error)
      return route.fulfill({
        status: 503,
        json: { code: "UNAVAILABLE", message: "Unavailable" },
      });
    return route.fulfill({
      json: {
        selected: state.selectionError ? null : state.selected,
        applied: state.applied,
        selectionError: state.selectionError,
      },
    });
  });
  return { state, activity };
}

test("Terra context and documentation fallback in the existing avatar/provider panel", async ({
  context,
  page,
}, testInfo) => {
  await fixture(context);
  await page.goto("/team/avery");
  await setConversationDetails(page, true);
  const info = page.getByRole("region", {
    name: "Model context and image support",
  });
  await expect(info.getByText("200,000 tokens", { exact: true })).toBeVisible();
  await expect(
    info.getByText("Fallback (default)", { exact: true }),
  ).toBeVisible();
  await expect(
    info.getByText("Supported · Documentation fallback", { exact: true }),
  ).toBeVisible();
  await expect(info).not.toContainText("1,050,000");
  const evidence = path.join(process.env.MODEL_INFO_E2E_ROOT!, "evidence");
  await mkdir(evidence, { recursive: true });
  await info
    .getByText("200,000 tokens", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(evidence, `${testInfo.project.name}-context.png`),
    fullPage: true,
  });
  await info.getByText(/It was not API-detected/).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(evidence, `${testInfo.project.name}-documentation.png`),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("loading, discovery error, pinned runtime, refreshed selection and reopening", async ({
  context,
  page,
}) => {
  const { state, activity } = await fixture(context);
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto("/team/avery");
  await setConversationDetails(page, true);
  await expect(
    page.getByText("Loading model details…", { exact: true }),
  ).toBeVisible();
  state.hold = null;
  release();
  await expect(page.getByText("200,000 tokens", { exact: true })).toBeVisible();
  // A fresh server resolution differs from the loaded runtime. A new turn refreshes the info query.
  state.applied = { ...terra };
  activity.avery.sessionId = "synthetic-runtime";
  state.selected = {
    ...terra,
    contextWindow: 16384,
    contextSource: "provider",
    imageInput: false,
    imageSource: "provider",
  };
  activity.avery.runId = "synthetic-new-turn";
  const info = page.getByRole("region", {
    name: "Model context and image support",
  });
  await expect(info.getByText("16,384 tokens", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(info.getByText("200,000 tokens", { exact: true })).toBeVisible();
  await expect(
    info.getByText("Selected model · next runtime", { exact: true }),
  ).toBeVisible();
  await expect(info).toContainText(
    "Saving identical settings does not refresh",
  );
  state.selectionError = true;
  await page.reload();
  await setConversationDetails(page, true);
  await expect(info.getByRole("alert")).toContainText(
    "Selected model details are unavailable",
  );
  await expect(info).toContainText("200,000 tokens");
  state.selectionError = false;
  state.error = true;
  await page.reload();
  await setConversationDetails(page, true);
  await expect(
    page.getByRole("alert").filter({ hasText: "Model details couldn’t load" }),
  ).toBeVisible();
  state.error = false;
  state.model = "another-selected-model";
  state.selected = {
    ...terra,
    model: state.model,
    imageInput: false,
    imageSource: "catalog",
    contextWindow: 8192,
    contextSource: "catalog",
  };
  state.applied = { ...state.selected };
  await page.reload();
  await setConversationDetails(page, true);
  await expect(info.getByText("8,192 tokens", { exact: true })).toBeVisible();
  await expect(
    info.getByText("Catalog estimate", { exact: true }),
  ).toBeVisible();
  await expect(info).not.toContainText("200,000 tokens");
  expect(state.requests).toBeGreaterThanOrEqual(5);
});
