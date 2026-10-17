import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { teammateOrderLimits } from "@everything/settings-contracts";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { generalSettingsController } from "../controller/general-settings-controller.js";
import { teammateOrderController } from "../controller/teammate-order-controller.js";
import type { GeneralSettingsStore } from "../interface/general-settings-repository.js";
import type { StoredGeneralSettings } from "../model/general-settings.js";
import { GeneralSettingsService } from "../service/general-settings-service.js";
import { TeammateOrderService } from "../service/teammate-order-service.js";

/** Exercise routing, validation, and merging through both services sharing one owner's record. */
async function fixture() {
  const saved = new Map<string, StoredGeneralSettings>();
  const store: GeneralSettingsStore = {
    /** Return only the supplied owner's preferences. */
    async list({ ownerId }) {
      return saved.has(ownerId) ? [saved.get(ownerId)!] : [];
    },
    /** Merge like the PostgreSQL repository so each preference keeps the others. */
    async save({ ownerId }, preferences) {
      const previous = saved.get(ownerId);
      saved.set(ownerId, {
        id: previous?.id ?? randomUUID(),
        ownerId,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        summarizeUpdates: previous?.summarizeUpdates ?? false,
        teammateIds: previous?.teammateIds ?? [],
        ...preferences,
      });
    },
  };
  const order = new TeammateOrderService(store);
  const app = authenticatedTestServer();
  await generalSettingsController(app, new GeneralSettingsService(store));
  await teammateOrderController(app, order);
  return { app, order, saved };
}

/** Replace the authenticated owner's teammate order. */
function put(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  payload: unknown,
) {
  return app.inject({
    method: "PUT",
    url: "/settings/teammate-order",
    payload: payload as object,
  });
}

test("teammate order starts empty and saves only for the authenticated owner", async (context) => {
  const { app, order, saved } = await fixture();
  context.after(() => app.close());
  assert.deepEqual(
    (await app.inject({ url: "/settings/teammate-order" })).json(),
    { teammateIds: [] },
  );
  assert.equal(saved.size, 0, "Reading the default never writes a record");
  const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
  for (const teammateIds of [[second, first, third], [third, second], []]) {
    const response = await put(app, { teammateIds });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { teammateIds });
    assert.deepEqual(
      (await app.inject({ url: "/settings/teammate-order" })).json(),
      { teammateIds },
    );
  }
  assert.deepEqual([...saved.keys()], ["owner"]);
  assert.deepEqual(await order.read("other"), { teammateIds: [] });
});

test("teammate order and summary preferences never overwrite each other", async (context) => {
  const { app, saved } = await fixture();
  context.after(() => app.close());
  const teammateIds = [randomUUID(), randomUUID()];
  await app.inject({
    method: "PUT",
    url: "/settings/general",
    payload: { summarizeUpdates: true },
  });
  const { id } = saved.get("owner")!;
  assert.equal((await put(app, { teammateIds })).statusCode, 200);
  assert.deepEqual(
    (await app.inject({ url: "/settings/general" })).json(),
    { summarizeUpdates: true },
    "Saving the order keeps summaries on",
  );
  await app.inject({
    method: "PUT",
    url: "/settings/general",
    payload: { summarizeUpdates: false },
  });
  assert.deepEqual(
    (await app.inject({ url: "/settings/teammate-order" })).json(),
    { teammateIds },
    "Changing summaries keeps the order",
  );
  assert.equal(saved.get("owner")!.id, id, "The record keeps its identity");
});

test("teammate order rejects malformed, duplicate, oversized, and owner-spoofing input", async (context) => {
  const { app, saved } = await fixture();
  context.after(() => app.close());
  const id = randomUUID();
  for (const payload of [
    {},
    { teammateIds: null },
    { teammateIds: id },
    { teammateIds: [1] },
    { teammateIds: [""] },
    { teammateIds: ["not-a-teammate"] },
    { teammateIds: [id, id] },
    { teammateIds: [id], ownerId: "other" },
    { teammateIds: [id], summarizeUpdates: true },
    {
      teammateIds: Array.from(
        { length: teammateOrderLimits.teammateCount + 1 },
        () => randomUUID(),
      ),
    },
  ]) {
    const response = await put(app, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(saved.size, 0);
  const longest = Array.from(
    { length: teammateOrderLimits.teammateCount },
    () => randomUUID(),
  );
  assert.equal((await put(app, { teammateIds: longest })).statusCode, 200);
});
