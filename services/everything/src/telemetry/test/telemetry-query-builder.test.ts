import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sqlLiteral,
  TelemetryQueryBuilder,
} from "../service/telemetry-query-builder.js";

/** Every column the stream has after receiving Everything's records. */
const allFields = new Set([
  "_timestamp",
  "body",
  "trace_id",
  "span_id",
  "operation_name",
  "status_message",
  "start_time",
  "everything_owner_id",
  "everything_event_id",
  "everything_event",
  "everything_type",
  "everything_severity",
  "everything_outcome",
  "everything_agent_id",
  "everything_provider",
  "everything_model",
  "everything_session_id",
  "everything_run_id",
  "everything_request_id",
  "everything_message",
  "everything_code",
  "everything_category",
  "everything_error_type",
  "everything_tool",
  "http_route",
  "server_address",
]);

const builder = new TelemetryQueryBuilder("everything");

test("every page query is limited to the owner and orders newest first with a look-ahead row", () => {
  const sql = builder.page("logs", { ownerId: "owner-a" }, allFields, 50);
  assert.equal(
    sql,
    `SELECT * FROM "everything" WHERE everything_owner_id = 'owner-a' ORDER BY _timestamp DESC, everything_event_id DESC LIMIT 51`,
  );
});

test("filters become fixed clauses with escaped literals", () => {
  const sql = builder.page(
    "traces",
    {
      ownerId: "owner-a",
      type: "model",
      severity: "warning",
      outcome: "failure",
      agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
      provider: "anthropic",
      model: "claude's",
      correlationId: "req_123",
      search: "rate limit",
      cursor: { time: 1_792_730_463_218_744, key: "aaa19b7ec3c1b175" },
    },
    allFields,
    25,
  );
  assert.equal(
    sql,
    [
      `SELECT * FROM "everything" WHERE everything_owner_id = 'owner-a'`,
      `everything_type = 'model'`,
      `everything_severity IN ('error', 'warning')`,
      `everything_outcome = 'failure'`,
      `everything_agent_id = '0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c'`,
      `everything_provider = 'anthropic'`,
      `(str_match_ignore_case(everything_model, 'claude''s'))`,
      `(trace_id = 'req_123' OR span_id = 'req_123' OR everything_session_id = 'req_123' OR everything_run_id = 'req_123' OR everything_request_id = 'req_123')`,
      `(str_match_ignore_case(operation_name, 'rate limit') OR str_match_ignore_case(status_message, 'rate limit') OR str_match_ignore_case(everything_code, 'rate limit') OR str_match_ignore_case(everything_tool, 'rate limit') OR str_match_ignore_case(http_route, 'rate limit') OR str_match_ignore_case(server_address, 'rate limit'))`,
      `(_timestamp < 1792730463218744 OR (_timestamp = 1792730463218744 AND span_id < 'aaa19b7ec3c1b175')) ORDER BY _timestamp DESC, span_id DESC LIMIT 26`,
    ].join(" AND "),
  );
});

test("quotes cannot end a literal and the owner clause stays first", () => {
  const sql = builder.page(
    "logs",
    { ownerId: "owner-a", search: "x' OR everything_owner_id = 'owner-b" },
    allFields,
    10,
  )!;
  assert.match(
    sql,
    /^SELECT \* FROM "everything" WHERE everything_owner_id = 'owner-a' AND /,
  );
  assert.match(sql, /'x'' OR everything_owner_id = ''owner-b'/);
});

test("backslashes and control characters are refused, since OpenObserve treats a backslash as an escape", () => {
  // Against OpenObserve, `'nobody\'' OR 1=1 --'` ends the literal early and returns every row.
  for (const value of [
    "nobody\\' OR 1=1 --",
    "a\\b",
    "line\nbreak",
    "nul\u0000",
    "tab\t",
  ])
    assert.throws(() => sqlLiteral(value), /backslashes or control characters/);
  assert.throws(() =>
    builder.page(
      "logs",
      { ownerId: "owner-a", model: "x\\' OR 1=1 --" },
      allFields,
      10,
    ),
  );
  assert.throws(() =>
    builder.page("logs", { ownerId: "owner\\'" }, allFields, 10),
  );
});

test("an owner is always required and stream names are fixed identifiers", () => {
  assert.throws(
    () => builder.page("logs", { ownerId: "" }, allFields, 10),
    /require an owner/,
  );
  assert.throws(
    () => new TelemetryQueryBuilder('everything" OR 1=1'),
    /Invalid telemetry stream/,
  );
});

test("a filter on a column the stream has never received matches nothing without asking the backend", () => {
  const fields = new Set([
    "_timestamp",
    "everything_owner_id",
    "everything_event_id",
    "trace_id",
    "span_id",
  ]);
  assert.equal(
    builder.page(
      "logs",
      { ownerId: "owner-a", provider: "anthropic" },
      fields,
      10,
    ),
    null,
  );
  assert.equal(
    builder.page("logs", { ownerId: "owner-a" }, new Set(), 10),
    null,
  );
  assert.notEqual(
    builder.page(
      "logs",
      { ownerId: "owner-a", correlationId: "abc" },
      fields,
      10,
    ),
    null,
    "a correlation ID only needs one of its columns",
  );
});

test("info severity does not filter, and limits are bounded", () => {
  const sql = builder.page(
    "logs",
    { ownerId: "owner-a", severity: "info" },
    allFields,
    10_000,
  )!;
  assert.doesNotMatch(sql, /everything_severity/);
  assert.match(sql, /LIMIT 501$/);
});

test("event and trace lookups require the owner too", () => {
  assert.equal(
    builder.event("owner-a", "bdacb182-a4e6-4a77-8cdf-c40e6263a299", allFields),
    `SELECT * FROM "everything" WHERE everything_owner_id = 'owner-a' AND everything_event_id = 'bdacb182-a4e6-4a77-8cdf-c40e6263a299' LIMIT 1`,
  );
  assert.equal(
    builder.trace(
      "traces",
      "owner-a",
      "5b8efff798038103d269b633813fc60c",
      allFields,
      500,
    ),
    `SELECT * FROM "everything" WHERE everything_owner_id = 'owner-a' AND trace_id = '5b8efff798038103d269b633813fc60c' ORDER BY start_time ASC LIMIT 501`,
  );
});

test("relation lookups are fixed queries that start with the owner and write every ID as a literal", () => {
  const fields = new Set([...allFields, "links"]);
  const pair = {
    traceId: "0d32f64cd7aaab4c985c5a8575db6474",
    spanId: "57b967f57c88f327",
  };
  const other = {
    traceId: "1d32f64cd7aaab4c985c5a8575db6474",
    spanId: "67b967f57c88f327",
  };
  // Exact pairs, so a row pairing one link's trace with another's span never matches.
  assert.equal(
    builder.spansById("owner-a", [pair, pair, other], fields, 3),
    `SELECT * FROM "everything" WHERE everything_owner_id = 'owner-a' AND ((trace_id = '0d32f64cd7aaab4c985c5a8575db6474' AND span_id = '57b967f57c88f327') OR (trace_id = '1d32f64cd7aaab4c985c5a8575db6474' AND span_id = '67b967f57c88f327')) ORDER BY start_time ASC LIMIT 4`,
  );
  assert.equal(
    builder.linkedTo("owner-a", pair.traceId, fields, 10),
    `SELECT * FROM "everything" WHERE everything_owner_id = 'owner-a' AND str_match(links, '0d32f64cd7aaab4c985c5a8575db6474') AND trace_id <> '0d32f64cd7aaab4c985c5a8575db6474' ORDER BY start_time ASC LIMIT 11`,
  );
  assert.equal(
    builder.runTraces("owner-a", ["run-1", "run-1"], pair.traceId, fields, 10),
    `SELECT trace_id, everything_owner_id, everything_run_id, MIN(_timestamp) AS first_time FROM "everything" WHERE everything_owner_id = 'owner-a' AND everything_run_id IN ('run-1') AND trace_id <> '0d32f64cd7aaab4c985c5a8575db6474' GROUP BY trace_id, everything_owner_id, everything_run_id ORDER BY first_time ASC LIMIT 11`,
  );
  assert.match(
    builder.runTraces("owner-a", ["run-1", "run-2"], pair.traceId, fields, 10)!,
    / LIMIT 22$/,
    "a trace that recorded two of the runs takes a row for each",
  );
  assert.equal(
    builder.firstSpans(
      "owner-a",
      [
        { traceId: pair.traceId, time: 1792822391766000.7 },
        { traceId: other.traceId, time: 1792822391767000 },
      ],
      fields,
      8,
    ),
    `SELECT * FROM "everything" WHERE everything_owner_id = 'owner-a' AND ((trace_id = '0d32f64cd7aaab4c985c5a8575db6474' AND _timestamp = 1792822391766000) OR (trace_id = '1d32f64cd7aaab4c985c5a8575db6474' AND _timestamp = 1792822391767000)) ORDER BY start_time ASC LIMIT 9`,
  );
  assert.match(
    builder.spansById(
      "owner-a",
      [{ traceId: pair.traceId, spanId: "x'y" }],
      fields,
      1,
    )!,
    /span_id = 'x''y'\)\)/,
    "a quote in a pair stays inside its literal",
  );
  assert.throws(() =>
    builder.spansById(
      "owner-a",
      [{ traceId: "x\\'", spanId: pair.spanId }],
      fields,
      1,
    ),
  );
  // A quote in an owner or run stays inside its literal; a backslash is refused.
  assert.match(
    builder.runTraces("o'wner", ["r'un"], pair.traceId, fields, 1)!,
    /everything_owner_id = 'o''wner' AND everything_run_id IN \('r''un'\)/,
  );
  assert.throws(() => builder.linkedTo("owner-a", "x\\' OR 1=1 --", fields, 1));
  assert.throws(() => builder.linkedTo("", pair.traceId, fields, 1));
});

test("relation lookups match nothing without the columns they need, or anything to look up", () => {
  const pair = {
    traceId: "0d32f64cd7aaab4c985c5a8575db6474",
    spanId: "57b967f57c88f327",
  };
  assert.equal(builder.linkedTo("owner-a", pair.traceId, allFields, 10), null);
  assert.equal(builder.spansById("owner-a", [], allFields, 10), null);
  assert.equal(
    builder.runTraces("owner-a", [], pair.traceId, allFields, 10),
    null,
  );
  assert.equal(builder.firstSpans("owner-a", [], allFields, 10), null);
});
