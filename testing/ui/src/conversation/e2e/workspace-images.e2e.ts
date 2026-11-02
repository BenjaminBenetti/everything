import { expect, test, type BrowserContext } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const root = process.env.WORKSPACE_IMAGES_E2E_ROOT!;

/** Only auth/records/model/unrelated metadata are fixtures; image content and delivery use real HTTP/files. */
async function fixture(context: BrowserContext, origin: string) {
  await context.addCookies([
    {
      name: "everything-session",
      value: "workspace-image-session",
      url: origin,
    },
  ]);
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  const json = (pattern: string, body: unknown) =>
    context.route(pattern, (route) => route.fulfill({ json: body }));
  const agents = [first, second].map((id, i) => ({
    id,
    name: i ? "Blake" : "Avery",
    avatarId: "avatar-03",
    systemPrompt: "Help with files.",
    createdAt: "2026-10-30T09:00:00Z",
    inference: {
      provider: "chatgpt",
      model: "fixture-text-only",
      effort: "high",
    },
  }));
  await json("**/v1/agents", { agents });
  await json("**/v1/agents/recent", { agents });
  await json("**/v1/agents/*/attachments", { attachments: [] });
  await json("**/v1/providers", { providers: [] });
  await json("**/v1/settings/teammate-order", { teammateIds: [] });
  await json("**/v1/agents/*/model-info", {
    selected: {
      provider: "chatgpt",
      model: "fixture-text-only",
      contextWindow: 200000,
      contextSource: "fallback",
      imageInput: false,
      imageSource: "unknown",
    },
    applied: null,
    selectionError: false,
  });
  await json("**/v1/updates**", {
    updates: [],
    nextCursor: null,
    unread: 0,
    byAgent: {},
  });
  await json("**/v1/agents/*/workspaces", {
    workspaces: [],
    observedAt: "2026-11-02T00:00:00Z",
  });
  await json("**/v1/voice/capabilities", {
    available: false,
    maxDurationMs: 60000,
    maxBytes: 8388608,
    mediaTypes: ["audio/webm"],
    responseTimeoutMs: 195000,
  });
  await context.route("**/v1/agents/*/messages/read", (route) =>
    route.fulfill({ status: 204 }),
  );
  for (const pattern of [
    "**/v1/session",
    "**/v1/agents/*/runtime",
    "**/v1/agents/*/workspace-image?**",
  ])
    await context.route(pattern, (route) => route.continue());
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    route.continue(),
  );
  // Playwright runs newest routes first; the host guard must precede every API pass-through.
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.fallback()
      : route.abort("blockedbyclient"),
  );
}

test("explicit own image Markdown, controls, private real bytes, stable polls, reload and conversation isolation", async ({
  page,
  context,
  baseURL,
}, info) => {
  await fixture(context, baseURL!);
  const reset = await page.request.post("/v1/fixture/workspace-images/reset", {
    headers: { "x-workspace-image-fixture": "reset" },
  });
  expect(reset.status()).toBe(204);
  const requests: string[] = [];
  let polls = 0;
  page.on("request", (request) => {
    if (request.url().includes("/workspace-image?"))
      requests.push(request.url());
    if (request.url().endsWith("/runtime")) polls++;
  });
  await page.goto("/team/" + first);
  await expect(
    page.getByRole("textbox", { name: "Message Avery", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
  expect(requests).toHaveLength(0); // Files already exist; no automatic post or fetch.
  await page
    .getByRole("textbox", { name: "Message Avery", exact: true })
    .fill("Show workspace images");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const chart = page.getByRole("img", { name: "Workspace chart", exact: true });
  const absolute = page.getByRole("img", {
    name: "Absolute image",
    exact: true,
  });
  for (const image of [chart, absolute]) {
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate((element) => [
          (element as HTMLImageElement).naturalWidth,
          (element as HTMLImageElement).naturalHeight,
        ]),
      )
      .toEqual([640, 240]);
    await expect(image).toHaveAttribute(
      "src",
      new RegExp(`/v1/agents/${first}/workspace-image`),
    );
  }
  await expect(page.locator(".chat-message.assistant img")).toHaveCount(2);
  await expect(
    page.getByText("Missing chart (image unavailable)", { exact: true }),
  ).toBeVisible();
  expect(
    requests.some((url) =>
      /plain-only|link-only|code-only|html-only/.test(url),
    ),
  ).toBe(false);
  await expect(
    page.getByRole("link", { name: "Download", exact: true }),
  ).toHaveAttribute("href", "plots/link-only.png");
  const snapshot = requests.length,
    initialPolls = polls;
  await expect
    .poll(() => polls, { timeout: 15000 })
    .toBeGreaterThan(initialPolls + 1);
  expect(requests).toHaveLength(snapshot);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const local = await readFile(
    path.join(root, "volume", first, "plots", "chart.png"),
  );
  const content = await page.request.get(
    `/v1/agents/${first}/workspace-image?path=plots%2Fchart.png`,
  );
  expect(content.status()).toBe(200);
  expect(content.headers()["cache-control"]).toBe("private, no-store");
  const hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  expect(hash(await content.body())).toBe(hash(local));
  await chart.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(root, "evidence", info.project.name + "-inline.png"),
    fullPage: true,
  });
  await page.reload();
  await chart.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      chart.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(640);
  await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
  await page.goto("/team/" + second);
  await page
    .getByRole("textbox", { name: "Message Blake", exact: true })
    .fill("Show this workspace");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const secondChart = page.getByRole("img", {
    name: "Workspace chart",
    exact: true,
  });
  await secondChart.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      secondChart.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(480);
  await expect(secondChart).toHaveAttribute(
    "src",
    new RegExp(`/v1/agents/${second}/workspace-image`),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(
      root,
      "evidence",
      info.project.name + "-other-workspace.png",
    ),
    fullPage: true,
  });
  await page.goto("/team/" + first);
  await chart.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      chart.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(640);
  await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
  await writeFile(
    path.join(root, "evidence", info.project.name + "-assertions.json"),
    JSON.stringify(
      {
        realHTTP: true,
        actualFiles: true,
        providerRequests: 0,
        sourceBytes: local.length,
        sourceSha256: hash(local),
        imageRequests: requests,
        controlsRequested: false,
        pollImageRequestsAdded: 0,
        firstNatural: [640, 240],
        secondNatural: [480, 240],
        screenshotNames: [
          info.project.name + "-inline.png",
          info.project.name + "-other-workspace.png",
        ],
      },
      null,
      2,
    ),
  );
});
