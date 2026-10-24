import assert from "node:assert/strict";
import { test } from "node:test";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
} from "../model/telemetry-attributes.js";
import {
  bindRequestOwner,
  failTelemetrySpan,
  recordTelemetryEvent,
  startTelemetrySpan,
  withTelemetryScope,
} from "../service/telemetry-recorder.js";
import { describeError } from "../service/telemetry-redactor.js";
import { exportedText, startInMemoryTelemetry } from "./telemetry-fixtures.js";

const telemetry = startInMemoryTelemetry();
const tracer = trace.getTracer("pipeline-test");

/** A server span for one request, with the given method. */
function request(method: string) {
  const span = tracer.startSpan(`${method} /v1/test`, {
    kind: SpanKind.SERVER,
    attributes: { [attribute.httpMethod]: method },
  });
  return { span, context: trace.setSpan(context.active(), span) };
}

test("a request's spans, including those started before authentication, belong to its verified owner", async () => {
  telemetry.reset();
  const root = request("POST");
  const lookup = tracer.startSpan(
    "session lookup",
    { kind: SpanKind.CLIENT },
    root.context,
  );
  context.with(root.context, () =>
    bindRequestOwner("owner-a", "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c"),
  );
  const query = tracer.startSpan(
    "query",
    { kind: SpanKind.CLIENT },
    root.context,
  );
  lookup.end();
  query.end();
  root.span.setAttribute(attribute.httpStatus, 201);
  root.span.end();
  const { spans } = await telemetry.collect();
  assert.equal(spans.length, 3);
  for (const span of spans) {
    assert.equal(span.attributes[attribute.ownerId], "owner-a", span.name);
    assert.equal(
      span.attributes[attribute.agentId],
      "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
    );
  }
  assert.equal(
    spans.find((span) => span.name === "query")?.attributes[attribute.type],
    "dependency",
  );
  assert.equal(
    spans.find((span) => span.name === "POST /v1/test")?.attributes[
      attribute.type
    ],
    "http",
  );
});

test("quick successful reads are dropped, while failed and slow reads keep every span", async () => {
  telemetry.reset();
  const quiet = request("GET");
  tracer.startSpan("quiet child", {}, quiet.context).end();
  quiet.span.setAttribute(attribute.httpStatus, 200);
  quiet.span.end();

  const failed = request("GET");
  tracer.startSpan("failed child", {}, failed.context).end();
  failed.span.setAttribute(attribute.httpStatus, 500);
  failed.span.setStatus({ code: SpanStatusCode.ERROR });
  failed.span.end();

  const slow = request("GET");
  slow.span.setAttribute(attribute.httpStatus, 200);
  slow.span.end(Date.now() + 3_000);

  const missing = request("GET");
  missing.span.setAttribute(attribute.httpStatus, 404);
  missing.span.end();

  const { spans } = await telemetry.collect();
  const names = spans.map((span) => span.name).sort();
  assert.deepEqual(names, [
    "GET /v1/test",
    "GET /v1/test",
    "GET /v1/test",
    "failed child",
  ]);
  assert.ok(!names.includes("quiet child"));
});

test("only allowlisted, redacted attributes and span events leave the process", async () => {
  telemetry.reset();
  const { span } = startTelemetrySpan("work", {
    kind: SpanKind.CLIENT,
    scope: { ownerId: "owner-a" },
    attributes: {
      "db.statement":
        "SELECT secret_column FROM accounts WHERE token = 'sql-secret'",
      "db.query.text": "SELECT secret_column",
      "db.operation.name": "SELECT",
      "url.full": "https://api.test/v1/models?api_key=url-secret",
      "http.url":
        "https://gateway.test/v1/sk-proj-pathsecretabcdefghijkl/messages?debug=1",
      "url.path": "/v1/sk%2Dproj%2Dencodedsecretabcdefghij/messages",
      "http.target": "/v1/sk%252Dproj%252Dtwiceencodedsecretabc/messages?x=1",
      "http.request.header.authorization": "Bearer header-secret",
      "user_agent.original": "agent-secret",
      "client.address": "203.0.113.9",
      [attribute.message]: "failed with password=attr-secret",
    },
  });
  span.addEvent("exception", {
    "exception.type": "Error",
    "exception.message": "outer ← inner api_key=event-secret",
    "exception.stacktrace": "Error: stack-secret\n    at x",
  });
  span.addEvent("debug.payload", { body: "payload-secret" });
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: "token=status-secret",
  });
  span.end();
  const exported = await telemetry.collect();
  const text = exportedText(exported);
  for (const secret of [
    "sql-secret",
    "secret_column",
    "url-secret",
    "header-secret",
    "agent-secret",
    "203.0.113.9",
    "attr-secret",
    "event-secret",
    "stack-secret",
    "payload-secret",
    "status-secret",
    "pathsecretabcdefghijkl",
    "encodedsecretabcdefghij",
    "twiceencodedsecretabc",
  ])
    assert.ok(!text.includes(secret), `${secret} leaked`);
  const [work] = exported.spans;
  assert.equal(work?.attributes["db.operation.name"], "SELECT");
  assert.equal(work?.attributes["url.full"], "https://api.test/v1/models");
  assert.equal(
    work?.attributes["http.url"],
    "https://gateway.test/v1/[redacted]/messages",
  );
  assert.equal(work?.attributes["url.path"], "/v1/[redacted]/messages");
  assert.equal(work?.attributes["http.target"], "/v1/[redacted]/messages");
  assert.deepEqual(
    work?.events.map((event) => event.name),
    ["exception"],
  );
});

test("events carry their scope and trace, with nested error causes redacted", async () => {
  telemetry.reset();
  const { span, context: spanContext } = startTelemetrySpan("turn", {
    scope: { ownerId: "owner-a", agentId: "agent-1", runId: "run-1" },
  });
  const error = new Error("turn failed", {
    cause: new Error("provider said Authorization: Bearer nested-secret-token"),
  });
  context.with(
    withTelemetryScope(
      { ownerId: "owner-a", sessionId: "session-1" },
      spanContext,
    ),
    () =>
      recordTelemetryEvent({
        name: telemetryEvents.turnFailed,
        title: "Teammate turn failed",
        type: "turn",
        severity: "error",
        outcome: "failure",
        code: "TURN_FAILED",
        error: describeError(error),
        attributes: { [attribute.reason]: "cookie=reason-secret" },
      }),
  );
  span.end();
  const exported = await telemetry.collect();
  const [event] = exported.events;
  assert.ok(event);
  assert.equal(event.spanContext?.traceId, span.spanContext().traceId);
  assert.equal(event.attributes[attribute.ownerId], "owner-a");
  assert.equal(event.attributes[attribute.agentId], "agent-1");
  assert.equal(event.attributes[attribute.runId], "run-1");
  assert.equal(event.attributes[attribute.sessionId], "session-1");
  assert.equal(event.attributes[attribute.code], "TURN_FAILED");
  assert.equal(event.attributes[attribute.errorType], "Error");
  assert.match(String(event.attributes[attribute.stack]), /^at /);
  assert.equal(
    event.attributes[attribute.message],
    undefined,
    "error text is withheld, as this process is set to",
  );
  assert.equal(event.attributes[attribute.textWithheld], true);
  assert.equal(event.attributes[attribute.eventId]?.toString().length, 36);
  const text = exportedText(exported);
  assert.ok(!text.includes("nested-secret-token"));
  assert.ok(!text.includes("provider said"));
  assert.ok(!text.includes("reason-secret"));
});

test("a different owner's scope replaces the enclosing one instead of merging with it", () => {
  const inner = withTelemetryScope(
    { ownerId: "owner-b" },
    withTelemetryScope({ ownerId: "owner-a", agentId: "agent-a" }),
  );
  context.with(inner, () =>
    recordTelemetryEvent({
      name: telemetryEvents.warning,
      title: "Warning",
      type: "log",
      severity: "warning",
    }),
  );
  return telemetry.collect().then(({ events }) => {
    const last = events.at(-1);
    assert.equal(last?.attributes[attribute.ownerId], "owner-b");
    assert.equal(last?.attributes[attribute.agentId], undefined);
  });
});

test("a quick, successful read is kept when a span inside it failed", async () => {
  telemetry.reset();
  const read = request("GET");
  const query = tracer.startSpan(
    "query",
    { kind: SpanKind.CLIENT },
    read.context,
  );
  query.setStatus({ code: SpanStatusCode.ERROR, message: "relation missing" });
  query.end();
  read.span.setAttribute(attribute.httpStatus, 200);
  read.span.end();
  const { spans } = await telemetry.collect();
  assert.deepEqual(spans.map((span) => span.name).sort(), [
    "GET /v1/test",
    "query",
  ]);
});

test("an error whose message mentions aborting is still an error", async () => {
  telemetry.reset();
  const read = request("POST");
  const query = tracer.startSpan(
    "pg.query:UPDATE everything",
    { kind: SpanKind.CLIENT },
    read.context,
  );
  query.setAttribute("db.system.name", "postgresql");
  query.setAttribute("error.type", "25P02");
  query.recordException(
    Object.assign(
      new Error(
        "current transaction is aborted, commands ignored until end of transaction block",
      ),
      { code: "25P02" },
    ),
  );
  query.setStatus({
    code: SpanStatusCode.ERROR,
    message:
      "current transaction is aborted, commands ignored until end of transaction block",
  });
  query.end();
  read.span.end();
  const { spans } = await telemetry.collect();
  const exported = spans.find((span) => span.name.startsWith("pg.query"));
  assert.equal(exported?.attributes[attribute.outcome], "failure");
  assert.equal(exported?.attributes[attribute.severity], "error");
});

test("a cancellation recorded as such, or failing with an AbortError, is not an error", async () => {
  telemetry.reset();
  const stopped = startTelemetrySpan("provider", {
    scope: { ownerId: "owner-a" },
  });
  failTelemetrySpan(stopped.span, undefined, "cancelled");
  stopped.span.end();
  const aborted = tracer.startSpan("request", { kind: SpanKind.CLIENT });
  aborted.recordException(
    Object.assign(new Error("The user stopped the reply"), {
      name: "AbortError",
    }),
  );
  aborted.setStatus({ code: SpanStatusCode.ERROR, message: "Stopped" });
  aborted.end();
  const { spans } = await telemetry.collect();
  for (const name of ["provider", "request"]) {
    const span = spans.find((exported) => exported.name === name);
    assert.equal(span?.attributes[attribute.outcome], "cancelled", name);
    assert.equal(span?.attributes[attribute.severity], "info", name);
  }
});

test("an aborted request is a cancellation, not an error", async () => {
  telemetry.reset();
  const span = tracer.startSpan("POST", { kind: SpanKind.CLIENT });
  span.setAttribute("error.type", "AbortError");
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: "This operation was aborted",
  });
  span.end();
  const [exported] = (await telemetry.collect()).spans;
  assert.equal(exported?.attributes[attribute.outcome], "cancelled");
  assert.equal(exported?.attributes[attribute.severity], "info");
});

test("a new trace's scope replaces the enclosing work's details instead of inheriting them", async () => {
  telemetry.reset();
  const turn = startTelemetrySpan("turn", {
    root: true,
    scope: {
      ownerId: "owner-a",
      agentId: "agent-1",
      runId: "run-1",
      sessionId: "main",
    },
  });
  const fork = startTelemetrySpan(
    "fork prompt",
    {
      root: true,
      scope: { ownerId: "owner-a", agentId: "agent-1", sessionId: "fork-1" },
    },
    turn.context,
  );
  const child = startTelemetrySpan(
    "provider",
    { scope: { ownerId: "owner-a", model: "m" } },
    fork.context,
  );
  child.span.end();
  fork.span.end();
  turn.span.end();
  const { spans } = await telemetry.collect();
  const forkSpan = spans.find((span) => span.name === "fork prompt")!;
  const childSpan = spans.find((span) => span.name === "provider")!;
  assert.equal(forkSpan.attributes[attribute.runId], undefined);
  assert.equal(forkSpan.attributes[attribute.sessionId], "fork-1");
  assert.equal(
    forkSpan.spanContext().traceId === turn.span.spanContext().traceId,
    false,
  );
  assert.equal(
    childSpan.attributes[attribute.sessionId],
    "fork-1",
    "children still inherit their trace's scope",
  );
  assert.equal(childSpan.attributes[attribute.model], "m");
});

test("spans that ended before authentication receive the request's owner when exported", async () => {
  telemetry.reset();
  const root = request("POST");
  const lookup = tracer.startSpan(
    "session lookup",
    { kind: SpanKind.CLIENT },
    root.context,
  );
  lookup.end();
  context.with(root.context, () => bindRequestOwner("owner-a"));
  root.span.setAttribute(attribute.httpStatus, 202);
  root.span.end();
  const { spans } = await telemetry.collect();
  assert.equal(
    spans.find((span) => span.name === "session lookup")?.attributes[
      attribute.ownerId
    ],
    "owner-a",
  );
});
