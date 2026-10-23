import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearedFilters,
  defaultTelemetryFilters,
  hasNarrowingFilters,
  telemetryQuery,
} from "../model/telemetry-filters.js";
import { queryString } from "../adapter/http-telemetry-client.js";

const now = Date.parse("2026-10-23T12:00:00Z");

test("the default view shows errors from the last day", () => {
  assert.deepEqual(telemetryQuery(defaultTelemetryFilters, now), {
    query: {
      from: "2026-10-22T12:00:00.000Z",
      to: "2026-10-23T12:00:00.000Z",
      severity: "error",
    },
  });
});

test("presets, filters, and trimmed text become one query", () => {
  const result = telemetryQuery(
    {
      ...defaultTelemetryFilters,
      view: "spans",
      range: "1h",
      type: "dependency",
      severity: "warning",
      outcome: "failure",
      agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
      provider: "anthropic",
      model: " claude ",
      correlationId: " req_123 ",
      search: " overloaded ",
    },
    now,
  );
  assert.deepEqual(result, {
    query: {
      from: "2026-10-23T11:00:00.000Z",
      to: "2026-10-23T12:00:00.000Z",
      severity: "warning",
      type: "dependency",
      outcome: "failure",
      agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
      provider: "anthropic",
      model: "claude",
      correlationId: "req_123",
      search: "overloaded",
    },
  });
});

test("a type that does not belong to the view is not sent", () => {
  const result = telemetryQuery(
    { ...defaultTelemetryFilters, view: "events", type: "dependency" },
    now,
  );
  assert.ok("query" in result && result.query.type === undefined);
});

test("custom ranges must be ordered and filters must be safe to send", () => {
  assert.deepEqual(
    telemetryQuery(
      {
        ...defaultTelemetryFilters,
        range: "custom",
        customFrom: "2026-10-23T10:00",
        customTo: "2026-10-23T09:00",
      },
      now,
    ),
    { error: "Choose a start time before the end time." },
  );
  assert.ok(
    "error" in
      telemetryQuery(
        { ...defaultTelemetryFilters, range: "custom", customFrom: "" },
        now,
      ),
  );
  assert.ok(
    "error" in
      telemetryQuery({ ...defaultTelemetryFilters, search: "a\\b" }, now),
  );
  assert.ok(
    "error" in
      telemetryQuery({ ...defaultTelemetryFilters, correlationId: "a b" }, now),
  );
});

test("clearing keeps the view and narrowing is detected", () => {
  const filters = {
    ...defaultTelemetryFilters,
    view: "spans" as const,
    search: "x",
  };
  assert.equal(hasNarrowingFilters(filters), true);
  assert.equal(hasNarrowingFilters(defaultTelemetryFilters), false);
  assert.deepEqual(clearedFilters(filters), {
    ...defaultTelemetryFilters,
    view: "spans",
  });
});

test("queries are encoded for the API without empty values", () => {
  assert.equal(
    queryString({ severity: "error", search: "rate & limit", limit: 25 }),
    "?severity=error&search=rate+%26+limit&limit=25",
  );
  assert.equal(queryString({}), "");
});
