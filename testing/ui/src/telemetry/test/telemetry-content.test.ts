import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  span,
  telemetryWorkspace,
  trace,
} from "../fixture/telemetry-workspace.js";

/** Where screenshots of the synthetic previews are kept as evidence. */
const evidence = fileURLToPath(
  new URL(
    "../../../../../.local/ui-test-results/telemetry-content-evidence/",
    import.meta.url,
  ),
);

/** A message long enough that the server kept its start and its end. */
const longMessage = `Here is the build log:\n${Array.from({ length: 24 }, (_, line) => `error TS2322 at line ${line + 1}`).join("\n")}\n…[middle of the message not shown]…\nWhy does the build fail?`;

/** The trace, with a turn's message, a tool call's arguments, a query's statement, and a call whose content was withheld. */
function contentTrace() {
  const turn = {
    ...trace.spans[0]!,
    previews: [
      {
        kind: "message",
        format: "text",
        value: longMessage,
        truncated: true,
        originalLength: 12_345,
      },
    ],
  };
  const tool = {
    ...span(
      "4444444444444444",
      "teammate.tool",
      "Tool: write_file",
      "eee19b7ec3c1b174",
      200,
      50,
    ),
    type: "tool",
    previews: [
      {
        kind: "tool_arguments",
        format: "json",
        value: JSON.stringify({
          path: "src/value.ts",
          content: "export const value = 1;…[truncated from 48000 characters]",
          apiKey: "[redacted]",
          env: { NPM_TOKEN: "[value not recorded]" },
        }),
        truncated: true,
        originalLength: null,
      },
    ],
  };
  const query = {
    ...span(
      "5555555555555555",
      "pg.query:SELECT everything",
      "PostgreSQL SELECT",
      "1111111111111111",
      10,
      5,
    ),
    type: "dependency",
    kind: "client",
    previews: [
      {
        kind: "sql",
        format: "sql",
        value:
          'SELECT "m"."id" FROM "messages" "m" WHERE "m"."owner_id" = $1 LIMIT ?',
        truncated: false,
        originalLength: null,
      },
    ],
  };
  const withheld = {
    ...span(
      "6666666666666666",
      "teammate.tool",
      "Tool: bash",
      "eee19b7ec3c1b174",
      300,
      20,
    ),
    type: "tool",
    contentWithheld: true,
  };
  return {
    ...trace,
    spans: [turn, ...trace.spans.slice(1), tool, query, withheld],
  };
}

/** The request, in a trace of its own, that sent the message the turn answered. */
const requestTrace = "0d32f64cd7aaab4c985c5a8575db6474";
const request = {
  ...span(
    "57b967f57c88f327",
    "POST /v1/agents/:agentId/messages",
    "POST /v1/agents/:agentId/messages",
    null,
    -100,
    30,
  ),
  traceId: requestTrace,
  type: "http",
  kind: "server",
};

test.describe("desktop", { tag: "@desktop" }, () => {
  test("a span's message, tool arguments, and SQL statement are labelled, say what they leave out, and expand", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    workspace.trace = contentTrace();
    workspace.spanRecords = workspace.trace.spans;
    await page.goto("/telemetry");
    await page.getByRole("radio", { name: "Spans" }).check();
    await page
      .getByRole("table")
      .getByRole("button", { name: /Tool: write_file/ })
      .click();
    const detail = page.getByRole("complementary", {
      name: "Tool: write_file",
    });
    const spans = detail.getByRole("list", { name: "Spans, in tree order" });
    const tool = spans.locator(".telemetry-span.highlighted");
    const args = tool.getByRole("region", { name: /Tool call arguments/ });
    await expect(args).toContainText("Shortened");
    await expect(args).toContainText(
      "Long values were shortened and some were summarized, so this isn’t everything the tool received.",
    );
    const value = args.getByLabel("Tool call arguments", { exact: true });
    await expect(value).toContainText('"path": "src/value.ts"');
    await expect(value).toContainText('"NPM_TOKEN": "[value not recorded]"');
    await expect(value).toContainText('"apiKey": "[redacted]"');

    await spans.getByRole("button", { name: /Teammate turn/ }).click();
    const message = spans.getByRole("region", {
      name: /Message sent to your teammate/,
    });
    await expect(message).toContainText(
      "Shows the start and end of a 12,345-character message; the middle isn’t shown.",
    );
    const show = message.getByRole("button", { name: "Show all" });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await show.click();
    await expect(
      message.getByRole("button", { name: "Show less" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(message).toContainText("Why does the build fail?");

    await spans.getByRole("button", { name: /PostgreSQL SELECT/ }).click();
    const statement = spans.getByRole("region", { name: /SQL statement/ });
    await expect(statement).toContainText(
      "Parameters appear as $1, $2, … and values written into the statement as ?; neither is recorded.",
    );
    await expect(statement).toContainText('"m"."owner_id" = $1 LIMIT ?');

    await spans.getByRole("button", { name: /Tool: bash/ }).click();
    await expect(spans.getByText("Content withheld")).toBeVisible();
    await page.screenshot({
      path: `${evidence}previews.png`,
    });
  });

  test("related traces open as their own traces, and links to work that isn't available say so", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    workspace.trace = {
      ...trace,
      relations: {
        related: [
          {
            relation: "started_by",
            span: request,
            localSpanId: "1111111111111111",
          },
        ],
        unresolved: true,
        truncated: true,
      },
    };
    workspace.otherTraces.set(requestTrace, {
      traceId: requestTrace,
      spans: [request],
      events: [],
      truncated: false,
      relations: {
        related: [
          {
            relation: "started",
            span: trace.spans[0],
            localSpanId: request.id,
          },
        ],
        unresolved: false,
        truncated: false,
      },
    });
    await page.goto("/telemetry");
    await page.getByRole("button", { name: /Model request failed/ }).click();
    const detail = page.getByRole("complementary", {
      name: "Model request failed",
    });
    const related = detail.getByRole("region", { name: "Related traces" });
    await expect(related).toContainText("Started by");
    await expect(related).toContainText(
      "This trace links to work that isn’t available: it may not be stored yet, or it has expired.",
    );
    await expect(related).toContainText(
      "Only the first related traces are listed.",
    );
    await related
      .getByRole("button", { name: /POST \/v1\/agents\/:agentId\/messages/ })
      .click();

    const opened = page.getByRole("complementary", {
      name: "POST /v1/agents/:agentId/messages",
    });
    await expect(opened).toBeVisible();
    await expect
      .poll(() =>
        workspace.requests.some((url) =>
          url.pathname.endsWith(`/traces/${requestTrace}`),
        ),
      )
      .toBe(true);
    const back = opened.getByRole("region", { name: "Related traces" });
    await expect(back).toContainText("Started");
    await back.getByRole("button", { name: /Teammate turn/ }).click();
    await expect(
      page.getByRole("complementary", { name: "Teammate turn" }),
    ).toBeVisible();

    workspace.trace = { ...trace, relations: null };
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(
      page.getByText(
        "Related traces couldn’t be looked up this time. Refresh to try again.",
      ),
    ).toBeVisible();
  });

  test("a trace from an API without related traces or previews shows its spans as before", async ({
    page,
    context,
  }) => {
    const workspace = await telemetryWorkspace(context);
    // A trace as an API from before related traces and previews returned it.
    const { relations: _relations, ...older } = trace;
    workspace.trace = {
      ...older,
      spans: trace.spans.map(
        ({ previews: _previews, contentWithheld: _withheld, ...rest }) => rest,
      ),
    };
    await page.goto("/telemetry");
    await page.getByRole("button", { name: /Model request failed/ }).click();
    const detail = page.getByRole("complementary", {
      name: "Model request failed",
    });
    await expect(
      detail.getByRole("list", { name: "Spans, in tree order" }),
    ).toBeVisible();
    await expect(detail.getByText("Related traces")).toHaveCount(0);
  });
});
