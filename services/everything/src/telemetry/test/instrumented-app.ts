import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import { activeTelemetry } from "../factory/telemetry-runtime.js";
import {
  bindAuthenticatedRequest,
  registerRequestTelemetry,
} from "../handler/request-telemetry.js";
import { observeFirstBuffers } from "./first-buffer-observer.js";

/**
 * A small server started with the instrumentation preload, as Everything's container starts it, so
 * a test can check what a real process exports. It loads Fastify as an ES module import and the
 * PostgreSQL client through `require`, as TypeORM does, after the preload has run.
 */
const require = createRequire(import.meta.url);

/** When a test names a file, what reaches telemetry's first buffers is written there as the app stops. */
const observationsFile = process.env.FIRST_BUFFER_OBSERVATIONS;
const observer = observationsFile ? observeFirstBuffers() : undefined;
const { Client } = require("pg") as typeof import("pg");

const app = Fastify({ logger: false });
app.setErrorHandler(errorHandler);
await registerRequestTelemetry(app);
app.decorateRequest("identity", null);
app.addHook("onRequest", async (request) => {
  if (!request.url.startsWith("/v1/")) return;
  request.identity = { subject: "owner-a" };
  bindAuthenticatedRequest(request);
});
app.get("/health/live", async () => ({ status: "ok" }));
app.get("/v1/quiet", async () => ({ status: "ok" }));
app.get("/v1/agents/:agentId/fail", async () => {
  throw new Error(
    "Lookup failed with password=hunter2 for postgresql://admin:dbsecret@postgres/everything",
    { cause: new Error(`Provider said: ${process.env.FAILURE_TEXT}`) },
  );
});
app.post("/v1/work", async () => {
  await (
    await fetch(
      `${process.env.DEPENDENCY_URL}/resource?api_key=sk-dependency-secret-123`,
    )
  ).text();
  // A gateway whose base path holds a key: as written, percent-encoded, and after an encoded ? or #.
  for (const path of [
    "/v1/sk-proj-pathsecretabcdefghijkl/messages?debug=1",
    "/v1/sk%2Dproj%2Dencodedpathsecretabcd/messages",
    "/v1/%3Fsk-proj-questionmarkkeyabcdefgh",
    "/v1/%23sk-proj-hashmarkkeyabcdefghijk",
  ])
    await (await fetch(`${process.env.DEPENDENCY_URL}${path}`)).text();
  // A call the fetch instrumentation records as failed, with a message the caller chose.
  const stalled = new AbortController();
  const call = fetch(`${process.env.DEPENDENCY_URL}/stall`, {
    signal: stalled.signal,
  });
  setTimeout(
    () =>
      stalled.abort(new Error(`Upstream said: ${process.env.FAILURE_TEXT}`)),
    100,
  );
  await call.catch(() => {});
  // Each statement on a client of its own, since a client whose connection failed answers once.
  for (const statement of [
    "SELECT secret_column FROM accounts WHERE token = 'sk-sql-secret-456'",
    // Longer than the SDK keeps an attribute, with a literal that ends beyond its limit.
    `SELECT '${"x".repeat(2_100)}' AS padding, 'sk-sql-tail-secret-789' AS tail FROM accounts`,
    // Valid PostgreSQL: a dollar quote with a non-ASCII tag around ordinary private words.
    "SELECT $ü$the visit note mentions morning appointments$ü$ AS note FROM accounts",
    // A short, deliberately fake credential assignment inside a quoted identifier.
    'SELECT 1 AS "password=REVIEWFAKEpgid7" FROM accounts',
    // The same, its value quoted inside the identifier with SQL's doubled quotes.
    'SELECT 1 AS "password=""REVIEWFAKEpgdq8""" FROM accounts',
  ]) {
    const client = new Client({
      host: "127.0.0.1",
      port: Number(process.env.CLOSED_PORT),
      user: "everything",
      password: "pg-password-secret",
      database: "everything",
      connectionTimeoutMillis: 500,
    });
    await client.connect().catch(() => {});
    await client.query(statement).catch(() => {});
    await client.end().catch(() => {});
  }
  return { status: "ok" };
});
await app.listen({ host: "127.0.0.1", port: 0 });
console.log(`ready ${(app.server.address() as AddressInfo).port}`);

process.once("SIGTERM", async () => {
  await app.close();
  const telemetry = activeTelemetry();
  await telemetry?.shutdown();
  if (observer) {
    const restored = observer.restore();
    const { held, batchedSpans, batchedLogs, errors } = observer.observations;
    await writeFile(
      observationsFile!,
      JSON.stringify({ held, batchedSpans, batchedLogs, errors, restored }),
    );
  }
  console.log(`health ${JSON.stringify(telemetry?.health() ?? null)}`);
  process.exit(0);
});
