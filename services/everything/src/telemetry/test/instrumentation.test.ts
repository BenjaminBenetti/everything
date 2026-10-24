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

/**
 * Natural-language text an error could quote from a request. It is no credential shape, so only
 * withholding error text keeps it out of telemetry.
 */
const privateText = "The private launch date is next Tuesday";

/** An HTTP dependency the app calls with `fetch`; `/stall` never answers. */
async function dependency(context: TestContext): Promise<string> {
  const server: Server = createServer((request, response) => {
    if (request.url !== "/stall") response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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
        FAILURE_TEXT: privateText,
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

/** Secrets the app's requests, errors, and dependency calls carry, none of which may be exported. */
const secrets = [
  "hunter2",
  "dbsecret",
  "query-secret",
  "sk-dependency-secret-123",
  "sk-sql-secret-456",
  "pg-password-secret",
  "secret_column",
  "Ot1-test-password",
  "pathsecretabcdefghijkl",
  "encodedpathsecretabcd",
  "questionmarkkeyabcdefgh",
  "hashmarkkeyabcdefghijk",
];

/**
 * Run the instrumented app against an OTLP receiver with `environment`, make a failing request and
 * a mutation that calls dependencies, and return what it exported.
 */
async function exercise(
  context: TestContext,
  environment: Record<string, string> = {},
) {
  const receiver = await startOtlpReceiver();
  context.after(() => receiver.close());
  const dependencyUrl = await dependency(context);
  const app = await instrumentedApp(context, {
    TELEMETRY_URL: receiver.url,
    DEPENDENCY_URL: dependencyUrl,
    ...environment,
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
  for (const secret of secrets)
    assert.ok(!exported.includes(secret), `${secret} must not be exported`);

  const [failure] = named(receiver.spans, "GET /v1/agents/:agentId/fail");
  assert.ok(failure, "the failed request's server span is exported");
  const [event] = receiver.logs.filter(
    (log) => log.attributes[attribute.event] === "http.request.failed",
  );
  assert.ok(event, "the failure is recorded as an event");
  const [work] = named(receiver.spans, "POST /v1/work");
  assert.ok(work, "the mutation's server span is exported");
  const children = receiver.spans.filter(
    (span) => span.parentSpanId === work.spanId,
  );
  const outgoing = children.filter(
    (span) => span.kind === kinds.client && span.attributes["url.full"],
  );
  const stalled = outgoing.find((span) =>
    String(span.attributes["url.full"]).endsWith("/stall"),
  );
  assert.ok(stalled, "the failed dependency call is exported");
  return {
    receiver,
    exported,
    dependencyUrl,
    failure,
    event,
    work,
    children,
    outgoing,
    stalled,
  };
}

test("the preload instruments incoming requests, fetch, and PostgreSQL in a real process, exporting only redacted, owned records without error text", async (context) => {
  const {
    receiver,
    exported,
    dependencyUrl,
    failure,
    event,
    work,
    children,
    outgoing,
    stalled,
  } = await exercise(context);
  for (const text of [
    privateText,
    "Lookup failed",
    "Provider said",
    "Upstream said",
  ])
    assert.ok(!exported.includes(text), `${text} is error text, withheld`);
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
  assert.equal(failure.attributes[attribute.textWithheld], true);
  assert.equal(failure.status.code, 2);
  assert.equal(failure.status.message, undefined);
  const exception = failure.events.find((event) => event.name === "exception");
  assert.equal(exception?.attributes["exception.type"], "Error");
  assert.equal(exception?.attributes["exception.message"], undefined);

  assert.equal(
    event.traceId,
    failure.traceId,
    "the event is correlated with the request's trace",
  );
  assert.equal(event.attributes[attribute.ownerId], "owner-a");
  assert.equal(event.attributes[attribute.code], "INTERNAL_ERROR");
  assert.equal(event.attributes[attribute.httpStatus], 500);
  assert.equal(event.attributes[attribute.errorType], "Error");
  assert.match(
    String(event.attributes[attribute.stack]),
    /^at .*instrumented-app\.ts:\d+:\d+\)?/,
    "the failure's code location is kept",
  );
  assert.equal(event.attributes[attribute.message], undefined);
  assert.equal(event.attributes[attribute.textWithheld], true);

  assert.deepEqual(
    outgoing.map((span) => span.attributes["url.full"]).sort(),
    [
      `${dependencyUrl}/resource`,
      `${dependencyUrl}/stall`,
      `${dependencyUrl}/v1/%23[redacted]`,
      `${dependencyUrl}/v1/%3F[redacted]`,
      `${dependencyUrl}/v1/[redacted]/messages`,
      `${dependencyUrl}/v1/[redacted]/messages`,
    ],
    "fetch is instrumented beneath the request, with credentials in paths redacted",
  );
  for (const span of outgoing)
    assert.equal(span.attributes[attribute.ownerId], "owner-a");
  assert.equal(stalled.status.code, 2, "the failed call is an error");
  assert.equal(stalled.status.message, undefined);
  assert.equal(stalled.attributes[attribute.severity], "error");
  assert.equal(stalled.attributes[attribute.textWithheld], true);
  assert.equal(
    stalled.events.find((event) => event.name === "exception")?.attributes[
      "exception.type"
    ],
    "Error",
  );
  const query = children.find(
    (span) => span.attributes["db.system"] ?? span.attributes["db.system.name"],
  );
  assert.ok(query, "PostgreSQL is instrumented beneath the request");
  assert.equal(query.attributes["db.statement"], undefined);
  assert.equal(query.attributes["db.query.text"], undefined);
  assert.equal(query.attributes[attribute.ownerId], "owner-a");
  assert.equal(work.attributes[attribute.ownerId], "owner-a");
});

test("with error text recorded, the preload exports it redacted and bounded, and still redacts credentials", async (context) => {
  const { exported, failure, event, stalled, outgoing, dependencyUrl } =
    await exercise(context, { TELEMETRY_INCLUDE_ERROR_TEXT: "true" });
  const exception = failure.events.find((event) => event.name === "exception");
  const message = String(exception?.attributes["exception.message"]);
  assert.match(message, /Lookup failed with password=\[redacted\]/);
  assert.match(message, new RegExp(`Provider said: ${privateText}`));
  assert.ok(message.length <= 400);
  assert.equal(failure.attributes[attribute.textWithheld], undefined);
  assert.match(String(event.attributes[attribute.message]), /^Lookup failed/);
  assert.equal(event.attributes[attribute.textWithheld], undefined);
  assert.equal(stalled.status.message, `Upstream said: ${privateText}`);
  for (const path of [
    "/v1/[redacted]/messages",
    "/v1/%3F[redacted]",
    "/v1/%23[redacted]",
  ])
    assert.ok(
      outgoing.some(
        (span) => span.attributes["url.full"] === `${dependencyUrl}${path}`,
      ),
      path,
    );
  assert.ok(exported.includes(privateText), "error text is recorded");
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
