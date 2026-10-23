import type { BrowserContext, Request } from "@playwright/test";

/** The teammate whose failures the explorer shows. */
export const teammate = {
  id: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
  name: "Kiwi helper",
};

/** A trace shared by the failure and its spans. */
export const traceId = "5b8efff798038103d269b633813fc60c";

/** One list entry, with every field the API returns. */
export function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "bdacb182-a4e6-4a77-8cdf-c40e6263a299",
    source: "events",
    time: "2026-10-23T11:58:00.000Z",
    type: "model",
    severity: "error",
    outcome: "failure",
    name: "model.request.failed",
    title: "Model request failed",
    category: "rate_limit",
    code: "rate_limit_error",
    httpStatus: 429,
    durationMs: null,
    agentId: teammate.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    traceId,
    spanId: "eee19b7ec3c1b174",
    ...overrides,
  };
}

/** A span in the shared trace. */
function span(
  id: string,
  name: string,
  title: string,
  parentSpanId: string | null,
  offsetMs: number,
  durationMs: number,
  severity = "info",
) {
  const start = new Date(
    Date.parse("2026-10-23T11:57:59.000Z") + offsetMs,
  ).toISOString();
  return {
    ...record({
      id,
      source: "spans",
      time: start,
      type: name === "provider.request" ? "model" : "turn",
      severity,
      outcome: severity === "error" ? "failure" : "success",
      name,
      title,
      category: null,
      code: null,
      httpStatus: name === "provider.request" ? 429 : null,
      durationMs,
      spanId: id,
    }),
    parentSpanId,
    kind: name === "provider.request" ? "client" : "internal",
    startTime: start,
    statusMessage:
      severity === "error" ? "Model request failed: rate_limit" : null,
    details:
      name === "provider.request"
        ? [{ key: "server_address", label: "Host", value: "api.anthropic.com" }]
        : [],
    events: [],
  };
}

/** The failure's trace: a turn, its prompt, and the provider's refusal. */
export const trace = {
  traceId,
  spans: [
    span(
      "1111111111111111",
      "teammate.turn",
      "Teammate turn",
      null,
      0,
      1_400,
      "error",
    ),
    span(
      "eee19b7ec3c1b174",
      "teammate.prompt",
      "Model prompt",
      "1111111111111111",
      50,
      1_300,
      "error",
    ),
    span(
      "aaa19b7ec3c1b175",
      "provider.request",
      "Provider request to api.anthropic.com",
      "eee19b7ec3c1b174",
      100,
      900,
      "error",
    ),
  ],
  events: [
    record(),
    record({
      id: "c0a8b0f4-1d2e-4f3a-9b8c-7d6e5f4a3b21",
      type: "turn",
      name: "turn.failed",
      title: "Teammate turn failed",
      category: null,
      code: "MODEL_REQUEST_FAILED",
      httpStatus: null,
      spanId: "1111111111111111",
    }),
  ],
  truncated: false,
};

/** Server-side state the tests observe and control. */
export interface TelemetryWorkspace {
  status: { state: string; retentionDays: number; export: unknown };
  /** Pages returned for event listings, by cursor; the first page has no cursor. */
  eventPages: Map<string, { records: unknown[]; nextCursor: string | null }>;
  spanRecords: unknown[];
  /** Status for listings; 200 returns pages. */
  listStatus: number;
  /** Telemetry requests the page made, in order. */
  readonly requests: URL[];
}

/**
 * Mock every API route the workspace uses, with the Telemetry routes answering from mutable state,
 * so tests run against an isolated UI server without a cluster.
 */
export async function telemetryWorkspace(
  context: BrowserContext,
): Promise<TelemetryWorkspace> {
  const state: TelemetryWorkspace = {
    status: { state: "available", retentionDays: 7, export: null },
    eventPages: new Map([["", { records: [record()], nextCursor: null }]]),
    spanRecords: trace.spans,
    listStatus: 200,
    requests: [],
  };
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  const json = (pattern: string | RegExp, body: unknown, status = 200) =>
    context.route(pattern, (route) =>
      status === 204
        ? route.fulfill({ status })
        : route.fulfill({ status, json: body }),
    );
  await json("**/v1/session", {
    profile: { subject: "telemetry-owner", displayName: "Telemetry owner" },
  });
  await json("**/v1/providers", { providers: [] });
  const agent = {
    ...teammate,
    avatarId: "avatar-03",
    systemPrompt: "Help with launches.",
    createdAt: "2026-10-12T10:00:00Z",
    inference: {
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
    },
  };
  await json("**/v1/agents", { agents: [agent] });
  await json("**/v1/agents/recent", { agents: [agent] });
  await json("**/v1/workspaces", { workspaces: [] });
  await json("**/v1/keys", { keys: [] });
  await json("**/v1/updates**", { updates: [], nextCursor: null });
  await json("**/v1/updates/count", { unread: 0 });
  await json("**/v1/settings/general", { summaryInference: null });
  await json("**/v1/settings/teammate-order", { teammateIds: [] });
  await context.route("**/v1/telemetry/**", (route) => {
    const url = new URL(route.request().url());
    state.requests.push(url);
    return route.fulfill(telemetryResponse(state, url, route.request()));
  });
  return state;
}

/** The mocked Telemetry API. */
function telemetryResponse(
  state: TelemetryWorkspace,
  url: URL,
  request: Request,
) {
  if (request.method() !== "GET")
    return { status: 405, json: { code: "METHOD", message: "No" } };
  const range = {
    from: url.searchParams.get("from") ?? "2026-10-22T12:00:00.000Z",
    to: url.searchParams.get("to") ?? "2026-10-23T12:00:00.000Z",
  };
  if (url.pathname === "/v1/telemetry/status") return { json: state.status };
  if (url.pathname.startsWith("/v1/telemetry/traces/"))
    return url.pathname.endsWith(traceId)
      ? { json: trace }
      : {
          status: 404,
          json: { code: "TELEMETRY_NOT_FOUND", message: "Not available." },
        };
  if (url.pathname.startsWith("/v1/telemetry/events/")) {
    const id = url.pathname.split("/").pop();
    const found = [...state.eventPages.values()]
      .flatMap((page) => page.records as { id: string }[])
      .concat(trace.events)
      .find((entry) => entry.id === id);
    return found
      ? {
          json: {
            ...found,
            message: "Rate limit reached for requests per minute",
            requestId: "req_011CUrateLimit",
            sessionId: "6b0f2d1e-3c4a-4b5c-8d6e-7f8091a2b3c4",
            runId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            retryable: true,
            details: [
              { key: "everything_attempts", label: "Attempts", value: "1" },
              {
                key: "everything_retry_after",
                label: "Retry after",
                value: "20",
              },
            ],
          },
        }
      : {
          status: 404,
          json: { code: "TELEMETRY_NOT_FOUND", message: "Not available." },
        };
  }
  if (state.listStatus !== 200)
    return {
      status: state.listStatus,
      json: {
        code: "TELEMETRY_UNAVAILABLE",
        message: "Telemetry storage isn’t responding right now.",
      },
    };
  if (url.pathname === "/v1/telemetry/spans")
    return { json: { records: state.spanRecords, nextCursor: null, ...range } };
  const page = state.eventPages.get(url.searchParams.get("cursor") ?? "") ?? {
    records: [],
    nextCursor: null,
  };
  return { json: { ...page, ...range } };
}
