import { expect, test } from "@playwright/test";
import {
  record,
  teammate,
  telemetryWorkspace,
  traceId,
} from "../fixture/telemetry-workspace.js";

// Each project runs its own layout's tests; see playwright.telemetry.config.ts.
test.describe("desktop", { tag: "@desktop" }, () => {
  test("Telemetry follows Keys in the sidebar and opens on the last day's errors", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Workspace" });
    await expect(sidebar.getByRole("link")).toHaveText([
      "Home",
      "Updates",
      "Your team",
      "Apps",
      "Workspaces",
      "Keys",
      "Telemetry",
    ]);
    await sidebar.getByRole("link", { name: "Telemetry" }).click();
    await expect(page).toHaveURL(/\/telemetry$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Telemetry" }),
    ).toBeVisible();
    await expect(page.getByText("kept for 7 days")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Severity" })).toHaveText(
      /Errors/,
    );
    await expect(
      page.getByRole("button", { name: /Model request failed/ }),
    ).toBeVisible();
    const listing = workspace.requests.find(
      (url) => url.pathname === "/v1/telemetry/events",
    )!;
    expect(listing.searchParams.get("severity")).toBe("error");
    const from = Date.parse(listing.searchParams.get("from")!);
    const to = Date.parse(listing.searchParams.get("to")!);
    expect(to - from).toBe(24 * 60 * 60_000);
    await expect(page.getByRole("cell", { name: teammate.name })).toBeVisible();
  });

  test("a direct load or reload of /telemetry opens the explorer", async ({
    page,
    context,
  }) => {
    await telemetryWorkspace(context);
    await page.goto("/telemetry");
    await expect(
      page.getByRole("heading", { level: 1, name: "Telemetry" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: /Model request failed/ }),
    ).toBeVisible();
  });

  test("filters are labelled, keyboard-operable, and reach the API", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    await page.goto("/telemetry");
    await expect(
      page.getByRole("search", { name: "Filter telemetry" }),
    ).toBeVisible();
    // The latest listing the filters produced, which always carries the range's end.
    const last = () =>
      workspace.requests
        .filter(
          (url) =>
            /^\/v1\/telemetry\/(events|spans)$/.test(url.pathname) &&
            url.searchParams.has("to"),
        )
        .at(-1)!;

    await page.getByRole("combobox", { name: "Teammate" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: teammate.name }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => last().searchParams.get("agentId"))
      .toBe(teammate.id);

    await page.getByRole("combobox", { name: "Time range" }).click();
    await page.getByRole("option", { name: "Last week" }).click();
    await expect
      .poll(() => {
        const url = last();
        return (
          Date.parse(url.searchParams.get("to")!) -
          Date.parse(url.searchParams.get("from")!)
        );
      })
      .toBe(7 * 24 * 60 * 60_000);

    await page
      .getByRole("searchbox", { name: "Search telemetry" })
      .fill("rate limit");
    await expect
      .poll(() => last().searchParams.get("search"))
      .toBe("rate limit");
    await page
      .getByRole("textbox", { name: "Trace, run, session, or request ID" })
      .fill(traceId);
    await expect
      .poll(() => last().searchParams.get("correlationId"))
      .toBe(traceId);
    await page.getByRole("textbox", { name: "Model" }).fill("claude");
    await expect.poll(() => last().searchParams.get("model")).toBe("claude");

    await page.getByRole("radio", { name: "Spans" }).check();
    await expect.poll(() => last().pathname).toBe("/v1/telemetry/spans");
    await expect(
      page.getByRole("columnheader", { name: "Duration" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect
      .poll(() => [...last().searchParams.keys()].sort())
      .toEqual(["from", "severity", "to"]);
    await expect(page.getByRole("radio", { name: "Spans" })).toBeChecked();

    await page
      .getByRole("searchbox", { name: "Search telemetry" })
      .fill("a\\b");
    await expect(page.getByRole("alert")).toHaveText(
      /can’t include backslashes/,
    );
  });

  test("choosing an error shows its cause, codes, request ID, teammate, and trace", async ({
    page,
    context,
  }) => {
    await telemetryWorkspace(context);
    await page.goto("/telemetry");
    const row = page
      .getByRole("table")
      .getByRole("button", { name: /Model request failed/ });
    await row.focus();
    await page.keyboard.press("Enter");
    const detail = page.getByRole("complementary", {
      name: "Model request failed",
    });
    await expect(detail.getByRole("heading", { level: 2 })).toBeFocused();
    await expect(row).toHaveAttribute("aria-pressed", "true");
    await expect(
      detail.getByText("The provider’s rate limit was reached."),
    ).toBeVisible();
    await expect(
      detail.getByText("Wait a moment, then send the message again."),
    ).toBeVisible();
    const facts: [string, string][] = [
      ["Category", "rate_limit"],
      ["Code", "rate_limit_error"],
      ["HTTP status", "429"],
      ["Provider request ID", "req_011CUrateLimit"],
      ["Retrying may help", "Yes"],
      ["Provider", "Claude"],
      ["Model", "claude-opus-5-5"],
      ["Retry after", "20"],
      ["Trace ID", traceId],
    ];
    for (const [label, value] of facts)
      await expect(
        detail
          .locator("dt", { hasText: new RegExp(`^${label}$`) })
          .locator("+ dd"),
      ).toHaveText(value);
    await expect(
      detail.getByRole("link", { name: "Open conversation" }),
    ).toHaveAttribute("href", `/team/${teammate.id}`);
    await expect(
      detail.getByText("Rate limit reached for requests per minute"),
    ).toBeVisible();

    const spans = detail.getByRole("list", { name: "Spans, in tree order" });
    await expect(spans.getByRole("button")).toHaveText([
      /Teammate turn/,
      /Model prompt/,
      /Provider request to api\.anthropic\.com/,
    ]);
    const provider = spans.getByRole("button", { name: /Provider request/ });
    await provider.click();
    await expect(provider).toHaveAttribute("aria-expanded", "true");
    await expect(
      detail.getByText("api.anthropic.com", { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("button", { name: /Teammate turn failed/ }),
    ).toBeVisible();

    await detail.getByRole("button", { name: "Close details" }).click();
    await expect(detail).toBeHidden();
    await expect(row).toBeFocused();
  });

  test("Up and Down move between records", async ({ page, context }) => {
    const workspace = await telemetryWorkspace(context);
    workspace.eventPages.set("", {
      records: [
        record(),
        record({
          id: "11111111-2222-4333-8444-555555555555",
          title: "Teammate turn failed",
          type: "turn",
          name: "turn.failed",
          category: null,
          code: "MODEL_REQUEST_FAILED",
          httpStatus: null,
        }),
      ],
      nextCursor: null,
    });
    await page.goto("/telemetry");
    await page.getByRole("button", { name: /Model request failed/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("button", { name: /Teammate turn failed/ }),
    ).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(
      page.getByRole("button", { name: /Model request failed/ }),
    ).toBeFocused();
  });

  test("newer records are announced without moving the list or closing the open record", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    await page.clock.install();
    await page.goto("/telemetry");
    await page.getByRole("button", { name: /Model request failed/ }).click();
    const detail = page.getByRole("complementary", {
      name: "Model request failed",
    });
    await expect(detail).toBeVisible();
    workspace.eventPages.set("", {
      records: [
        record({
          id: "99999999-8888-4777-8666-555555555555",
          time: "2026-10-23T11:59:30.000Z",
          title: "Request failed",
          type: "http",
          name: "http.request.failed",
          category: null,
          code: "INTERNAL_ERROR",
          httpStatus: 500,
          model: null,
        }),
        record(),
      ],
      nextCursor: null,
    });
    await page.clock.fastForward(16_000);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "1 newer record match these filters." }),
    ).toBeVisible();
    await expect(page.locator(".telemetry-row-button").first()).toContainText(
      "Model request failed",
    );
    await expect(detail).toBeVisible();
    await page.getByRole("button", { name: "Show newer records" }).click();
    await expect(page.locator(".telemetry-row-button").first()).toContainText(
      "Request failed",
    );
    await expect(detail).toBeVisible();
  });

  test("older records load below the ones already shown", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    workspace.eventPages.set("", {
      records: [record()],
      nextCursor: "page-two",
    });
    workspace.eventPages.set("page-two", {
      records: [
        record({
          id: "22222222-3333-4444-8555-666666666666",
          time: "2026-10-23T10:00:00.000Z",
          title: "Context compaction failed",
          type: "turn",
          name: "compaction.failed",
          category: "context_length",
          code: null,
          httpStatus: null,
        }),
      ],
      nextCursor: null,
    });
    await page.goto("/telemetry");
    await page.getByRole("button", { name: "Load older records" }).click();
    await expect(page.locator(".telemetry-row-button")).toHaveText([
      /Model request failed/,
      /Context compaction failed/,
    ]);
    await expect(
      page.getByRole("button", { name: "Load older records" }),
    ).toBeHidden();
    expect(
      workspace.requests.some(
        (url) => url.searchParams.get("cursor") === "page-two",
      ),
    ).toBe(true);
  });

  test("empty, turned-off, and unavailable telemetry explain themselves", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    workspace.eventPages.set("", { records: [], nextCursor: null });
    await page.goto("/telemetry");
    await expect(
      page.getByRole("heading", { name: "No errors in this time range" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show all severities" }).click();
    await expect(page.getByRole("combobox", { name: "Severity" })).toHaveText(
      /All severities/,
    );
    await expect(
      page.getByRole("heading", { name: "Nothing matches these filters" }),
    ).toBeVisible();

    workspace.status = {
      state: "unavailable",
      retentionDays: 7,
      export: {
        lastSuccessAt: null,
        lastFailureAt: "2026-10-23T11:00:00.000Z",
        failedBatches: 3,
        droppedRecords: 0,
      },
    };
    workspace.listStatus = 503;
    await page.reload();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Telemetry storage isn’t responding right now." }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Telemetry couldn’t be loaded." }),
    ).toBeVisible();
    await expect(
      page
        .locator("#workspace-content")
        .getByRole("button", { name: "Try again" }),
    ).toBeVisible();

    workspace.status = { state: "disabled", retentionDays: 7, export: null };
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Telemetry is turned off" }),
    ).toBeVisible();
    await expect(
      page.getByRole("search", { name: "Filter telemetry" }),
    ).toBeHidden();
  });
});

test.describe("phone", { tag: "@phone" }, () => {
  test("Telemetry is left out of the bottom bar and its address explains it needs a larger screen", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    await page.goto("/");
    const bar = page.getByRole("navigation", { name: "Mobile workspace" });
    await expect(bar.getByRole("link")).toHaveText([
      "Home",
      "Updates",
      "Team",
      "Apps",
      "Workspaces",
      "Keys",
    ]);
    await page.goto("/telemetry");
    await expect(
      page.getByRole("heading", { name: "Telemetry needs a larger screen" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Home" })).toBeVisible();
    await expect(
      page.getByRole("search", { name: "Filter telemetry" }),
    ).toHaveCount(0);
    expect(
      workspace.requests,
      "the phone page loads no telemetry",
    ).toHaveLength(0);
  });
});
