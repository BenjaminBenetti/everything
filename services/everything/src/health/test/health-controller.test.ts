import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { healthController } from "../controller/health-controller.js";

test("reports liveness independently of readiness", async (context) => {
  let ready = true;
  const app = Fastify();
  context.after(() => app.close());
  await healthController(app, async () => {
    if (!ready) throw new Error("database unavailable");
  });
  assert.deepEqual((await app.inject({ url: "/health/ready" })).json(), {
    status: "ready",
  });
  ready = false;
  const unready = await app.inject({ url: "/health/ready" });
  assert.equal(unready.statusCode, 503);
  assert.deepEqual(unready.json(), { status: "unavailable" });
  assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
});
