import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { generalSettingsController } from "../controller/general-settings-controller.js";
import { GeneralSettingsService } from "../service/general-settings-service.js";
import type { StoredGeneralSettings } from "../model/general-settings.js";

/** Exercise routing, validation, defaults, and ownership through the real settings service. */
async function fixture() {
  const saved = new Map<string, StoredGeneralSettings>();
  const service = new GeneralSettingsService({
    /** Return only the supplied owner's preferences. */
    async list({ ownerId }) {
      return saved.has(ownerId) ? [saved.get(ownerId)!] : [];
    },
    /** Retain the scope and input to detect spoofed ownership and unvalidated writes. */
    async save({ ownerId }, settings) {
      saved.set(ownerId, {
        id: ownerId,
        ownerId,
        createdAt: new Date().toISOString(),
        ...settings,
      });
    },
  });
  const app = authenticatedTestServer();
  await generalSettingsController(app, service);
  return { app, service, saved };
}

test("general settings default off and save only for the authenticated owner", async (context) => {
  const { app, service, saved } = await fixture();
  context.after(() => app.close());
  assert.deepEqual((await app.inject({ url: "/settings/general" })).json(), {
    summarizeUpdates: false,
  });
  assert.equal(saved.size, 0, "Reading defaults never writes a record");
  for (const summarizeUpdates of [false, true, false]) {
    const response = await app.inject({
      method: "PUT",
      url: "/settings/general",
      payload: { summarizeUpdates },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { summarizeUpdates });
    assert.deepEqual((await app.inject({ url: "/settings/general" })).json(), {
      summarizeUpdates,
    });
  }
  assert.deepEqual([...saved.keys()], ["owner"]);
  assert.deepEqual(await service.read("other"), { summarizeUpdates: false });
});

test("general settings reject missing, mistyped, and owner-spoofing fields", async (context) => {
  const { app, saved } = await fixture();
  context.after(() => app.close());
  for (const payload of [
    {},
    { summarizeUpdates: "false" },
    { summarizeUpdates: null },
    { summarizeUpdates: 0 },
    { summarizeUpdates: false, ownerId: "other" },
  ]) {
    const response = await app.inject({
      method: "PUT",
      url: "/settings/general",
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(saved.size, 0);
});
