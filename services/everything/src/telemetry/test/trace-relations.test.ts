import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryTraceRelations } from "@everything/telemetry-contracts";
import type {
  TelemetryRow,
  TelemetrySearch,
} from "../interface/telemetry-search.js";
import { TelemetryQueryService } from "../service/telemetry-query-service.js";

/** A fixed clock: 2026-10-23T12:00:00Z. */
const now = Date.parse("2026-10-23T12:00:00Z");

/** Trace and span IDs of a request and the teammate turn it started. */
const request = {
  traceId: "0d32f64cd7aaab4c985c5a8575db6474",
  spanId: "57b967f57c88f327",
};
const turn = {
  traceId: "88e678de667474342b37d58be4c8b753",
  spanId: "130437fdf4c11324",
};
const runId = "6f0b7b5e-5c1a-4f43-9b5e-0f6b2f7e9a11";

/** Columns every stored span has, as OpenObserve reports them. */
const columns = [
  "_timestamp",
  "trace_id",
  "span_id",
  "start_time",
  "operation_name",
  "reference_parent_span_id",
  "links",
  "everything_owner_id",
  "everything_run_id",
  "everything_type",
];

/** A stored span row for `ownerId`. */
function span(
  ownerId: string,
  ids: { traceId: string; spanId: string },
  options: {
    readonly name?: string;
    readonly parent?: string;
    readonly links?: unknown;
    readonly runId?: string;
    readonly micros?: number;
  } = {},
): TelemetryRow {
  const micros = options.micros ?? Date.parse("2026-10-23T11:00:00Z") * 1000;
  return {
    _timestamp: micros,
    start_time: micros * 1000,
    trace_id: ids.traceId,
    span_id: ids.spanId,
    operation_name: options.name ?? "teammate.prompt",
    everything_owner_id: ownerId,
    everything_type: "turn",
    links:
      typeof options.links === "string"
        ? options.links
        : JSON.stringify(
            (
              (options.links as { traceId: string; spanId: string }[]) ?? []
            ).map((context) => ({ context, droppedAttributesCount: 0 })),
          ),
    ...(options.parent ? { reference_parent_span_id: options.parent } : {}),
    ...(options.runId ? { everything_run_id: options.runId } : {}),
  };
}

/** The literals of a clause such as `column IN ('a', 'b')` or `column = 'a'`. */
function literals(sql: string, pattern: RegExp): string[] | undefined {
  const match = pattern.exec(sql);
  if (!match) return undefined;
  return [...match[1]!.matchAll(/'((?:[^']|'')*)'|(\d+)/g)].map(
    (literal) => literal[1]?.replaceAll("''", "'") ?? literal[2]!,
  );
}

/**
 * A backend over `rows` that answers the query shapes Everything builds: owner, trace, span, and
 * run conditions, a links match, a trace exclusion, start times, and run grouping. With
 * `ignoreOwner` it returns other owners' rows too, as a defective backend might.
 */
function store(
  rows: readonly TelemetryRow[],
  {
    ignoreOwner = false,
    fields = columns,
    fail = (_sql: string) => false as boolean | "hang",
  } = {},
) {
  const queries: string[] = [];
  const search: TelemetrySearch = {
    async search(type, sql) {
      queries.push(sql);
      if (type === "logs") return [];
      const failure = fail(sql);
      if (failure === "hang") return new Promise<TelemetryRow[]>(() => {});
      if (failure) throw new Error("backend failure");
      const owner = literals(sql, /everything_owner_id = ('[^']*')/)![0];
      // Exact tuples, `(trace_id = … AND span_id = …)` or `(… AND _timestamp = …)`, match together.
      const tuples = [
        ...sql.matchAll(
          /\(trace_id = '([0-9a-f]+)' AND (span_id|_timestamp) = '?([0-9a-f]+)'?\)/g,
        ),
      ].map(([, trace, column, value]) => ({ trace, column: column!, value }));
      const traceEquals = tuples.length
        ? undefined
        : literals(sql, /trace_id = ('[^']*')/);
      const traceIn = literals(sql, /trace_id IN \(([^)]*)\)/);
      const spanIn = literals(sql, /span_id IN \(([^)]*)\)/);
      const runIn = literals(sql, /everything_run_id IN \(([^)]*)\)/);
      const timeIn = literals(sql, /_timestamp IN \(([^)]*)\)/);
      const linked = literals(sql, /str_match\(links, ('[^']*')\)/);
      const excluded = literals(sql, /trace_id <> ('[^']*')/);
      const matched = rows.filter(
        (row) =>
          (ignoreOwner || row.everything_owner_id === owner) &&
          (!traceEquals || row.trace_id === traceEquals[0]) &&
          (!traceIn || traceIn.includes(String(row.trace_id))) &&
          (!spanIn || spanIn.includes(String(row.span_id))) &&
          (!runIn || runIn.includes(String(row.everything_run_id))) &&
          (!timeIn || timeIn.includes(String(row._timestamp))) &&
          (!linked || String(row.links).includes(linked[0]!)) &&
          (!excluded || row.trace_id !== excluded[0]) &&
          (!tuples.length ||
            tuples.some(
              (tuple) =>
                row.trace_id === tuple.trace &&
                String(row[tuple.column]) === tuple.value,
            )),
      );
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 500);
      const grouped = /GROUP BY (.+?) ORDER BY/.exec(sql)?.[1];
      if (grouped) {
        // One row per group, with the grouped columns and its earliest time, as SQL returns it.
        const columns = grouped.split(",").map((column) => column.trim());
        const groups = new Map<string, TelemetryRow>();
        for (const row of matched) {
          const key = columns.map((column) => String(row[column])).join("|");
          const time = Number(row._timestamp);
          const group = groups.get(key);
          if (!group || time < Number(group.first_time))
            groups.set(key, {
              ...Object.fromEntries(
                columns.map((column) => [column, row[column]]),
              ),
              first_time: time,
            });
        }
        return [...groups.values()]
          .sort((a, b) => Number(a.first_time) - Number(b.first_time))
          .slice(0, limit);
      }
      return [...matched]
        .sort((a, b) => Number(a.start_time) - Number(b.start_time))
        .slice(0, limit);
    },
    async fields() {
      return new Set(fields);
    },
    async available() {
      return true;
    },
  };
  return { search, queries };
}

/** A query service over `search` with a short relations deadline. */
function service(search: TelemetrySearch, deadlineMs = 2_000) {
  return new TelemetryQueryService(
    { enabled: true, retentionDays: 7 },
    { search, stream: "everything" },
    () => null,
    () => now,
    deadlineMs,
  );
}

/** The kinds and spans of `relations`, for comparing. */
function summary(relations: TelemetryTraceRelations | null) {
  return relations?.related.map((related) => ({
    relation: related.relation,
    traceId: related.span.traceId,
    spanId: related.span.spanId,
    localSpanId: related.localSpanId,
  }));
}

/** A request, the turn it started, and the turn's prompt, all owner A's. */
const linkedWork = [
  span("owner-a", request, {
    name: "POST /v1/agents/:agentId/messages",
    runId,
  }),
  span("owner-a", turn, {
    name: "teammate.turn",
    links: [request],
    runId,
    micros: Date.parse("2026-10-23T11:00:01Z") * 1000,
  }),
  span(
    "owner-a",
    { traceId: turn.traceId, spanId: "d3740a3975aa3884" },
    {
      parent: turn.spanId,
      runId,
      micros: Date.parse("2026-10-23T11:00:02Z") * 1000,
    },
  ),
];

test("a turn shows the request that started it, and the request the turn it started, each once", async () => {
  const { search, queries } = store(linkedWork);
  const fromTurn = await service(search).trace("owner-a", turn.traceId);
  assert.deepEqual(summary(fromTurn.relations), [
    {
      relation: "started_by",
      traceId: request.traceId,
      spanId: request.spanId,
      localSpanId: turn.spanId,
    },
  ]);
  assert.equal(fromTurn.relations?.unresolved, false);
  assert.equal(
    fromTurn.relations?.related[0]?.span.title,
    "POST /v1/agents/:agentId/messages",
  );
  const fromRequest = await service(search).trace("owner-a", request.traceId);
  assert.deepEqual(
    summary(fromRequest.relations),
    [
      {
        relation: "started",
        traceId: turn.traceId,
        spanId: turn.spanId,
        localSpanId: request.spanId,
      },
    ],
    "the turn shares the run too, but is listed once, by its link",
  );
  assert.equal(fromRequest.spans.length, 1, "the traces stay separate");
  assert.ok(
    queries.every((sql) => sql.includes("everything_owner_id = 'owner-a'")),
    "every query is limited to the owner",
  );
});

test("a turn still running is found by its run before its own span is stored, and labelled as the same run", async () => {
  const running = linkedWork.filter((row) => row.span_id !== turn.spanId);
  const { search } = store(running);
  const fromRequest = await service(search).trace("owner-a", request.traceId);
  assert.deepEqual(summary(fromRequest.relations), [
    {
      relation: "same_run",
      traceId: turn.traceId,
      spanId: "d3740a3975aa3884",
      localSpanId: null,
    },
  ]);
});

test("a link to work that isn't the owner's, or isn't stored, is unresolved without naming it", async () => {
  const foreign = {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
  };
  const rows = [
    span("owner-b", foreign, { name: "POST /v1/agents/:agentId/messages" }),
    span("owner-a", turn, { name: "teammate.turn", links: [foreign] }),
  ];
  for (const ignoreOwner of [false, true]) {
    const { search } = store(rows, { ignoreOwner });
    const trace = await service(search).trace("owner-a", turn.traceId);
    assert.deepEqual(trace.relations?.related, [], String(ignoreOwner));
    assert.equal(trace.relations?.unresolved, true);
    assert.ok(
      !JSON.stringify(trace.relations).includes(foreign.traceId),
      "the other trace's ID isn't returned",
    );
  }
  // Owner B's traces that link to owner A's are never listed, even by a backend that returns them.
  const { search } = store(
    [
      ...linkedWork,
      span("owner-b", foreign, { name: "teammate.turn", links: [request] }),
    ],
    { ignoreOwner: true },
  );
  const fromRequest = await service(search).trace("owner-a", request.traceId);
  assert.ok(!JSON.stringify(fromRequest.relations).includes(foreign.traceId));
});

test("malformed, oversized, zero, or uppercase link IDs and records from before links were kept relate nothing", async () => {
  for (const links of [
    "not json",
    `[${'{"context":{"traceId":"0d32f64cd7aaab4c985c5a8575db6474","spanId":"57b967f57c88f327"}},'.repeat(100)}{}]`,
    JSON.stringify([
      { context: { traceId: "0".repeat(32), spanId: "0".repeat(16) } },
    ]),
    JSON.stringify([
      {
        context: {
          traceId: request.traceId.toUpperCase(),
          spanId: request.spanId.toUpperCase(),
        },
      },
    ]),
    JSON.stringify({ context: request }),
  ]) {
    const { search } = store([
      linkedWork[0]!,
      span("owner-a", turn, { name: "teammate.turn", links }),
    ]);
    const trace = await service(search).trace("owner-a", turn.traceId);
    assert.deepEqual(trace.relations, {
      related: [],
      unresolved: false,
      truncated: false,
    });
  }
  const old = store(
    linkedWork.map(({ links: _links, everything_run_id: _run, ...row }) => row),
    { fields: columns.filter((column) => column !== "links") },
  );
  const trace = await service(old.search).trace("owner-a", request.traceId);
  assert.deepEqual(trace.relations, {
    related: [],
    unresolved: false,
    truncated: false,
  });
});

test("a request that started more work than one list shows says so", async () => {
  const started = Array.from({ length: 15 }, (_, index) =>
    span(
      "owner-a",
      {
        traceId: `${index.toString(16).padStart(2, "0")}${"c".repeat(30)}`,
        spanId: `${index.toString(16).padStart(2, "0")}${"d".repeat(14)}`,
      },
      { name: "teammate.prompt", links: [request], micros: 1_000 + index },
    ),
  );
  const { search } = store([linkedWork[0]!, ...started]);
  const trace = await service(search).trace("owner-a", request.traceId);
  assert.equal(trace.relations?.related.length, 10);
  assert.equal(trace.relations?.truncated, true);
});

test("related traces that fail or take too long leave the trace shown without them", async () => {
  for (const fail of [
    (sql: string) => sql.includes("str_match"),
    (sql: string) => (sql.includes("GROUP BY") ? ("hang" as const) : false),
  ]) {
    const { search } = store(linkedWork, { fail });
    const started = Date.now();
    const trace = await service(search, 200).trace("owner-a", request.traceId);
    assert.equal(trace.relations, null);
    assert.equal(trace.spans.length, 1);
    assert.ok(Date.now() - started < 2_000, "the deadline holds");
  }
});
