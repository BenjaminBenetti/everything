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

/** No related traces, as a trace without links or other runs has. */
export const noRelations = { related: [], unresolved: false, truncated: false };

/** A span in the shared trace, without content previews unless a test adds them. */
export function span(
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
    textWithheld: false,
    previews: [] as unknown[],
    contentWithheld: false,
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
  relations: noRelations as unknown,
};

/**
 * A synthetic long trace for layout tests: a turn with `prompts` prompts, each with a provider
 * request beneath it, so the trace is taller than any viewport, as a long teammate turn's is. Its
 * spans are named by index.
 */
export function longTrace(prompts: number) {
  const turn = "2000000000000000";
  const id = (kind: 2 | 3, index: number) =>
    `${kind}${String(index).padStart(15, "0")}`;
  const spans = [span(turn, "teammate.turn", "Teammate turn", null, 0, 9_000)];
  for (let index = 1; index <= prompts; index++)
    spans.push(
      span(
        id(2, index),
        "teammate.prompt",
        `Model prompt ${index}`,
        turn,
        index * 200,
        150,
      ),
      span(
        id(3, index),
        "provider.request",
        `Provider request ${index}`,
        id(2, index),
        index * 200 + 5,
        100,
        index === prompts ? "error" : "info",
      ),
    );
  return {
    traceId,
    spans,
    events: [] as unknown[],
    truncated: false,
    relations: noRelations as unknown,
  };
}

/** `count` synthetic failures in the shared trace, newest first, each attributed to `spanOf(index)`. */
export function longRecords(count: number, spanOf: (index: number) => string) {
  return Array.from({ length: count }, (_, index) =>
    record({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      time: new Date(
        Date.parse("2026-10-23T11:58:00.000Z") - index * 60_000,
      ).toISOString(),
      title: `Model request failed ${index}`,
      spanId: spanOf(index),
    }),
  );
}

/** Server-side state the tests observe and control. */
export interface TelemetryWorkspace {
  status: {
    state: string;
    retentionDays: number;
    errorText: string;
    content: string;
    export: unknown;
  };
  /** Pages returned for event listings, by cursor; the first page has no cursor. */
  eventPages: Map<string, { records: unknown[]; nextCursor: string | null }>;
  spanRecords: unknown[];
  /** Status for listings; 200 returns pages. */
  listStatus: number;
  /** What the shared trace holds so far; its records can arrive over time. */
  trace: {
    traceId: string;
    spans: unknown[];
    events: unknown[];
    truncated: boolean;
    /** Related traces, as the API returns them with the trace; absent from older APIs. */
    relations?: unknown;
  };
  /** Other traces the owner can open, such as related ones, by trace ID. */
  otherTraces: Map<string, unknown>;
  /** Status for trace requests; 200 returns `trace`. */
  traceStatus: number;
  /** Trace responses wait for this, when set, as a slow backend would. */
  traceGate: Promise<void> | undefined;
  /** An event's diagnosis beyond its list entry, such as its error text. */
  eventDetail: Record<string, unknown>;
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
    status: {
      state: "available",
      retentionDays: 7,
      errorText: "included",
      content: "included",
      export: null,
    },
    eventPages: new Map([["", { records: [record()], nextCursor: null }]]),
    spanRecords: trace.spans,
    listStatus: 200,
    trace,
    otherTraces: new Map(),
    traceStatus: 200,
    traceGate: undefined,
    eventDetail: {
      message: "Rate limit reached for requests per minute",
      textWithheld: false,
    },
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
  await context.route("**/v1/telemetry/**", async (route) => {
    const url = new URL(route.request().url());
    state.requests.push(url);
    if (url.pathname.startsWith("/v1/telemetry/traces/")) await state.traceGate;
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
  if (url.pathname.startsWith("/v1/telemetry/traces/")) {
    if (!url.pathname.endsWith(traceId)) {
      const other = state.otherTraces.get(url.pathname.split("/").pop()!);
      return other
        ? { json: other }
        : {
            status: 404,
            json: { code: "TELEMETRY_NOT_FOUND", message: "Not available." },
          };
    }
    return state.traceStatus === 200
      ? { json: state.trace }
      : {
          status: state.traceStatus,
          json: {
            code: "TELEMETRY_UNAVAILABLE",
            message: "Telemetry storage isn’t responding right now.",
          },
        };
  }
  if (url.pathname.startsWith("/v1/telemetry/events/")) {
    const id = url.pathname.split("/").pop();
    const found = [...state.eventPages.values()]
      .flatMap((page) => page.records as { id: string }[])
      .concat(state.trace.events as { id: string }[])
      .find((entry) => entry.id === id);
    return found
      ? {
          json: {
            ...found,
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
            ...state.eventDetail,
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
