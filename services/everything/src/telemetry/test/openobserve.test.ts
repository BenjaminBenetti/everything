import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import type { TelemetryRecordSummary } from "@everything/telemetry-contracts";
import { OpenObserveSearch } from "../adapter/openobserve-search.js";
import { loadTelemetrySettings } from "../config/telemetry-config.js";
import { startTelemetry } from "../factory/telemetry-runtime.js";
import { telemetryEvents } from "../model/telemetry-attributes.js";
import { recordWarning } from "../service/diagnostic-warnings.js";
import { TelemetryQueryService } from "../service/telemetry-query-service.js";
import { failure, settled, teammate } from "./runtime-fixtures.js";

/**
 * Everything's export pipeline, OpenObserve, and the owner-scoped query API end to end. Run by
 * deployment/script/test-telemetry.sh against a disposable OpenObserve container; skipped otherwise.
 *
 *   TELEMETRY_E2E_URL=http://127.0.0.1:… TELEMETRY_E2E_PASSWORD_FILE=/path [TELEMETRY_E2E_CONTAINER=name]
 */
const url = process.env.TELEMETRY_E2E_URL;
const passwordFile = process.env.TELEMETRY_E2E_PASSWORD_FILE;
const container = process.env.TELEMETRY_E2E_CONTAINER;
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
    const a = await teammate(
      context,
      () =>
        failure(
          429,
          {
            error: {
              message: "Rate limit reached for requests",
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

    const trace = await eventually(async () => {
      const found = await reader!.trace("owner-a", event.traceId!);
      return found.spans.length >= 3 ? found : undefined;
    }, "owner-a's trace");
    assert.deepEqual(
      new Set(trace.spans.map((span) => span.name)),
      new Set(["teammate.turn", "teammate.prompt", "provider.request"]),
    );
    assert.ok(
      trace.events.some((record) => record.name === telemetryEvents.turnFailed),
    );
    const turn = trace.spans.find((span) => span.name === "teammate.turn")!;
    const prompt = trace.spans.find((span) => span.name === "teammate.prompt")!;
    assert.equal(prompt.parentSpanId, turn.id);

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
