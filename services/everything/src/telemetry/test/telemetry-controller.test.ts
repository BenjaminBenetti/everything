import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  TelemetryQuery,
  TelemetrySpan,
  TelemetryTrace,
} from "@everything/telemetry-contracts";
import {
  authenticatedTestServer,
  testSubject,
} from "../../http/test/test-server.js";
import { telemetryController } from "../controller/telemetry-controller.js";
import { TelemetryRecordNotFoundError } from "../error/telemetry-errors.js";
import type { TelemetryReader } from "../interface/telemetry-reader.js";

/** A span of the trace the fake reader returns for `traceId`, with previews of every kind. */
const previewSpan: TelemetrySpan = {
  id: "eee19b7ec3c1b174",
  source: "spans",
  time: "2026-10-23T11:00:00.000Z",
  startTime: "2026-10-23T11:00:00.000Z",
  type: "turn",
  severity: "info",
  outcome: "success",
  name: "teammate.turn",
  title: "Teammate turn",
  category: null,
  code: null,
  httpStatus: null,
  durationMs: 12,
  agentId: null,
  provider: null,
  model: null,
  traceId: "5b8efff798038103d269b633813fc60c",
  spanId: "eee19b7ec3c1b174",
  parentSpanId: null,
  kind: "internal",
  statusMessage: null,
  textWithheld: false,
  previews: [
    {
      kind: "message",
      format: "text",
      value: "Plan the launch",
      truncated: false,
      originalLength: 15,
    },
    {
      kind: "tool_arguments",
      format: "json",
      value: '{"path":"a.txt"}',
      truncated: true,
      originalLength: null,
    },
    {
      kind: "sql",
      format: "sql",
      value: "SELECT 1",
      truncated: false,
      originalLength: null,
    },
  ],
  contentWithheld: false,
  details: [],
  events: [],
};

/** The trace whose spans, previews, and relations the response must carry unchanged. */
const linkedTrace: TelemetryTrace = {
  traceId: "5b8efff798038103d269b633813fc60c",
  spans: [previewSpan],
  events: [],
  truncated: false,
  relations: {
    related: [
      {
        relation: "started_by",
        span: {
          ...previewSpan,
          id: "aaa19b7ec3c1b174",
          spanId: "aaa19b7ec3c1b174",
          traceId: "0d32f64cd7aaab4c985c5a8575db6474",
          name: "POST /v1/agents/:agentId/messages",
          title: "POST /v1/agents/:agentId/messages",
          previews: [],
        },
        localSpanId: "eee19b7ec3c1b174",
      },
    ],
    unresolved: true,
    truncated: false,
  },
};

/** A reader that records the owner and filters each call received. */
function reader() {
  const calls: {
    operation: string;
    ownerId?: string;
    query?: TelemetryQuery;
    id?: string;
  }[] = [];
  const page = {
    records: [],
    nextCursor: null,
    from: "2026-10-22T12:00:00.000Z",
    to: "2026-10-23T12:00:00.000Z",
  };
  const telemetry: TelemetryReader = {
    async status() {
      calls.push({ operation: "status" });
      return {
        state: "available",
        retentionDays: 7,
        errorText: "included",
        content: "withheld",
        export: null,
      };
    },
    async events(ownerId, query) {
      calls.push({ operation: "events", ownerId, query });
      return page;
    },
    async spans(ownerId, query) {
      calls.push({ operation: "spans", ownerId, query });
      return page;
    },
    async event(ownerId, id) {
      calls.push({ operation: "event", ownerId, id });
      throw new TelemetryRecordNotFoundError();
    },
    async trace(ownerId, id) {
      calls.push({ operation: "trace", ownerId, id });
      if (id === linkedTrace.traceId && ownerId === testSubject)
        return linkedTrace;
      throw new TelemetryRecordNotFoundError();
    },
  };
  return { telemetry, calls };
}

/** The controller on a server authenticated as the test subject. */
async function server() {
  const { telemetry, calls } = reader();
  const app = authenticatedTestServer();
  await telemetryController(app, telemetry);
  return { app, calls };
}

test("filters reach the reader with the verified owner and a numeric page size", async () => {
  const { app, calls } = await server();
  const response = await app.inject({
    method: "GET",
    url: "/telemetry/events",
    query: {
      type: "model",
      severity: "error",
      outcome: "failure",
      agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
      provider: "anthropic",
      model: "claude-opus-5-5",
      correlationId: "req_011CUabc",
      search: "rate limit",
      from: "2026-10-22T12:00:00Z",
      limit: "25",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0]?.ownerId, testSubject);
  assert.deepEqual(calls[0]?.query, {
    type: "model",
    severity: "error",
    outcome: "failure",
    agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
    provider: "anthropic",
    model: "claude-opus-5-5",
    correlationId: "req_011CUabc",
    search: "rate limit",
    from: "2026-10-22T12:00:00Z",
    limit: 25,
  });
});

test("owners, unknown filters, backslashes, control characters, and malformed IDs are refused", async () => {
  const { app, calls } = await server();
  const refused = [
    "/telemetry/events?ownerId=someone-else",
    "/telemetry/events?sql=SELECT%201",
    "/telemetry/events?search=x%5C%27%20OR%201%3D1%20--",
    "/telemetry/events?model=a%0Ab",
    "/telemetry/events?search=%20%20",
    "/telemetry/spans?type=everything",
    "/telemetry/spans?limit=0",
    "/telemetry/spans?limit=101",
    "/telemetry/spans?cursor=%27%3B",
    "/telemetry/spans?correlationId=a%20b",
    "/telemetry/spans?provider=evil",
    "/telemetry/spans?from=yesterday",
    "/telemetry/events/not-a-uuid",
    "/telemetry/traces/5B8EFFF798038103D269B633813FC60C",
    "/telemetry/traces/5b8efff798038103d269b633813fc60c'--",
    // A minimum age is for spans only, a whole number of seconds up to an hour.
    "/telemetry/events?minAge=60",
    "/telemetry/spans?minAge=3601",
    "/telemetry/spans?minAge=-1",
    "/telemetry/spans?minAge=1.5",
    "/telemetry/spans?minAge=1e3",
    "/telemetry/spans?minAge=060",
    "/telemetry/spans?minAge=soon",
  ];
  for (const url of refused) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().code, "INVALID_REQUEST", url);
  }
  assert.equal(calls.length, 0, "nothing invalid reaches the reader");
});

test("a span list's minimum age reaches the reader in seconds, from none up to an hour", async () => {
  const { app, calls } = await server();
  for (const minAge of ["0", "60", "3600"]) {
    const response = await app.inject({
      method: "GET",
      url: `/telemetry/spans?minAge=${minAge}&severity=info`,
    });
    assert.equal(response.statusCode, 200, minAge);
  }
  assert.deepEqual(
    calls.map(({ query }) => query?.minAge),
    [0, 60, 3600],
  );
});

test("a trace's content previews and related traces reach the browser as the reader gave them", async () => {
  const { app } = await server();
  const response = await app.inject({
    method: "GET",
    url: `/telemetry/traces/${linkedTrace.traceId}`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), linkedTrace);
});

test("missing and inaccessible records share one response", async () => {
  const { app, calls } = await server();
  const event = await app.inject({
    method: "GET",
    url: "/telemetry/events/bdacb182-a4e6-4a77-8cdf-c40e6263a299",
  });
  const trace = await app.inject({
    method: "GET",
    url: "/telemetry/traces/6b8efff798038103d269b633813fc60c",
  });
  for (const response of [event, trace]) {
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "TELEMETRY_NOT_FOUND");
  }
  assert.deepEqual(
    calls.map(({ ownerId }) => ownerId),
    [testSubject, testSubject],
  );
});

test("status reports state, retention, and whether error text and content are recorded", async () => {
  const { app } = await server();
  const response = await app.inject({
    method: "GET",
    url: "/telemetry/status",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    state: "available",
    retentionDays: 7,
    errorText: "included",
    content: "withheld",
    export: null,
  });
});
