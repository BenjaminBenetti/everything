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

test("spans can wait to show work that has had time to finish: live by default, a minute, or a custom age", () => {
  const spans = { ...defaultTelemetryFilters, view: "spans" as const };
  const query = (patch: Partial<typeof spans>) => {
    const result = telemetryQuery({ ...spans, ...patch }, now);
    return "query" in result ? result.query : result;
  };
  assert.equal(
    (query({}) as { minAge?: number }).minAge,
    undefined,
    "live shows spans as soon as they're stored",
  );
  assert.equal((query({ delay: "1m" }) as { minAge?: number }).minAge, 60);
  assert.equal(
    (query({ delay: "custom", customDelay: " 15 " }) as { minAge?: number })
      .minAge,
    900,
  );
  assert.equal(
    (query({ delay: "custom", customDelay: "60" }) as { minAge?: number })
      .minAge,
    3_600,
  );
  for (const customDelay of ["0", "61", "1.5", "-1", "", "1e2", "ten"])
    assert.deepEqual(
      query({ delay: "custom", customDelay }),
      { error: "Choose a span age of 1 to 60 whole minutes." },
      customDelay,
    );
  // The range is still the one chosen; the server ends it at the cutoff by its own clock.
  assert.equal(
    (query({ delay: "1m" }) as { to?: string }).to,
    "2026-10-23T12:00:00.000Z",
  );
  assert.equal(
    queryString(query({ delay: "1m", severity: "info" }) as never),
    "?from=2026-10-22T12%3A00%3A00.000Z&to=2026-10-23T12%3A00%3A00.000Z&minAge=60&severity=info",
  );
  // Events never wait, whatever the span age says.
  assert.equal(
    (
      telemetryQuery({ ...spans, view: "events", delay: "1m" }, now) as {
        query: { minAge?: number };
      }
    ).query.minAge,
    undefined,
  );
  assert.equal(hasNarrowingFilters({ ...spans, delay: "1m" }), true);
  assert.equal(
    hasNarrowingFilters({ ...spans, view: "events", delay: "1m" }),
    false,
  );
  assert.equal(clearedFilters({ ...spans, delay: "1m" }).delay, "live");
});
