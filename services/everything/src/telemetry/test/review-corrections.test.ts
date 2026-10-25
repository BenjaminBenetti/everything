import assert from "node:assert/strict";
import { test } from "node:test";
import { createTraceState, type Link } from "@opentelemetry/api";
import {
  TracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { telemetryLimits } from "@everything/telemetry-contracts";
import { exportableSpan } from "../adapter/redacting-exporters.js";
import { RedactingSpanProcessor } from "../adapter/redacting-processors.js";
import type {
  TelemetryRow,
  TelemetrySearch,
} from "../interface/telemetry-search.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import {
  DatabaseStatementProcessor,
  shapeQueryStatement,
} from "../service/database-statement-processor.js";
import { messagePreview } from "../service/message-preview.js";
import { sqlStatementPreview } from "../service/sql-statement.js";
import {
  exportableAttributes,
  type ExportPolicy,
} from "../service/telemetry-allowlist.js";
import { ExportHealth } from "../service/export-health.js";
import { TelemetryQueryService } from "../service/telemetry-query-service.js";
import { utf8Length } from "../service/text-budget.js";
import { toolArgumentsPreview } from "../service/tool-arguments-preview.js";
import { having } from "./sql-fixtures.js";

/**
 * Corrections from the review of 738832d. Every credential-like value here is a deliberately fake
 * canary, marked REVIEWFAKE, never a real credential.
 */

/** Recorded with content, as installations do by default. */
const recorded: ExportPolicy = { includeErrorText: true, includeContent: true };

/** A deliberately fake provider-key shape, recognized by the redactor when written plainly. */
const fakeKey = "sk-proj-REVIEWFAKEcanary0001abcdef";

/** `text` with every character percent-encoded that encoding hides, as a URL path would carry it. */
function percentEncoded(text: string, upper = true): string {
  return text.replace(/[-_=]/g, (character) => {
    const hex = character.charCodeAt(0).toString(16);
    return `%${upper ? hex.toUpperCase() : hex}`;
  });
}

// ===========================================
// P1: percent-encoded credentials in generic previews
// ===========================================

test("P1: a percent-encoded key in a message's URL path is redacted, in the start and the end of a long message", () => {
  const encoded = percentEncoded(fakeKey);
  assert.ok(
    !encoded.includes("sk-proj-"),
    "the fixture really encodes the key",
  );
  for (const message of [
    `Fetch https://gateway.test/v1/${encoded}/messages please`,
    `Fetch https://gateway.test/v1/${percentEncoded(fakeKey, false)}/messages please`,
    `Double: https://gateway.test/v1/${encoded.replaceAll("%", "%25")}/x`,
    `${"word ".repeat(2_000)}then https://gateway.test/v1/${encoded}/end`,
  ]) {
    const preview = messagePreview(message);
    assert.ok(
      !preview.text.includes("REVIEWFAKEcanary0001"),
      `encoded key leaked: ${message.slice(0, 40)}…`,
    );
  }
});

test("P1: a percent-encoded name=value secret in text is redacted, and ordinary encoded text is kept as written", () => {
  const preview = messagePreview(
    "Use api%5Fkey%3DREVIEWFAKEshort01 for the staging call",
  );
  assert.ok(!preview.text.includes("REVIEWFAKEshort01"), preview.text);
  for (const ordinary of [
    "Progress is 100%25 complete, see /docs/a%20b and 50% off, %zz stays",
    "Path /v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/messages%3Fdraft",
  ])
    assert.equal(messagePreview(ordinary).text, ordinary);
});

test("P1: tool arguments with encoded credentials or credential names are redacted, nested too", () => {
  const preview = toolArgumentsPreview({
    "api%5Fkey": "REVIEWFAKEshort02",
    "Client%2Dsecret": "REVIEWFAKEshort03",
    nested: {
      url: `https://gateway.test/v1/${percentEncoded(fakeKey)}/messages`,
      note: "token%3DREVIEWFAKEshort04",
    },
    limit: 50,
  });
  for (const canary of [
    "REVIEWFAKEshort02",
    "REVIEWFAKEshort03",
    "REVIEWFAKEcanary0001",
    "REVIEWFAKEshort04",
  ])
    assert.ok(!preview.text.includes(canary), `${canary} leaked`);
  assert.equal(JSON.parse(preview.text).limit, 50, "harmless values stay");
});

test("P1: encoded credentials that reach the export boundary are redacted there too", () => {
  const exported = JSON.stringify(
    exportableAttributes(
      {
        [attribute.messagePreview]: `see /v1/${percentEncoded(fakeKey)}/x`,
        [attribute.toolArguments]: JSON.stringify({
          "api%5Fkey": "REVIEWFAKEshort05",
        }),
      },
      recorded,
    ),
  );
  assert.ok(!exported.includes("REVIEWFAKEcanary0001"));
  assert.ok(!exported.includes("REVIEWFAKEshort05"));
});

// ===========================================
// P2: PostgreSQL dollar-quote tags
// ===========================================

/** Ordinary private words, not shaped like any credential, so only the lexer can remove them. */
const privateBody = "the patient prefers morning appointments";

test("P2: dollar-quoted literals with non-ASCII or long tags become placeholders, not copied text", () => {
  const longTag = `t${"x".repeat(70)}`;
  for (const statement of [
    `SELECT $ü$${privateBody}$ü$ AS note FROM visits WHERE id = $1`,
    `SELECT $café_1$${privateBody}$café_1$ AS note`,
    `SELECT $${longTag}$${privateBody}$${longTag}$ AS note`,
  ]) {
    const preview = sqlStatementPreview(statement);
    assert.ok(!preview.text.includes("patient"), preview.text);
  }
  assert.equal(
    sqlStatementPreview(`SELECT $ü$${privateBody}$ü$ AS note WHERE id = $1`)
      .text,
    "SELECT ? AS note WHERE id = $1",
  );
});

test("P2: an unterminated or over-budget dollar quote is cut closed, never copied", () => {
  for (const statement of [
    `SELECT $ü$${privateBody} and it never closes`,
    `SELECT $tag$${"a ".repeat(4_200)}${privateBody}$tag$`,
    `SELECT $${"t".repeat(9_000)}`,
  ]) {
    const preview = sqlStatementPreview(statement);
    assert.ok(!preview.text.includes("patient"), preview.text.slice(-80));
    assert.ok(preview.truncated);
  }
  // Identifiers and placeholders that contain dollars stay as they are.
  assert.equal(
    sqlStatementPreview("SELECT naïve$col, a$b FROM t WHERE x = $2").text,
    "SELECT naïve$col, a$b FROM t WHERE x = $2",
  );
});

test("P2: the request hook, the ending processor, and the exporter all shape such literals away", () => {
  const statement = `SELECT $ü$${privateBody}$ü$ AS note`;
  const tracer = new TracerProvider({
    spanProcessors: [new DatabaseStatementProcessor()],
  }).getTracer("review-p2");
  const hooked = tracer.startSpan("pg.query:SELECT");
  hooked.setAttribute(attribute.dbQueryText, statement);
  shapeQueryStatement(hooked, statement);
  const ended = tracer.startSpan("pg.query:SELECT");
  ended.setAttribute(attribute.dbQueryText, statement);
  hooked.end();
  ended.end();
  for (const span of [hooked, ended] as unknown as ReadableSpan[])
    assert.ok(
      !String(span.attributes[attribute.dbQueryText]).includes("patient"),
    );
  const exported = exportableAttributes(
    { [attribute.dbQueryText]: statement, [attribute.dbStatement]: statement },
    recorded,
  );
  assert.ok(!JSON.stringify(exported).includes("patient"));
});

// ===========================================
// P3: overridable built-ins, huge BigInts, inherited keys
// ===========================================

test("P3: overridden sizes, getters, and methods on built-in objects are never run, and the arguments are unchanged", () => {
  let calls = 0;
  const args: Record<string, unknown> = { kept: "yes" };
  const bytes = new Uint8Array(4);
  Object.defineProperty(bytes, "byteLength", {
    get() {
      calls++;
      args.kept = "mutated";
      return 4;
    },
  });
  class CountingMap extends Map<string, number> {
    /** An overridden size that runs code. */
    override get size(): number {
      calls++;
      return 1;
    }
  }
  const when = new Date("2026-10-24T00:00:00Z");
  Object.assign(when, {
    getTime() {
      calls++;
      return 0;
    },
    toISOString() {
      calls++;
      return "x".repeat(1_000_000);
    },
  });
  args.bytes = bytes;
  args.map = new CountingMap([["a", 1]]);
  args.when = when;
  const preview = toolArgumentsPreview(args);
  assert.equal(calls, 0, "no override ran");
  assert.equal(args.kept, "yes", "the arguments are unchanged");
  assert.ok(utf8Length(preview.text) <= telemetryLimits.previewBytes);
  const parsed = JSON.parse(preview.text) as Record<string, unknown>;
  assert.equal(parsed.bytes, "[binary data, 4 bytes]");
  assert.equal(parsed.map, "[map of 1 entries]");
  assert.equal(parsed.when, "2026-10-24T00:00:00.000Z");
});

test("P3: a huge BigInt is summarized, not written out in full", () => {
  const preview = toolArgumentsPreview({ big: 10n ** 400n, small: 42n });
  const parsed = JSON.parse(preview.text) as Record<string, unknown>;
  assert.equal(parsed.small, "42n");
  assert.ok(!String(parsed.big).includes("0".repeat(100)), String(parsed.big));
  assert.ok(preview.truncated);
});

test("P3: inherited enumerable keys are charged to the walk's budget", () => {
  const inherited: Record<string, number> = {};
  for (let index = 0; index < 50_000; index++) inherited[`k${index}`] = index;
  const args = Object.create(inherited) as Record<string, unknown>;
  args.own = 1;
  const { hasOwn } = Object;
  let checks = 0;
  Object.hasOwn = (target: object, key: PropertyKey) => {
    checks++;
    return hasOwn(target, key);
  };
  let preview;
  try {
    preview = toolArgumentsPreview(args);
  } finally {
    Object.hasOwn = hasOwn;
  }
  assert.ok(checks <= 5_000, `${checks} keys were checked`);
  assert.equal(JSON.parse(preview.text).own, 1);
  assert.ok(preview.truncated, "a walk cut short says so");
});

// ===========================================
// P4: credential assignments inside quoted identifiers
// ===========================================

test("P4: a short name=value credential in a quoted identifier is redacted, and placeholders stay", () => {
  const statement =
    'SELECT 1 AS "password=REVIEWFAKEpw9" FROM t WHERE "token" = $1 AND "api_key" = $2';
  const preview = sqlStatementPreview(statement);
  assert.ok(!preview.text.includes("REVIEWFAKEpw9"), preview.text);
  assert.ok(preview.text.includes('"token" = $1'), preview.text);
  assert.ok(preview.text.includes('"api_key" = $2'), preview.text);
  const exported = exportableAttributes(
    { [attribute.dbQueryText]: statement },
    recorded,
  );
  assert.ok(!JSON.stringify(exported).includes("REVIEWFAKEpw9"));
  assert.equal(
    sqlStatementPreview(preview.text).text,
    preview.text,
    "shaping again changes nothing",
  );
});

// ===========================================
// C1: credentials quoted inside a quoted identifier, with SQL's doubled quotes
// ===========================================

/**
 * A deliberately fake, short, plain credential: no provider-key, opaque-token, or other shape the
 * redactor recognizes on its own, so only the assignment it is written in can give it away.
 */
const quotedCanary = "REVIEWFAKEdq1";

/** `name` as a PostgreSQL quoted identifier, its double quotes doubled as SQL requires. */
const quotedIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The names quoted identifiers spell, decoded, in a shaped statement. */
function identifierNames(shape: string): string[] {
  return [...shape.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
    match[1]!.replaceAll('""', '"'),
  );
}

test("C1: a credential quoted inside a quoted identifier is redacted, the identifier stays valid, and shaping again keeps it so", () => {
  for (const name of [
    `password="${quotedCanary}"`,
    `api_key = "${quotedCanary}"`,
    `note "kept" token="${quotedCanary}"`,
  ]) {
    const statement = `SELECT 1 AS ${quotedIdentifier(name)} FROM t WHERE "token" = $1`;
    const preview = sqlStatementPreview(statement);
    assert.ok(!preview.text.includes(quotedCanary), preview.text);
    assert.ok(preview.text.endsWith('FROM t WHERE "token" = $1'), preview.text);
    assert.ok(
      /^SELECT \? AS "(?:[^"]|"")*" FROM/.test(preview.text),
      `the identifier is still one valid quoted identifier: ${preview.text}`,
    );
    assert.ok(
      identifierNames(preview.text).some((shown) =>
        shown.includes("[redacted]"),
      ),
      preview.text,
    );
    assert.equal(
      sqlStatementPreview(preview.text).text,
      preview.text,
      "shaping again changes nothing",
    );
  }
  // The other quoted text in a name is kept, quotes and all.
  assert.ok(
    identifierNames(
      sqlStatementPreview(
        `SELECT 1 AS ${quotedIdentifier(`note "kept" token="${quotedCanary}"`)}`,
      ).text,
    ).includes('note "kept" token=[redacted]'),
  );
});

test("C1: at the start and end of a statement, past the budget, and unterminated, a doubled-quote credential never shows", () => {
  const identifier = quotedIdentifier(`password="${quotedCanary}"`);
  for (const statement of [
    `${identifier} AS x`,
    `SELECT a FROM t ORDER BY ${identifier}`,
    `SELECT ${"column_name, ".repeat(400)}1 AS ${identifier} FROM t`,
    `SELECT 1 AS "password=""${quotedCanary}`,
    `SELECT 1 AS "password=""${quotedCanary}""`,
  ]) {
    const preview = sqlStatementPreview(statement);
    assert.ok(!preview.text.includes(quotedCanary), preview.text.slice(-80));
    assert.ok(utf8Length(preview.text) <= telemetryLimits.previewBytes);
  }
});

test("C1: the request hook, the ending processor, and the exporter all redact it, and the statement that runs is unchanged", () => {
  const statement = `SELECT 1 AS ${quotedIdentifier(`password="${quotedCanary}"`)} FROM t WHERE id = $1`;
  const original = statement.slice();
  const tracer = new TracerProvider({
    spanProcessors: [new DatabaseStatementProcessor()],
  }).getTracer("review-c1");
  const hooked = tracer.startSpan("pg.query:SELECT");
  hooked.setAttribute(attribute.dbQueryText, statement);
  shapeQueryStatement(hooked, statement);
  const ended = tracer.startSpan("pg.query:SELECT");
  ended.setAttribute(attribute.dbStatement, statement);
  hooked.end();
  ended.end();
  for (const span of [hooked, ended] as unknown as ReadableSpan[])
    assert.ok(
      !JSON.stringify(span.attributes).includes(quotedCanary),
      JSON.stringify(span.attributes),
    );
  const exported = exportableAttributes(
    { [attribute.dbQueryText]: statement, [attribute.dbStatement]: statement },
    recorded,
  );
  assert.ok(!JSON.stringify(exported).includes(quotedCanary));
  assert.equal(statement, original);
});

// ===========================================
// M1 and M2: relation queries against a backend that answers SQL as written
// ===========================================

/** Trace and span IDs as hex, from short labels. */
const traceOf = (label: string) => label.padEnd(32, "0").slice(0, 32);
const spanOf = (label: string) => label.padEnd(16, "0").slice(0, 16);
const runId = "6f0b7b5e-5c1a-4f43-9b5e-0f6b2f7e9a11";

/** A stored span row. */
function row(
  ownerId: string | undefined,
  traceId: string,
  spanId: string,
  micros: number,
  extra: Record<string, unknown> = {},
): TelemetryRow {
  return {
    _timestamp: micros,
    start_time: micros * 1000,
    trace_id: traceId,
    span_id: spanId,
    operation_name: "teammate.prompt",
    links: "[]",
    everything_type: "turn",
    ...(ownerId ? { everything_owner_id: ownerId } : {}),
    ...extra,
  };
}

/** The quoted literals of every match of `pattern`'s first group. */
function literals(sql: string, pattern: RegExp): string[] | undefined {
  const match = pattern.exec(sql);
  if (!match) return undefined;
  return [...match[1]!.matchAll(/'((?:[^']|'')*)'|(\d+)/g)].map(
    (literal) => literal[1] ?? literal[2]!,
  );
}

/**
 * A backend that answers the SQL it is given as SQL would: independent `IN` lists are a cross
 * product, tuple conditions are exact, grouping returns the columns selected, `HAVING` applies to
 * whole groups, and `LIMIT` cuts after ordering. With `ignoreOwner`, its row filter ignores the
 * owner condition and returns other owners' rows, as a faulty backend or a mis-composed `WHERE`
 * might; what it does with groups is unchanged.
 */
function sqlBackend(rows: readonly TelemetryRow[], ignoreOwner = false) {
  const queries: string[] = [];
  const search: TelemetrySearch = {
    async search(type, sql) {
      queries.push(sql);
      if (type === "logs") return [];
      const where =
        /\bWHERE (.*?)(?: GROUP BY | ORDER BY |$)/.exec(sql)?.[1] ?? "";
      const owner = literals(where, /everything_owner_id = ('[^']*')/)?.[0];
      const traceEquals =
        /\bWHERE .*?trace_id = '([0-9a-f]{32})' (?:ORDER|LIMIT)/.exec(sql)?.[1];
      const traceIn = literals(sql, /trace_id IN \(([^)]*)\)/);
      const spanIn = literals(sql, /span_id IN \(([^)]*)\)/);
      const runIn = literals(sql, /everything_run_id IN \(([^)]*)\)/);
      const timeIn = literals(sql, /_timestamp IN \(([^)]*)\)/);
      const linked = literals(sql, /str_match\(links, ('[^']*')\)/)?.[0];
      const excluded = literals(sql, /trace_id <> ('[^']*')/)?.[0];
      const spanPairs = [
        ...sql.matchAll(
          /\(trace_id = '([0-9a-f]+)' AND span_id = '([0-9a-f]+)'\)/g,
        ),
      ].map((match) => [match[1], match[2]]);
      const timePairs = [
        ...sql.matchAll(/\(trace_id = '([0-9a-f]+)' AND _timestamp = (\d+)\)/g),
      ].map((match) => [match[1], match[2]]);
      const matched = rows.filter(
        (candidate) =>
          (ignoreOwner || candidate.everything_owner_id === owner) &&
          (!traceEquals || candidate.trace_id === traceEquals) &&
          (!traceIn || traceIn.includes(String(candidate.trace_id))) &&
          (!spanIn || spanIn.includes(String(candidate.span_id))) &&
          (!runIn || runIn.includes(String(candidate.everything_run_id))) &&
          (!timeIn || timeIn.includes(String(candidate._timestamp))) &&
          (!linked || String(candidate.links).includes(linked)) &&
          (!excluded || candidate.trace_id !== excluded) &&
          (!spanPairs.length ||
            spanPairs.some(
              ([trace, span]) =>
                candidate.trace_id === trace && candidate.span_id === span,
            )) &&
          (!timePairs.length ||
            timePairs.some(
              ([trace, time]) =>
                candidate.trace_id === trace &&
                String(candidate._timestamp) === time,
            )),
      );
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 500);
      const grouping = /GROUP BY (.+?)(?: HAVING (.+?))? ORDER BY/.exec(sql);
      if (grouping) {
        const keys = grouping[1]!.split(",").map((key) => key.trim());
        const groups = new Map<string, TelemetryRow>();
        for (const candidate of matched) {
          const id = keys.map((key) => String(candidate[key])).join("|");
          const first = groups.get(id);
          const time = Number(candidate._timestamp);
          if (!first || time < Number(first.first_time))
            groups.set(id, {
              ...Object.fromEntries(keys.map((key) => [key, candidate[key]])),
              first_time: time,
            });
        }
        return having([...groups.values()], grouping[2])
          .sort((a, b) => Number(a.first_time) - Number(b.first_time))
          .slice(0, limit);
      }
      return [...matched]
        .sort((a, b) => Number(a.start_time) - Number(b.start_time))
        .slice(0, limit);
    },
    async fields() {
      return new Set([
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
      ]);
    },
    async available() {
      return true;
    },
  };
  return { search, queries };
}

/** A query service over `search`. */
function reader(search: TelemetrySearch) {
  return new TelemetryQueryService(
    { enabled: true, retentionDays: 7 },
    { search, stream: "everything" },
    () => null,
    () => Date.parse("2026-10-23T12:00:00Z"),
    2_000,
  );
}

/** Microseconds at `minute` minutes past 11:00 on the fixed day. */
const at = (minute: number, offset = 0) =>
  (Date.parse("2026-10-23T11:00:00Z") + minute * 60_000) * 1000 + offset;

test("M1: other owners' traces of the same run never change what an owner's trace reports, even from a faulty backend", async () => {
  const own = traceOf("a1");
  const base = row("owner-a", own, spanOf("a1"), at(1), {
    everything_run_id: runId,
  });
  const foreign = Array.from({ length: 11 }, (_, index) =>
    row(
      "owner-b",
      traceOf(`b${index.toString(16)}`),
      spanOf("b1"),
      at(2 + index),
      {
        everything_run_id: runId,
      },
    ),
  );
  const { search, queries } = sqlBackend([base, ...foreign], true);
  const trace = await reader(search).trace("owner-a", own);
  assert.deepEqual(trace.relations, {
    related: [],
    unresolved: false,
    truncated: false,
  });
  assert.ok(
    !queries.some((sql) =>
      foreign.some((entry) => sql.includes(String(entry.trace_id))),
    ),
    "no query fans out to other owners' traces",
  );
});

test("M1: aggregates without an owner, or other owners' first, never crowd out an owned trace of the same run", async () => {
  const own = traceOf("a1");
  const owned = traceOf("a2");
  const rows = [
    row("owner-a", own, spanOf("a1"), at(1), { everything_run_id: runId }),
    ...Array.from({ length: 6 }, (_, index) =>
      row("owner-b", traceOf(`b${index}`), spanOf("b1"), at(2 + index), {
        everything_run_id: runId,
      }),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      row(undefined, traceOf(`c${index}`), spanOf("c1"), at(10 + index), {
        everything_run_id: runId,
      }),
    ),
    row("owner-a", owned, spanOf("a2"), at(20), { everything_run_id: runId }),
  ];
  const { search } = sqlBackend(rows, true);
  const trace = await reader(search).trace("owner-a", own);
  assert.deepEqual(
    trace.relations?.related.map((related) => [
      related.relation,
      related.span.traceId,
    ]),
    [["same_run", owned]],
  );
  assert.equal(trace.relations?.truncated, false);
});

test("M1: eleven rejected groups before an owned trace of the same run, as many as the query's bound, still don't crowd it out", async () => {
  const own = traceOf("a1");
  const owned = traceOf("a2");
  const rows = [
    row("owner-a", own, spanOf("a1"), at(1), { everything_run_id: runId }),
    // One more rejected group than the earlier case: as many as one run's query returns at most.
    ...Array.from({ length: 7 }, (_, index) =>
      row("owner-b", traceOf(`b${index}`), spanOf("b1"), at(2 + index), {
        everything_run_id: runId,
      }),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      row(undefined, traceOf(`c${index}`), spanOf("c1"), at(10 + index), {
        everything_run_id: runId,
      }),
    ),
    row("owner-a", owned, spanOf("a2"), at(20), { everything_run_id: runId }),
  ];
  const { search, queries } = sqlBackend(rows, true);
  const trace = await reader(search).trace("owner-a", own);
  assert.deepEqual(
    trace.relations?.related.map((related) => [
      related.relation,
      related.span.traceId,
    ]),
    [["same_run", owned]],
  );
  assert.equal(trace.relations?.truncated, false);
  assert.ok(
    !queries.some((sql) =>
      rows.slice(1, 12).some((entry) => sql.includes(String(entry.trace_id))),
    ),
    "no query fans out to a rejected group's trace",
  );
  // Without the rejected groups, the same trace reports the same thing.
  const alone = sqlBackend([rows[0]!, rows.at(-1)!], true);
  assert.deepEqual(
    (await reader(alone.search).trace("owner-a", own)).relations,
    trace.relations,
  );
});

test("M2: linked spans are found by their exact trace and span, however many other spans share their IDs", async () => {
  const own = traceOf("a1");
  const targets = [
    [traceOf("d1"), spanOf("51")],
    [traceOf("d2"), spanOf("52")],
    [traceOf("d3"), spanOf("53")],
  ] as const;
  const links = (target: readonly [string, string]) =>
    JSON.stringify([{ context: { traceId: target[0], spanId: target[1] } }]);
  const rows = [
    row("owner-a", own, spanOf("a1"), at(30), { links: links(targets[0]) }),
    row("owner-a", own, spanOf("a2"), at(30, 1), { links: links(targets[1]) }),
    row("owner-a", own, spanOf("a3"), at(30, 2), { links: links(targets[2]) }),
    // Older owned spans that reuse the targets' span IDs in other target traces.
    row("owner-a", targets[0][0], targets[1][1], at(1)),
    row("owner-a", targets[0][0], targets[2][1], at(2)),
    row("owner-a", targets[1][0], targets[0][1], at(3)),
    row("owner-a", targets[1][0], targets[2][1], at(4)),
    ...targets.map(([traceId, spanId], index) =>
      row("owner-a", traceId, spanId, at(10 + index)),
    ),
  ];
  const { search } = sqlBackend(rows);
  const trace = await reader(search).trace("owner-a", own);
  assert.deepEqual(
    trace.relations?.related
      .filter((related) => related.relation === "started_by")
      .map((related) => [related.span.traceId, related.span.spanId]),
    targets.map(([traceId, spanId]) => [traceId, spanId]),
  );
  assert.equal(trace.relations?.unresolved, false);
});

test("M2: a same-run trace's first span is found by its exact trace and time, however busy another trace is at that time", async () => {
  const own = traceOf("a1");
  const busy = traceOf("e1");
  const quiet = traceOf("e2");
  const rows = [
    row("owner-a", own, spanOf("a1"), at(1), { everything_run_id: runId }),
    row("owner-a", busy, spanOf("e0"), at(2), { everything_run_id: runId }),
    // The busy trace has many spans at the quiet trace's first time, starting just before it.
    ...Array.from({ length: 12 }, (_, index) =>
      row("owner-a", busy, spanOf(`e${(index + 1).toString(16)}`), at(3), {
        everything_run_id: runId,
        start_time: at(3) * 1000 - 100 + index,
      }),
    ),
    row("owner-a", quiet, spanOf("f1"), at(3), { everything_run_id: runId }),
  ];
  const { search } = sqlBackend(rows);
  const trace = await reader(search).trace("owner-a", own);
  assert.deepEqual(
    trace.relations?.related.map((related) => related.span.traceId).sort(),
    [busy, quiet].sort(),
  );
});

// ===========================================
// Exported links: canonical IDs only, at most eight, flags as a byte
// ===========================================

test("links keep only canonical, non-zero, lowercase IDs, at most eight, with flags as one byte and nothing else, at export and before any buffer", () => {
  const hex = (index: number, length: number) =>
    index
      .toString(16)
      .padStart(2, "0")
      .repeat(length / 2);
  const link = (traceId: string, spanId: string, traceFlags = 1): Link => ({
    context: {
      traceId,
      spanId,
      traceFlags,
      traceState: createTraceState("vendor=REVIEWFAKElinkstate1"),
    },
    attributes: { "link.note": "REVIEWFAKElinkattr2" },
  });
  const rejected = [
    link(hex(0xab, 32).toUpperCase(), hex(0xab, 16)),
    link(hex(0xcd, 32), hex(0xcd, 16).toUpperCase()),
    link("0".repeat(32), hex(3, 16)),
    link(hex(4, 32), "0".repeat(16)),
    link(hex(5, 30), hex(5, 16)),
    link(`${hex(6, 30)}zz`, hex(6, 16)),
  ];
  const kept = Array.from({ length: 10 }, (_, index) =>
    link(hex(16 + index, 32), hex(16 + index, 16), index === 0 ? 0x1ff : 1),
  );
  const span = new TracerProvider()
    .getTracer("review-links")
    .startSpan("teammate.turn", { root: true, links: [...rejected, ...kept] });
  span.end();
  const expected = kept.slice(0, 8).map((entry, index) => ({
    context: {
      traceId: entry.context.traceId,
      spanId: entry.context.spanId,
      traceFlags: index === 0 ? 0xff : 1,
    },
  }));
  const view = exportableSpan(span as unknown as ReadableSpan, recorded);
  assert.deepEqual(view.links, expected);
  let held: ReadableSpan | undefined;
  const next: SpanProcessor = {
    onStart() {},
    onEnd(safe) {
      held = safe;
    },
    async forceFlush() {},
    async shutdown() {},
  };
  new RedactingSpanProcessor(next, new ExportHealth(), recorded).onEnd(
    span as unknown as ReadableSpan,
  );
  assert.deepEqual(held?.links, expected);
  for (const links of [view.links, held!.links]) {
    const text = JSON.stringify(links);
    assert.ok(!text.includes("REVIEWFAKElink"), text);
  }
});

// ===========================================
// Records are made safe twice: before any buffer and at export
// ===========================================

test("making attributes safe again changes nothing, so a record made safe before its buffer exports the same", () => {
  const attributes = {
    [attribute.tool]: "sk-proj-REVIEWFAKEtwice1abcdefgh",
    [attribute.reason]: "context_window",
    [attribute.httpMethod]: "GET",
    [attribute.serverAddress]: "api.example.test",
    [attribute.urlFull]:
      "https://gateway.test/v1/sk-proj-REVIEWFAKEtwice2abcdef/x?api_key=REVIEWFAKEtwice3",
    [attribute.urlPath]:
      "/v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/messages",
    [attribute.httpStatus]: "502",
    [attribute.message]:
      "Lookup failed with password=REVIEWFAKEtwice4 for the visit",
    [attribute.messagePreview]: messagePreview(
      `Plan with api%5Fkey%3DREVIEWFAKEtwice5 ${"and more words ".repeat(300)}`,
    ).text,
    [attribute.toolArguments]: toolArgumentsPreview({
      "api%5Fkey": "REVIEWFAKEtwice6",
      env: { TOKEN: "REVIEWFAKEtwice7" },
      text: "x".repeat(2_000),
    }).text,
    [attribute.dbQueryText]: `SELECT 1 AS "password=""REVIEWFAKEtwice8""" FROM t WHERE a = 'b' AND id = $1`,
    [attribute.contentWithheld]: true,
    "error.type": "Error",
  };
  for (const policy of [
    recorded,
    { includeErrorText: false, includeContent: false },
  ]) {
    const once = exportableAttributes(attributes, policy);
    assert.deepEqual(exportableAttributes(once, policy), once);
    assert.ok(!JSON.stringify(once).includes("REVIEWFAKEtwice"));
  }
  assert.equal(
    exportableAttributes(attributes, recorded)[attribute.tool],
    "[redacted]",
  );
});
