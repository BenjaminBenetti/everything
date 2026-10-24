import { expect, test, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The teammate the gateway's real turns ran as, for both owners. */
const agentId = "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c";

/** Whether the gateway records error text, as TELEMETRY_INCLUDE_ERROR_TEXT sets it there. */
const errorText =
  process.env.TELEMETRY_E2E_ERROR_TEXT === "included" ? "included" : "withheld";

/**
 * Where screenshots of the real page are kept as evidence, outside Playwright's output directory,
 * which each run clears, so both error-text runs keep theirs.
 */
const evidence = fileURLToPath(
  new URL(
    "../../../../../.local/ui-test-results/telemetry-e2e-evidence/",
    import.meta.url,
  ),
);

/**
 * Sign in as owner A with the gateway's test session and mock the workspace's other routes; every
 * Telemetry request reaches the real gateway, its query API, and OpenObserve.
 */
async function workspace(
  context: BrowserContext,
  baseURL: string,
): Promise<void> {
  await context.addCookies([
    {
      name: "everything-session",
      value: "telemetry-e2e-session",
      url: baseURL,
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
  const teammate = {
    id: agentId,
    name: "Kiwi helper",
    avatarId: "avatar-03",
    systemPrompt: "Help the user.",
    createdAt: "2026-10-12T10:00:00Z",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  };
  await json("**/v1/session", {
    profile: { subject: "owner-a", displayName: "Owner A" },
  });
  await json("**/v1/providers", { providers: [] });
  await json("**/v1/agents", { agents: [teammate] });
  await json("**/v1/agents/recent", { agents: [teammate] });
  await json("**/v1/workspaces", { workspaces: [] });
  await json("**/v1/settings/teammate-order", { teammateIds: [] });
  await json("**/v1/updates**", { updates: [], nextCursor: null });
  await context.route("**/v1/telemetry/**", (route) => route.continue());
}

test("a real model failure travels from Everything's runtime through OpenObserve to the page, for its owner only", async ({
  page,
  context,
  baseURL,
}) => {
  await workspace(context, baseURL!);
  const responses: { url: string; status: number }[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/v1/telemetry/"))
      responses.push({ url: response.url(), status: response.status() });
  });
  await page.goto("/telemetry");
  await expect(
    page.getByRole("heading", { level: 1, name: "Telemetry" }),
  ).toBeVisible();
  await expect(page.getByText("kept for 7 days")).toBeVisible();

  const table = page.getByRole("table");
  const failure = table.getByRole("button", { name: /Model request failed/ });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("rate_limit");
  await expect(
    table.getByRole("button", { name: /Teammate turn failed/ }),
  ).toBeVisible();
  // Owner B's server error exists in the same storage but is never listed for owner A.
  await expect(table.getByText("server_error")).toHaveCount(0);
  await page.screenshot({
    path: `${evidence}telemetry-errors-${errorText}.png`,
    fullPage: true,
  });

  await failure.click();
  const detail = page.getByRole("complementary", {
    name: "Model request failed",
  });
  await expect(
    detail.getByText("The provider’s rate limit was reached."),
  ).toBeVisible();
  for (const [label, value] of [
    ["HTTP status", "429"],
    ["Provider request ID", "req_browser_e2e_429"],
    ["Category", "rate_limit"],
    ["Retrying may help", "Yes"],
    ["Model", "o3-mini"],
    ["Retry after", "20"],
  ] as const)
    await expect(
      detail
        .locator("dt", { hasText: new RegExp(`^${label}$`) })
        .locator("+ dd"),
    ).toHaveText(value);
  if (errorText === "included")
    await expect(
      detail.getByText("Rate limit reached for requests per minute"),
    ).toBeVisible();
  else {
    // The provider's wording never reached storage; the page says so instead of showing nothing.
    await expect(
      detail.getByRole("heading", { name: "Error text withheld" }),
    ).toBeVisible();
    await expect(detail.getByText(/Rate limit reached/)).toHaveCount(0);
  }
  const spans = detail.getByRole("list", { name: "Spans, in tree order" });
  await expect(
    spans.getByRole("button", { name: /Teammate turn/ }),
  ).toBeVisible();
  await expect(
    spans.getByRole("button", { name: /Model prompt/ }),
  ).toBeVisible();
  await expect(
    spans.getByRole("button", { name: /Provider request to model\.test/ }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}telemetry-detail-${errorText}.png`,
    fullPage: true,
  });

  // Spans of the same work are searchable by the run that produced them.
  await page.getByRole("radio", { name: "Spans" }).check();
  await page.getByRole("combobox", { name: "Severity" }).click();
  await page.getByRole("option", { name: "All severities" }).click();
  await expect(
    table.getByRole("button", { name: /Provider request to model\.test/ }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}telemetry-spans-${errorText}.png`,
    fullPage: true,
  });

  expect(responses.length).toBeGreaterThan(0);
  expect(responses.every(({ status }) => status === 200)).toBe(true);
});

test("another owner's trace is indistinguishable from a missing one", async ({
  request,
}) => {
  const owner = {
    headers: { cookie: "everything-session=telemetry-e2e-session" },
  };
  const page = await request.get("/v1/telemetry/events?severity=info", owner);
  expect(page.status()).toBe(200);
  const listed = (await page.json()) as {
    records: { traceId: string | null }[];
  };
  expect(listed.records.length).toBeGreaterThan(0);
  const unknown = await request.get(
    "/v1/telemetry/traces/0123456789abcdef0123456789abcdef",
    owner,
  );
  expect(unknown.status()).toBe(404);
  // Owner B's real trace, which exists in the same storage, answers exactly like the unknown one.
  const other = process.env.TELEMETRY_E2E_OTHER_TRACE;
  expect(other, "the gateway reports owner B's trace").toMatch(
    /^[0-9a-f]{32}$/,
  );
  const foreign = await request.get(`/v1/telemetry/traces/${other}`, owner);
  expect(foreign.status()).toBe(404);
  expect(await foreign.json()).toEqual(await unknown.json());
  const anonymous = await request.get("/v1/telemetry/events");
  expect(anonymous.status()).toBe(401);
});
