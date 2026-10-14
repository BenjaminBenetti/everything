import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerSettings } from "@everything/settings-contracts";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { settingsController } from "../controller/settings-controller.js";

/** Mount the settings routes over in-memory worker settings, recording updates. */
async function fixture() {
  let current: WorkerSettings = { privileged: false };
  const updates: WorkerSettings[] = [];
  const app = authenticatedTestServer();
  await settingsController(app, {
    /** The stored settings. */
    async read() {
      return current;
    },
    /** Store and echo the new settings. */
    async update(settings) {
      updates.push(settings);
      current = settings;
      return current;
    },
  });
  return { app, updates };
}

test("reads and replaces the worker settings", async (context) => {
  const { app, updates } = await fixture();
  context.after(() => app.close());
  assert.deepEqual((await app.inject({ url: "/settings/workers" })).json(), {
    privileged: false,
  });
  const response = await app.inject({
    method: "PUT",
    url: "/settings/workers",
    payload: { privileged: true },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { privileged: true });
  assert.deepEqual(updates, [{ privileged: true }]);
});

test("rejects incomplete, mistyped, and unexpected worker settings", async (context) => {
  const { app, updates } = await fixture();
  context.after(() => app.close());
  for (const payload of [
    {},
    { privileged: "true" },
    { privileged: null },
    { privileged: true, namespace: "kube-system" },
  ]) {
    const response = await app.inject({
      method: "PUT",
      url: "/settings/workers",
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  assert.deepEqual(updates, []);
});
