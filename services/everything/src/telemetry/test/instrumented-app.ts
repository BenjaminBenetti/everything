import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import { activeTelemetry } from "../factory/telemetry-runtime.js";
import {
  bindAuthenticatedRequest,
  registerRequestTelemetry,
} from "../handler/request-telemetry.js";

/**
 * A small server started with the instrumentation preload, as Everything's container starts it, so
 * a test can check what a real process exports. It loads Fastify as an ES module import and the
 * PostgreSQL client through `require`, as TypeORM does, after the preload has run.
 */
const require = createRequire(import.meta.url);
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
  );
});
app.post("/v1/work", async () => {
  await (
    await fetch(
      `${process.env.DEPENDENCY_URL}/resource?api_key=sk-dependency-secret-123`,
    )
  ).text();
  const client = new Client({
    host: "127.0.0.1",
    port: Number(process.env.CLOSED_PORT),
    user: "everything",
    password: "pg-password-secret",
    database: "everything",
    connectionTimeoutMillis: 500,
  });
  await client.connect().catch(() => {});
  await client
    .query(
      "SELECT secret_column FROM accounts WHERE token = 'sk-sql-secret-456'",
    )
    .catch(() => {});
  await client.end().catch(() => {});
  return { status: "ok" };
});
await app.listen({ host: "127.0.0.1", port: 0 });
console.log(`ready ${(app.server.address() as AddressInfo).port}`);

process.once("SIGTERM", async () => {
  await app.close();
  const telemetry = activeTelemetry();
  await telemetry?.shutdown();
  console.log(`health ${JSON.stringify(telemetry?.health() ?? null)}`);
  process.exit(0);
});
