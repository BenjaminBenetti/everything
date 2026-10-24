import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryQuery } from "@everything/telemetry-contracts";
import {
  authenticatedTestServer,
  testSubject,
} from "../../http/test/test-server.js";
import { telemetryController } from "../controller/telemetry-controller.js";
import { TelemetryRecordNotFoundError } from "../error/telemetry-errors.js";
import type { TelemetryReader } from "../interface/telemetry-reader.js";

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
        errorText: "withheld",
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
  ];
  for (const url of refused) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().code, "INVALID_REQUEST", url);
  }
  assert.equal(calls.length, 0, "nothing invalid reaches the reader");
});

test("missing and inaccessible records share one response", async () => {
  const { app, calls } = await server();
  const event = await app.inject({
    method: "GET",
    url: "/telemetry/events/bdacb182-a4e6-4a77-8cdf-c40e6263a299",
  });
  const trace = await app.inject({
    method: "GET",
    url: "/telemetry/traces/5b8efff798038103d269b633813fc60c",
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

test("status reports state, retention, and whether error text is recorded", async () => {
  const { app } = await server();
  const response = await app.inject({
    method: "GET",
    url: "/telemetry/status",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    state: "available",
    retentionDays: 7,
    errorText: "withheld",
    export: null,
  });
});
