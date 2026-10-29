import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelemetrySpan } from "@everything/telemetry-contracts";
import { TelemetrySearchError } from "../error/telemetry-errors.js";
import type {
  TelemetryRow,
  TelemetrySearch,
  TelemetryStreamType,
  TelemetryWindow,
} from "../interface/telemetry-search.js";
import { TelemetryQueryService } from "../service/telemetry-query-service.js";

/** Columns the fake stream reports for both record kinds. */
const fields = new Set([
  "_timestamp",
  "body",
  "trace_id",
  "span_id",
  "start_time",
  "operation_name",
  "everything_owner_id",
  "everything_event_id",
  "everything_event",
  "everything_type",
  "everything_severity",
  "everything_provider",
]);

/** A fixed clock: 2026-10-23T12:00:00Z. */
const now = Date.parse("2026-10-23T12:00:00Z");

/** A fake backend that returns `rows` and records each query it receives. */
function backend(
  rows: (type: TelemetryStreamType) => TelemetryRow[] = () => [],
) {
  const queries: {
    type: TelemetryStreamType;
    sql: string;
    window: TelemetryWindow;
    size: number;
  }[] = [];
  const search: TelemetrySearch = {
    async search(type, sql, window, size) {
      queries.push({ type, sql, window, size });
      return rows(type);
    },
    async fields() {
      return fields;
    },
    async available() {
      return true;
    },
  };
  return { search, queries };
}

/** An event row for `ownerId`. */
function eventRow(
  ownerId: string,
  eventId: string,
  micros: number,
): TelemetryRow {
  return {
    _timestamp: micros,
    body: "Model request failed",
    everything_owner_id: ownerId,
    everything_event_id: eventId,
    everything_event: "model.request.failed",
    everything_type: "model",
    everything_severity: "error",
    trace_id: "5b8efff798038103d269b633813fc60c",
    span_id: "eee19b7ec3c1b174",
  };
}

/** A query service over the fake backend, retaining seven days. */
function service(
  search: TelemetrySearch | null,
  enabled = true,
  includeErrorText = false,
) {
  return new TelemetryQueryService(
    { enabled, retentionDays: 7, includeErrorText },
    search ? { search, stream: "everything" } : null,
    () => ({
      lastSuccessAt: null,
      lastFailureAt: null,
      failedBatches: 0,
      droppedRecords: 0,
    }),
    () => now,
  );
}

test("rows that are not the owner's are discarded even if the backend returns them", async () => {
  const { search } = backend(() => [
    eventRow("owner-a", "11111111-1111-4111-8111-111111111111", 3),
    eventRow("owner-b", "22222222-2222-4222-8222-222222222222", 2),
    {
      ...eventRow("owner-a", "33333333-3333-4333-8333-333333333333", 1),
      everything_owner_id: undefined,
    },
  ]);
  const page = await service(search).events("owner-a", {});
  assert.deepEqual(
    page.records.map((record) => record.id),
    ["11111111-1111-4111-8111-111111111111"],
  );
});

test("pages are newest first with an opaque cursor that resumes after the last record", async () => {
  const rows = [3, 2, 1].map((micros) =>
    eventRow(
      "owner-a",
      `0000000${micros}-1111-4111-8111-111111111111`,
      micros * 1_000_000,
    ),
  );
  const { search, queries } = backend(() => rows);
  const first = await service(search).events("owner-a", { limit: 2 });
  assert.equal(first.records.length, 2);
  assert.ok(first.nextCursor);
  assert.equal(queries[0]!.size, 3, "one extra row detects a next page");
  await service(search).events("owner-a", {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.match(
    queries[1]!.sql,
    /\(_timestamp < 2000000 OR \(_timestamp = 2000000 AND everything_event_id < '00000002-1111-4111-8111-111111111111'\)\)/,
  );
  await assert.rejects(
    service(search).events("owner-a", {
      cursor: Buffer.from('[1,"x\' OR 1=1"]').toString("base64url"),
    }),
    { code: "INVALID_TELEMETRY_CURSOR" },
  );
});

test("ranges default to the last day, are cut to retention, and must be ordered", async () => {
  const { search, queries } = backend();
  const page = await service(search).events("owner-a", {});
  assert.equal(page.to, new Date(now).toISOString());
  assert.equal(page.from, new Date(now - 24 * 60 * 60_000).toISOString());
  await service(search).spans("owner-a", { from: "2026-01-01T00:00:00Z" });
  assert.equal(queries[1]!.window.start, (now - 7 * 24 * 60 * 60_000) * 1000);
  await assert.rejects(
    service(search).events("owner-a", {
      from: "2026-10-23T11:00:00Z",
      to: "2026-10-23T10:00:00Z",
    }),
    { code: "INVALID_TELEMETRY_RANGE" },
  );
});

test("a trace that has nothing of the owner's is indistinguishable from a missing one", async () => {
  const { search, queries } = backend((type) =>
    type === "logs"
      ? [eventRow("owner-b", "22222222-2222-4222-8222-222222222222", 1)]
      : [],
  );
  await assert.rejects(
    service(search).trace("owner-a", "5b8efff798038103d269b633813fc60c"),
    { code: "TELEMETRY_NOT_FOUND", status: 404 },
  );
  assert.ok(
    queries.every((query) =>
      query.sql.includes("everything_owner_id = 'owner-a'"),
    ),
  );
  await assert.rejects(
    service(search).event("owner-a", "22222222-2222-4222-8222-222222222222"),
    { code: "TELEMETRY_NOT_FOUND" },
  );
});

test("turned-off and unreachable telemetry give helpful errors and status", async () => {
  assert.deepEqual(await service(null, false).status(), {
    state: "disabled",
    retentionDays: 7,
    errorText: "withheld",
    content: "withheld",
    export: null,
  });
  assert.equal(
    (await service(null, true, true).status()).errorText,
    "included",
  );
  await assert.rejects(service(null, false).events("owner-a", {}), {
    code: "TELEMETRY_DISABLED",
  });
  assert.equal((await service(null).status()).state, "unavailable");
  await assert.rejects(service(null).events("owner-a", {}), {
    code: "TELEMETRY_UNAVAILABLE",
  });
  const failing: TelemetrySearch = {
    async search() {
      throw new TelemetrySearchError(500);
    },
    async fields() {
      return fields;
    },
    async available() {
      return false;
    },
  };
  await assert.rejects(service(failing).events("owner-a", {}), {
    code: "TELEMETRY_UNAVAILABLE",
  });
  assert.equal((await service(failing).status()).state, "unavailable");
});

test("a column added since the schema was read is retried with fresh columns", async () => {
  let reads = 0;
  let searches = 0;
  const search: TelemetrySearch = {
    async search() {
      searches++;
      if (searches === 1) throw new TelemetrySearchError(20004);
      return [];
    },
    async fields() {
      reads++;
      return fields;
    },
    async available() {
      return true;
    },
  };
  await service(search).events("owner-a", {});
  assert.equal(searches, 2);
  assert.equal(reads, 2);
});

test("a filter on a column the cached schema lacks is checked against fresh columns before matching nothing", async () => {
  let reads = 0;
  const queries: string[] = [];
  const search: TelemetrySearch = {
    async search(_type, sql) {
      queries.push(sql);
      return [];
    },
    async fields() {
      reads++;
      // The provider column arrives after the first schema read.
      return reads === 1
        ? new Set(
            [...fields].filter((field) => field !== "everything_provider"),
          )
        : fields;
    },
    async available() {
      return true;
    },
  };
  await service(search).events("owner-a", { provider: "anthropic" });
  assert.equal(reads, 2);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /everything_provider = 'anthropic'/);
});

test("details say when a record's error text was withheld", async () => {
  const eventId = "44444444-4444-4444-8444-444444444444";
  const withheld = backend(() => [
    { ...eventRow("owner-a", eventId, 2), everything_text_withheld: true },
  ]);
  const hidden = await service(withheld.search).event("owner-a", eventId);
  assert.equal(hidden.textWithheld, true);
  assert.equal(hidden.message, null);
  const recorded = backend(() => [
    {
      ...eventRow("owner-a", eventId, 1),
      everything_message: "Rate limit reached",
    },
  ]);
  const shown = await service(recorded.search, true, true).event(
    "owner-a",
    eventId,
  );
  assert.equal(shown.textWithheld, false);
  assert.equal(shown.message, "Rate limit reached");
});

test("a span list's minimum age ends its range that long before the server's now, and an emptied range has no records", async () => {
  const { search, queries } = backend();
  const page = await service(search).spans("owner-a", {
    from: "2026-10-23T11:45:00Z",
    minAge: 60,
  });
  assert.equal(page.to, "2026-10-23T11:59:00.000Z");
  assert.equal(page.from, "2026-10-23T11:45:00.000Z");
  assert.equal(queries[0]!.window.end, (now - 60_000) * 1000);
  // An absolute range that ended before the cutoff is unchanged.
  await service(search).spans("owner-a", {
    from: "2026-10-23T10:00:00Z",
    to: "2026-10-23T11:00:00Z",
    minAge: 60,
  });
  assert.equal(
    queries[1]!.window.end,
    Date.parse("2026-10-23T11:00:00Z") * 1000,
  );
  // A range entirely younger than the minimum age is empty, without asking the backend.
  const empty = await service(search).spans("owner-a", {
    from: "2026-10-23T11:59:30Z",
    minAge: 60,
  });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.from, empty.to);
  assert.equal(queries.length, 2);
  // Events never wait.
  const events = await service(search).events("owner-a", { minAge: 60 });
  assert.equal(events.to, new Date(now).toISOString());
});

test("spans present their stored previews by kind, say when content was withheld, and older spans have none", async () => {
  const base = {
    _timestamp: 3,
    trace_id: "5b8efff798038103d269b633813fc60c",
    everything_owner_id: "owner-a",
  };
  const { search } = backend(() => [
    {
      ...base,
      span_id: "eee19b7ec3c1b174",
      operation_name: "teammate.turn",
      everything_message_preview: "Plan the launch",
      everything_message_length: 15,
      everything_message_truncated: false,
    },
    {
      ...base,
      span_id: "fff19b7ec3c1b174",
      operation_name: "teammate.tool",
      everything_tool_arguments: '{"path":"a.txt"}',
      everything_tool_arguments_truncated: true,
    },
    {
      ...base,
      span_id: "aaa19b7ec3c1b174",
      operation_name: "pg.query:SELECT everything",
      db_query_text: "SELECT * FROM t WHERE a = $1…[truncated]",
    },
    {
      ...base,
      span_id: "bbb19b7ec3c1b174",
      operation_name: "teammate.tool",
      everything_content_withheld: true,
    },
    { ...base, span_id: "ccc19b7ec3c1b174", operation_name: "teammate.tool" },
    {
      ...base,
      span_id: "ddd19b7ec3c1b174",
      operation_name: "teammate.turn",
      everything_message_preview: "é".repeat(5_000),
    },
  ]);
  const page = await service(search).spans("owner-a", { severity: "info" });
  const [message, args, sql, withheld, older, oversized] =
    page.records as TelemetrySpan[];
  assert.deepEqual(message!.previews, [
    {
      kind: "message",
      format: "text",
      value: "Plan the launch",
      truncated: false,
      originalLength: 15,
    },
  ]);
  assert.deepEqual(args!.previews, [
    {
      kind: "tool_arguments",
      format: "json",
      value: '{"path":"a.txt"}',
      truncated: true,
      originalLength: null,
    },
  ]);
  assert.deepEqual(sql!.previews, [
    {
      kind: "sql",
      format: "sql",
      value: "SELECT * FROM t WHERE a = $1…[truncated]",
      truncated: true,
      originalLength: null,
    },
  ]);
  assert.deepEqual(withheld!.previews, []);
  assert.equal(withheld!.contentWithheld, true);
  assert.deepEqual(older!.previews, []);
  assert.equal(older!.contentWithheld, false);
  const value = oversized!.previews[0]!;
  assert.equal(value.truncated, true, "a stored value over the budget is cut");
  assert.ok(Buffer.byteLength(value.value) <= 2_000);
});
