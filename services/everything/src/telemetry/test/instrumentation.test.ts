import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import { startOtlpReceiver, type ReceivedSpan } from "./otlp-receiver.js";

/** The service directory, from which the child process resolves its modules. */
const serviceDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** OTLP span kinds. */
const kinds = { server: 2, client: 3 } as const;

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** An HTTP dependency the app calls with `fetch`. */
async function dependency(context: TestContext): Promise<string> {
  const server: Server = createServer((_request, response) =>
    response.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Start the instrumented app in its own process with the instrumentation preload, as the container
 * does, and return its address and a way to stop it, which reports its export health.
 */
async function instrumentedApp(
  context: TestContext,
  environment: Record<string, string>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "everything-telemetry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const passwordFile = path.join(directory, "password");
  await writeFile(passwordFile, "Ot1-test-password\n", { mode: 0o600 });
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./src/telemetry/bootstrap/instrumentation.ts",
      "./src/telemetry/test/instrumented-app.ts",
    ],
    {
      cwd: serviceDirectory,
      env: {
        PATH: process.env.PATH ?? "",
        TELEMETRY_PASSWORD_FILE: passwordFile,
        TELEMETRY_USERNAME: "everything@telemetry.local",
        TELEMETRY_READ_SAMPLE_RATIO: "0",
        TELEMETRY_TIMEOUT_MS: "1000",
        CLOSED_PORT: String(await closedPort()),
        ...environment,
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`App did not start:\n${output}`)),
      30_000,
    );
    const poll = setInterval(() => {
      const match = /ready (\d+)/.exec(output);
      if (match) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(Number(match[1]));
      }
    }, 20);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    /** Stop the process gracefully and return its final export health and output. */
    async stop() {
      child.kill("SIGTERM");
      const code = await exited;
      const health = /health (.*)/.exec(output)?.[1];
      return { code, output, health: health ? JSON.parse(health) : undefined };
    },
  };
}

/** Spans with `name`. */
function named(spans: readonly ReceivedSpan[], name: string): ReceivedSpan[] {
  return spans.filter((span) => span.name === name);
}

test("the preload instruments incoming requests, fetch, and PostgreSQL in a real process, exporting only redacted, owned records", async (context) => {
  const receiver = await startOtlpReceiver();
  context.after(() => receiver.close());
  const app = await instrumentedApp(context, {
    TELEMETRY_URL: receiver.url,
    DEPENDENCY_URL: await dependency(context),
  });
  await fetch(`${app.url}/health/live`);
  await fetch(`${app.url}/v1/quiet`);
  const failed = await fetch(
    `${app.url}/v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/fail?token=query-secret`,
  );
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), {
    code: "INTERNAL_ERROR",
    message: "The request could not be completed.",
  });
  assert.equal(
    (await fetch(`${app.url}/v1/work`, { method: "POST" })).status,
    200,
  );
  const { code } = await app.stop();
  assert.equal(code, 0);

  const exported = receiver.bodies.join("\n");
  for (const secret of [
    "hunter2",
    "dbsecret",
    "query-secret",
    "sk-dependency-secret-123",
    "sk-sql-secret-456",
    "pg-password-secret",
    "secret_column",
    "Ot1-test-password",
  ])
    assert.ok(!exported.includes(secret), `${secret} must not be exported`);
  assert.ok(
    receiver.headers.every(
      (headers) =>
        headers.authorization ===
          `Basic ${Buffer.from("everything@telemetry.local:Ot1-test-password").toString("base64")}` &&
        headers["stream-name"] === "everything",
    ),
    "exports authenticate with the password file and name the stream",
  );

  assert.equal(
    named(receiver.spans, "GET /health/live").length,
    0,
    "probes are not traced",
  );
  assert.equal(
    named(receiver.spans, "GET /v1/quiet").length,
    0,
    "quick successful reads are dropped at a zero sampling ratio",
  );

  const [failure] = named(receiver.spans, "GET /v1/agents/:agentId/fail");
  assert.ok(failure, "the failed request's server span is exported");
  assert.equal(failure.kind, kinds.server);
  assert.equal(
    failure.attributes[attribute.httpRoute],
    "/v1/agents/:agentId/fail",
  );
  assert.equal(failure.attributes[attribute.ownerId], "owner-a");
  assert.equal(
    failure.attributes[attribute.agentId],
    "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
  );
  assert.equal(failure.attributes[attribute.severity], "error");
  assert.equal(failure.status.code, 2);
  const exception = failure.events.find((event) => event.name === "exception");
  assert.match(
    String(exception?.attributes["exception.message"]),
    /password=\[redacted\]/,
  );

  const [event] = receiver.logs.filter(
    (log) => log.attributes[attribute.event] === "http.request.failed",
  );
  assert.ok(event, "the failure is recorded as an event");
  assert.equal(
    event.traceId,
    failure.traceId,
    "the event is correlated with the request's trace",
  );
  assert.equal(event.attributes[attribute.ownerId], "owner-a");
  assert.equal(event.attributes[attribute.code], "INTERNAL_ERROR");
  assert.equal(event.attributes[attribute.httpStatus], 500);
  assert.match(String(event.attributes[attribute.message]), /Lookup failed/);

  const [work] = named(receiver.spans, "POST /v1/work");
  assert.ok(work, "the mutation's server span is exported");
  const children = receiver.spans.filter(
    (span) => span.parentSpanId === work.spanId,
  );
  const outgoing = children.find(
    (span) => span.kind === kinds.client && span.attributes["url.full"],
  );
  assert.ok(outgoing, "fetch is instrumented beneath the request");
  assert.match(String(outgoing.attributes["url.full"]), /\/resource$/);
  assert.equal(outgoing.attributes[attribute.ownerId], "owner-a");
  const query = children.find(
    (span) => span.attributes["db.system"] ?? span.attributes["db.system.name"],
  );
  assert.ok(query, "PostgreSQL is instrumented beneath the request");
  assert.equal(query.attributes["db.statement"], undefined);
  assert.equal(query.attributes["db.query.text"], undefined);
  assert.equal(query.attributes[attribute.ownerId], "owner-a");
});

test("with telemetry off nothing is exported and the app is unaffected", async (context) => {
  const receiver = await startOtlpReceiver();
  context.after(() => receiver.close());
  const app = await instrumentedApp(context, {
    TELEMETRY_URL: "",
    DEPENDENCY_URL: await dependency(context),
  });
  assert.equal(
    (await fetch(`${app.url}/v1/work`, { method: "POST" })).status,
    200,
  );
  assert.equal(
    (
      await fetch(
        `${app.url}/v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/fail`,
      )
    ).status,
    500,
  );
  const { code, health } = await app.stop();
  assert.equal(code, 0);
  assert.equal(health, null, "no telemetry runtime started");
  assert.equal(receiver.bodies.length, 0);
});

test("an unreachable backend never fails or delays requests, and the failure is counted", async (context) => {
  const app = await instrumentedApp(context, {
    TELEMETRY_URL: `http://127.0.0.1:${await closedPort()}`,
    DEPENDENCY_URL: await dependency(context),
  });
  const started = performance.now();
  for (let index = 0; index < 5; index++) {
    assert.equal(
      (await fetch(`${app.url}/v1/work`, { method: "POST" })).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${app.url}/v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/fail`,
        )
      ).status,
      500,
    );
  }
  assert.ok(
    performance.now() - started < 5_000,
    "requests are not held up by export",
  );
  const { code, health, output } = await app.stop();
  assert.equal(code, 0);
  assert.ok(health.failedBatches > 0, "failed exports are counted");
  assert.equal(health.lastSuccessAt, null);
  assert.match(
    output,
    /Telemetry could not be exported; Everything keeps working and will retry\./,
  );
  assert.doesNotMatch(output, /Ot1-test-password/);
});
