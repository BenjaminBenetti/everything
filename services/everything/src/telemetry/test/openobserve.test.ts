import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  context as otel,
  SpanKind,
  type SpanContext,
} from "@opentelemetry/api";
import type {
  TelemetryRecordSummary,
  TelemetrySpan,
} from "@everything/telemetry-contracts";
import { OpenObserveSearch } from "../adapter/openobserve-search.js";
import { loadTelemetrySettings } from "../config/telemetry-config.js";
import { startTelemetry } from "../factory/telemetry-runtime.js";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
} from "../model/telemetry-attributes.js";
import { sendMessageToolName } from "../../runtime/model/message-delivery.js";
import { recordWarning } from "../service/diagnostic-warnings.js";
import { TelemetryQueryBuilder } from "../service/telemetry-query-builder.js";
import { startTelemetrySpan } from "../service/telemetry-recorder.js";
import { TelemetryQueryService } from "../service/telemetry-query-service.js";
import { failure, reply, settled, teammate } from "./runtime-fixtures.js";

/**
 * Everything's export pipeline, OpenObserve, and the owner-scoped query API end to end. Run by
 * deployment/script/test-telemetry.sh against a disposable OpenObserve container; skipped otherwise.
 * Error text and content are recorded, as by default, unless TELEMETRY_E2E_INCLUDE_ERROR_TEXT is
 * `false`, as for an installation that set `telemetry.includeErrorText: false`, which withholds
 * content too.
 *
 *   TELEMETRY_E2E_URL=http://127.0.0.1:… TELEMETRY_E2E_PASSWORD_FILE=/path [TELEMETRY_E2E_CONTAINER=name]
 */
const url = process.env.TELEMETRY_E2E_URL;
const passwordFile = process.env.TELEMETRY_E2E_PASSWORD_FILE;
const container = process.env.TELEMETRY_E2E_CONTAINER;
const withheld = process.env.TELEMETRY_E2E_INCLUDE_ERROR_TEXT === "false";
const includeErrorText = !withheld;
const includeContent = !withheld;

/** Natural-language text a provider's error quotes from the request; no credential shape. */
const privateText = "The private launch date is next Tuesday";

/** A tool name a model made up in the shape of a key, which never reaches storage in either mode. */
const toolKey = "sk-proj-storedtoolnameabcdefgh";
const skip =
  url && passwordFile
    ? false
    : "set TELEMETRY_E2E_URL and TELEMETRY_E2E_PASSWORD_FILE, as deployment/script/test-telemetry.sh does, to run against OpenObserve";

/** Each run writes to its own stream, so runs against one server never see each other. */
const stream = `e2e_${Date.now()}`;
const settings = skip
  ? undefined
  : loadTelemetrySettings({
      TELEMETRY_URL: url,
      TELEMETRY_PASSWORD_FILE: passwordFile,
      TELEMETRY_USERNAME:
        process.env.TELEMETRY_E2E_USERNAME ?? "everything@telemetry.local",
      TELEMETRY_STREAM: stream,
      TELEMETRY_RETENTION_DAYS: process.env.TELEMETRY_E2E_RETENTION_DAYS ?? "7",
      // Unset, the installation's defaults apply.
      ...(withheld ? { TELEMETRY_INCLUDE_ERROR_TEXT: "false" } : {}),
    });
const runtime = settings
  ? startTelemetry(settings, { instrument: false, batchDelayMs: 200 })
  : undefined;
const search = settings?.backend
  ? new OpenObserveSearch(settings.backend)
  : undefined;
const reader = settings
  ? new TelemetryQueryService(
      settings,
      search ? { search, stream } : null,
      () => runtime?.health() ?? null,
    )
  : undefined;

/** Poll until `find` returns a value or the deadline passes. */
async function eventually<T>(
  find: () => Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = await find().catch(() => undefined);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The owner's model failure, once OpenObserve has made it searchable. */
function modelFailure(ownerId: string): Promise<TelemetryRecordSummary> {
  return eventually(async () => {
    const page = await reader!.events(ownerId, {
      severity: "error",
      type: "model",
    });
    return page.records.find(
      (record) => record.name === telemetryEvents.modelFailed,
    );
  }, `${ownerId}'s model failure`);
}

test(
  "model failures exported by Everything are searchable through the owner-scoped API, with their trace",
  { skip },
  async (context) => {
    // Owner A's model first calls a tool that doesn't exist, named like a key, then is rate limited.
    const a = await teammate(
      context,
      ({ attempt }) =>
        attempt === 1
          ? reply("", { name: toolKey, input: {} })
          : failure(
              429,
              {
                error: {
                  message: `Rate limit reached for requests while reading: ${privateText}`,
                  type: "rate_limit_exceeded",
                },
              },
              { "x-request-id": "req_e2e_owner_a", "retry-after": "20" },
            ),
      "owner-a",
    );
    const b = await teammate(
      context,
      () =>
        failure(500, {
          error: { message: "owner-b private failure", type: "server_error" },
        }),
      "owner-b",
    );
    a.runtime.start("Hello");
    b.runtime.start("Hello");
    await Promise.all([settled(a.runtime), settled(b.runtime)]);
    await runtime!.flush();

    const event = await modelFailure("owner-a");
    assert.equal(event.category, "rate_limit");
    assert.equal(event.httpStatus, 429);
    assert.equal(event.provider, "openai-compatible");
    assert.ok(event.traceId);
    const detail = await reader!.event("owner-a", event.id);
    assert.equal(detail.requestId, "req_e2e_owner_a");
    assert.equal(detail.retryable, true);
    assert.ok(detail.runId);
    assert.ok(
      detail.details.some(
        (fact) => fact.label === "Retry after" && fact.value === "20",
      ),
    );
    assert.equal(
      (await reader!.status()).errorText,
      includeErrorText ? "included" : "withheld",
    );
    if (includeErrorText) {
      assert.equal(
        detail.message,
        `Rate limit reached for requests while reading: ${privateText}`,
        "recorded error text can quote the request, as the setting warns",
      );
      assert.equal(detail.textWithheld, false);
    } else {
      assert.equal(detail.message, null);
      assert.equal(detail.textWithheld, true);
    }

    const trace = await eventually(async () => {
      const found = await reader!.trace("owner-a", event.traceId!);
      return found.spans.length >= 5 ? found : undefined;
    }, "owner-a's trace");
    assert.deepEqual(
      new Set(trace.spans.map((span) => span.name)),
      new Set([
        "teammate.turn",
        "teammate.prompt",
        "provider.request",
        "teammate.tool",
      ]),
    );
    assert.equal(
      trace.spans.find((span) => span.name === "teammate.tool")!.title,
      "Tool: [redacted]",
    );
    assert.ok(
      trace.events.some((record) => record.name === telemetryEvents.turnFailed),
    );
    const turn = trace.spans.find((span) => span.name === "teammate.turn")!;
    const prompt = trace.spans.find((span) => span.name === "teammate.prompt")!;
    assert.equal(prompt.parentSpanId, turn.id);
    const request = trace.spans.find(
      (span) => span.name === "provider.request" && span.httpStatus === 429,
    )!;
    assert.equal(request.statusMessage, "HTTP 429");
    assert.equal(request.textWithheld, !includeErrorText);

    // What storage holds, read directly rather than through the API's presentation.
    const window = {
      start: (Date.now() - 3_600_000) * 1000,
      end: (Date.now() + 60_000) * 1000,
    };
    const stored = JSON.stringify(
      await Promise.all(
        (["logs", "traces"] as const).map((type) =>
          search!.search(type, `SELECT * FROM "${stream}"`, window, 500),
        ),
      ),
    );
    assert.equal(
      stored.includes(privateText),
      includeErrorText,
      includeErrorText
        ? "recorded error text is stored"
        : "withheld error text never reaches storage",
    );
    assert.ok(!stored.includes(toolKey), "a key-shaped name never does");

    const byRun = await reader!.events("owner-a", {
      severity: "info",
      correlationId: detail.runId!,
    });
    assert.ok(
      byRun.records.some((record) => record.id === event.id),
      "the run ID finds the failure",
    );

    // Owner B's failure exists, but nothing of it is visible to owner A, by list, ID, or trace.
    const other = await modelFailure("owner-b");
    const listed = await reader!.events("owner-a", { severity: "info" });
    assert.ok(listed.records.every((record) => record.id !== other.id));
    await assert.rejects(reader!.event("owner-a", other.id), {
      code: "TELEMETRY_NOT_FOUND",
    });
    await assert.rejects(reader!.trace("owner-a", other.traceId!), {
      code: "TELEMETRY_NOT_FOUND",
    });
    const searched = await reader!.events("owner-a", {
      severity: "info",
      search: "x' OR everything_owner_id = 'owner-b",
    });
    assert.equal(
      searched.records.length,
      0,
      "a quote in a filter stays inside its literal",
    );
    await assert.rejects(
      reader!.events("owner-a", { search: "\\' OR 1=1 --" }),
      /backslashes/,
    );
  },
);

test(
  "content previews, SQL shapes, and links are stored redacted, and related traces resolve through the owner-scoped API",
  { skip },
  async (context) => {
    const owner = "owner-content";
    const canary = "sk-proj-e2econtentcanaryabcdefgh";
    const { runtime: turnRuntime, definition } = await teammate(
      context,
      ({ attempt }) =>
        attempt === 1
          ? reply("", {
              name: sendMessageToolName,
              input: {
                text: `Here is the plan; the key ${canary} stays private.`,
              },
            })
          : reply("Done."),
      owner,
    );
    // A deliberately fake key, percent-encoded in a URL path, as review found encoding could hide.
    const encodedCanary = "sk%2Dproj%2DREVIEWFAKEstore0009abcdef";
    const message = `Plan the launch: ${privateText}. The password=hunter2 and ${canary} are in the vault. See https://gateway.test/v1/${encodedCanary}/x. Then token="[redacted]REVIEWFAKEstore12" is used.`;
    // The request that sends the message, with a database query, as Everything's API records it.
    const request = startTelemetrySpan("POST /v1/agents/:agentId/messages", {
      kind: SpanKind.SERVER,
      scope: { ownerId: owner, agentId: definition.id },
      attributes: {
        [attribute.httpMethod]: "POST",
        [attribute.httpRoute]: "/v1/agents/:agentId/messages",
      },
    });
    otel.with(request.context, () => {
      const query = startTelemetrySpan("pg.query:SELECT everything", {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system.name": "postgresql",
          [attribute.dbQueryText]:
            "SELECT * FROM accounts WHERE token = 'sql-literal-secret' AND id = $1",
          // An error type a library recorded, beginning with the redaction marker; not content.
          "error.type": "password:[redacted]REVIEWFAKEstore13",
        },
      });
      query.span.end();
      // Valid PostgreSQL the shaper must still reduce: a non-ASCII dollar tag around ordinary
      // private words, and a short fake credential assignment in a quoted identifier.
      for (const statement of [
        "SELECT $ü$the visit note mentions morning appointments$ü$ AS note FROM visits",
        'SELECT 1 AS "password=REVIEWFAKEstore8" FROM visits',
        // The same kind of fake credential, quoted inside the identifier with SQL's doubled quotes.
        'SELECT 2 AS "secret=""REVIEWFAKEstore10""" FROM visits',
        // The same, its value beginning with the redaction marker.
        'SELECT 3 AS "token=""[redacted]REVIEWFAKEstore11""" FROM visits',
      ])
        startTelemetrySpan("pg.query:SELECT everything", {
          kind: SpanKind.CLIENT,
          attributes: {
            "db.system.name": "postgresql",
            [attribute.dbQueryText]: statement,
          },
        }).span.end();
      turnRuntime.start(message);
    });
    request.span.end();
    await settled(turnRuntime);
    await runtime!.flush();

    const spans = await eventually(async () => {
      const page = await reader!.spans(owner, { severity: "info", limit: 100 });
      return page.records.some((span) => span.name === "teammate.turn") &&
        page.records.some((span) => span.name === "teammate.tool")
        ? (page.records as TelemetrySpan[])
        : undefined;
    }, "the content spans");
    const turn = spans.find((span) => span.name === "teammate.turn")!;
    const tool = spans.find((span) => span.name === "teammate.tool")!;
    const queries = spans.filter((span) => span.name.startsWith("pg.query"));
    // What storage holds, read directly rather than through the API's presentation, before
    // anything is asserted, with the stored columns that hold each marker canary named.
    const window = {
      start: (Date.now() - 3_600_000) * 1000,
      end: (Date.now() + 60_000) * 1000,
    };
    const rows = await search!.search(
      "traces",
      `SELECT * FROM "${stream}" WHERE everything_owner_id = '${owner}'`,
      window,
      500,
    );
    const holding = new Set<string>();
    for (const row of rows)
      for (const [column, value] of Object.entries(row))
        for (const canary of [
          "REVIEWFAKEstore11",
          "REVIEWFAKEstore12",
          "REVIEWFAKEstore13",
        ])
          if (String(value).includes(canary))
            holding.add(`${column} [${canary}]`);
    context.diagnostic(
      `stored columns holding a marker canary: ${[...holding].sort().join(", ") || "none"}`,
    );
    // OpenObserve's own normalized copy of each statement, read by its column name.
    const normalized = rows
      .map((row) => row.o2_db_query_norm)
      .filter(
        (value): value is string => typeof value === "string" && value !== "",
      );
    context.diagnostic(
      `o2_db_query_norm values returned: ${normalized.length}`,
    );
    if (includeContent)
      assert.ok(
        normalized.some((value) => value.includes('"token=[redacted]"')),
        "the named normalized copy holds the safe shape",
      );
    else assert.deepEqual(normalized, [], "no normalized copy without content");
    assert.equal(queries.length, 5, "each statement's span is stored");
    const requestSpan = spans.find((span) => span.kind === "server")!;
    assert.equal(
      (await reader!.status()).content,
      withheld ? "withheld" : "included",
    );
    if (includeContent) {
      assert.deepEqual(turn.previews, [
        {
          kind: "message",
          format: "text",
          value: `Plan the launch: ${privateText}. The password=[redacted] and [redacted] are in the vault. See https://gateway.test/v1/[redacted]/x. Then token=[redacted] is used.`,
          truncated: false,
          originalLength: message.length,
        },
      ]);
      assert.deepEqual(JSON.parse(tool.previews[0]!.value), {
        text: "Here is the plan; the key [redacted] stays private.",
      });
      assert.deepEqual(
        queries.map((span) => span.previews[0]?.value).sort(),
        [
          "SELECT * FROM accounts WHERE token = ? AND id = $1",
          "SELECT ? AS note FROM visits",
          'SELECT ? AS "password=[redacted]" FROM visits',
          'SELECT ? AS "secret=[redacted]" FROM visits',
          'SELECT ? AS "token=[redacted]" FROM visits',
        ].sort(),
      );
    } else
      for (const span of [turn, tool, ...queries]) {
        assert.deepEqual(span.previews, [], span.name);
        assert.equal(span.contentWithheld, true, span.name);
      }

    // Every stored column, read above, as one text for the checks that follow.
    const stored = JSON.stringify(rows);
    for (const secret of [
      canary,
      "hunter2",
      "sql-literal-secret",
      "REVIEWFAKEstore0009",
      "morning appointments",
      "REVIEWFAKEstore8",
      "REVIEWFAKEstore10",
      "REVIEWFAKEstore11",
      "REVIEWFAKEstore12",
      "REVIEWFAKEstore13",
    ])
      assert.ok(!stored.includes(secret), `${secret} never reaches storage`);
    for (const shape of [
      "SELECT ? AS note FROM visits",
      'SELECT ? AS \\"password=[redacted]\\" FROM visits',
      'SELECT ? AS \\"secret=[redacted]\\" FROM visits',
      'SELECT ? AS \\"token=[redacted]\\" FROM visits',
    ])
      assert.equal(
        stored.includes(shape),
        includeContent,
        `${shape}: the shape, and OpenObserve's copy, only with content`,
      );
    assert.equal(
      stored.includes("Plan the launch"),
      includeContent,
      includeContent
        ? "the message is stored, redacted"
        : "withheld content never reaches storage",
    );
    // OpenObserve derives its own normalized copy of each statement it receives.
    assert.equal(
      stored.includes("FROM accounts WHERE token"),
      includeContent,
      includeContent
        ? "the statement's shape is stored, and OpenObserve's copy of it"
        : "a withheld statement reaches storage in no column, including OpenObserve's copy",
    );

    // The turn's own trace links back to the request, and the request finds the turn it started.
    const fromTurn = await eventually(async () => {
      const trace = await reader!.trace(owner, turn.traceId!);
      return trace.relations?.related.length ? trace : undefined;
    }, "the turn's relations");
    assert.deepEqual(
      fromTurn.relations!.related.map((related) => [
        related.relation,
        related.span.spanId,
      ]),
      [["started_by", requestSpan.spanId]],
    );
    assert.ok(
      fromTurn.spans.every((span) => span.traceId === turn.traceId),
      "the traces stay separate",
    );
    const fromRequest = await reader!.trace(owner, requestSpan.traceId!);
    assert.deepEqual(
      fromRequest.relations!.related.map((related) => [
        related.relation,
        related.span.spanId,
      ]),
      [["started", turn.spanId]],
    );
    await assert.rejects(reader!.trace("owner-a", turn.traceId!), {
      code: "TELEMETRY_NOT_FOUND",
    });

    // A trace that only shares the turn's run is found by the run alone, through the grouped
    // lookup and the exact trace-and-time lookup after it; another owner's, in the same run, isn't.
    const runId = turn.details.find((fact) => fact.label === "Run ID")?.value;
    assert.ok(runId, "the turn recorded its run");
    const sameRun = (ownerId: string) => {
      const started = startTelemetrySpan("GET /v1/agents/:agentId", {
        kind: SpanKind.SERVER,
        root: true,
        scope: { ownerId, agentId: definition.id, runId },
      });
      started.span.end();
      return started.span.spanContext();
    };
    const sibling = sameRun(owner);
    const foreign = sameRun("owner-a");
    await runtime!.flush();
    const withSibling = await eventually(async () => {
      const trace = await reader!.trace(owner, turn.traceId!);
      return trace.relations?.related.some(
        (related) => related.relation === "same_run",
      )
        ? trace
        : undefined;
    }, "the same run's other trace");
    assert.deepEqual(
      withSibling.relations!.related.map((related) => [
        related.relation,
        related.span.traceId,
        related.span.spanId,
      ]),
      [
        ["started_by", requestSpan.traceId, requestSpan.spanId],
        ["same_run", sibling.traceId, sibling.spanId],
      ],
      "the linked request is listed once, and the other owner's trace not at all",
    );
    assert.ok(foreign.traceId !== sibling.traceId);
    assert.equal(withSibling.relations!.truncated, false);

    // A span list can wait for spans to age; these are seconds old.
    const delayed = await reader!.spans(owner, {
      severity: "info",
      minAge: 3_600,
    });
    assert.ok(delayed.records.every((span) => span.id !== turn.id));
    assert.ok(Date.parse(delayed.to) <= Date.now() - 3_599_000);
    const live = await reader!.spans(owner, { severity: "info", minAge: 0 });
    assert.ok(live.records.some((span) => span.id === turn.id));
  },
);

test(
  "same-run groups are proven the owner's before the query's bound, so other owners' traces of the run can't crowd out the owner's, even without the owner in the row filter",
  { skip },
  async () => {
    const owner = "owner-run";
    const runId = randomUUID();
    // Each root starts a few milliseconds after the last, so their first times order them.
    const root = async (ownerId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const started = startTelemetrySpan("GET /v1/agents/:agentId", {
        kind: SpanKind.SERVER,
        root: true,
        scope: { ownerId, runId },
      });
      started.span.end();
      return started.span.spanContext();
    };
    const inspected = await root(owner);
    // As many other owners' traces of the run, recorded first, as one run's query returns at most.
    const others: SpanContext[] = [];
    for (let index = 0; index < 11; index++)
      others.push(await root("owner-other"));
    const sibling = await root(owner);
    await runtime!.flush();

    const trace = await eventually(async () => {
      const found = await reader!.trace(owner, inspected.traceId);
      return found.relations?.related.length ? found : undefined;
    }, "the run's other trace");
    assert.deepEqual(
      trace.relations!.related.map((related) => [
        related.relation,
        related.span.traceId,
      ]),
      [["same_run", sibling.traceId]],
    );
    assert.equal(trace.relations!.truncated, false);

    // The grouped query as the builder writes it, with the row filter's owner condition removed,
    // as a faulty backend or a mis-composed condition would leave it: real OpenObserve still
    // returns only the owner's groups, within the same bound.
    const window = {
      start: (Date.now() - 3_600_000) * 1000,
      end: (Date.now() + 60_000) * 1000,
    };
    const sql = new TelemetryQueryBuilder(stream).runTraces(
      owner,
      [runId],
      inspected.traceId,
      await search!.fields("traces"),
      10,
    )!;
    const unfiltered = sql.replace(
      `WHERE everything_owner_id = '${owner}' AND `,
      "WHERE ",
    );
    assert.notEqual(
      unfiltered,
      sql,
      "the row filter's owner condition is gone",
    );
    const unproven = unfiltered.replace(/ HAVING .*? ORDER BY /, " ORDER BY ");
    const everyGroup = await eventually(async () => {
      const found = await search!.search("traces", unproven, window, 500);
      return others.every((other) =>
        found.some((group) => group.trace_id === other.traceId),
      )
        ? found
        : undefined;
    }, "the other owners' groups, without either owner condition");
    assert.ok(
      everyGroup.every((group) => group.trace_id !== sibling.traceId),
      "without either owner condition, the other owners' groups fill the bound",
    );
    const groups = await search!.search("traces", unfiltered, window, 500);
    assert.deepEqual(
      groups.map((group) => [group.trace_id, group.everything_owner_id]),
      [[sibling.traceId, owner]],
    );
  },
);

test(
  "OpenObserve's SQL treats a backslash as an escape, which is why the query builder refuses it",
  { skip },
  async () => {
    await modelFailure("owner-b");
    const end = Date.now() * 1000;
    const rows = await search!.search(
      "logs",
      `SELECT * FROM "${stream}" WHERE everything_owner_id = 'nobody\\'' OR 1=1 --'`,
      { start: end - 3_600_000_000, end },
      10,
    );
    assert.ok(
      rows.length > 0,
      "the raw backend returns rows for this escape, so it must never reach it",
    );
  },
);

test(
  "pages of real records are complete and never repeat",
  { skip },
  async () => {
    for (let index = 0; index < 5; index++)
      recordWarning(`Page check ${index}`, { reason: "e2e" });
    await runtime!.flush();
    // Warnings carry no owner, so they belong to nobody's pages; owner A's pages are checked instead.
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await reader!.events("owner-a", {
        severity: "info",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      for (const record of page.records) {
        assert.ok(!seen.has(record.id), "no record repeats across pages");
        seen.add(record.id);
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    assert.ok(
      seen.size >= 2,
      "owner A's model and turn failures are paged one at a time",
    );
    const unowned = await reader!.events("owner-a", {
      severity: "info",
      search: "Page check",
    });
    assert.equal(
      unowned.records.length,
      0,
      "unowned installation warnings are in no owner's view",
    );
  },
);

test(
  "records survive an OpenObserve restart, and the effective retention is the configured one",
  { skip },
  async (context) => {
    const before = await modelFailure("owner-a");
    if (!container) {
      context.skip("set TELEMETRY_E2E_CONTAINER to restart OpenObserve");
      return;
    }
    await promisify(execFile)("docker", ["restart", container]);
    await eventually(
      async () => ((await search!.available()) ? true : undefined),
      "OpenObserve to restart",
    );
    const after = await modelFailure("owner-a");
    assert.equal(after.id, before.id);
    const response = await fetch(`${url}/api/_meta/config`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${settings!.backend!.username}:${settings!.backend!.password}`).toString("base64")}`,
      },
    });
    const config = (await response.json()) as {
      data_retention_days: number;
      telemetry_enabled: boolean;
    };
    assert.equal(config.data_retention_days, settings!.retentionDays);
    assert.equal(config.telemetry_enabled, false);
    assert.equal((await reader!.status()).state, "available");
  },
);
