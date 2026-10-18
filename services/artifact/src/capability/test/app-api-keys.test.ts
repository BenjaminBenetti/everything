import assert from "node:assert/strict";
import { test } from "node:test";
import { owner } from "../../artifact/test/artifact-fixture.js";
import { newAppApiKey } from "../model/app-api-key.js";
import { AppApiKeys } from "../service/app-api-keys.js";
import { apiKeyApps } from "./api-key-fixture.js";

test("a key opens only its own dynamic app, while the live deployment enables API keys", async () => {
  const { apiKeys, artifacts, keys, deployed, store } = await apiKeyApps();
  const hooks = await deployed("hooks", ["api-key"]);
  await deployed("other", ["api-key", "everything-api"]);
  const plain = await deployed("plain", ["everything-api"]);
  const unpublished = await deployed("draft", ["api-key"], {
    liveDeployment: null,
    release: 0,
  });
  const foreign = await deployed("foreign", ["api-key"], {
    ownerId: "someone-else",
  });
  artifacts.add("static", "site", { liveRevision: 1 });

  assert.deepEqual(await apiKeys.authenticate("hooks", keys.get("hooks")!), {
    ownerId: owner,
    artifactId: hooks.id,
  });
  assert.deepEqual(
    await apiKeys.authenticate("foreign", keys.get("foreign")!),
    { ownerId: "someone-else", artifactId: foreign.id },
  );
  for (const [slug, key] of [
    ["hooks", keys.get("other")!],
    ["other", keys.get("hooks")!],
    ["hooks", keys.get("foreign")!],
    ["plain", keys.get("plain")!],
    ["draft", keys.get("draft")!],
    ["site", keys.get("hooks")!],
    ["missing", keys.get("hooks")!],
  ] as const)
    assert.equal(await apiKeys.authenticate(slug, key), undefined, slug);
  assert.ok(unpublished && plain);

  await store.revoke({ ownerId: owner, artifactId: hooks.id });
  assert.equal(
    await apiKeys.authenticate("hooks", keys.get("hooks")!),
    undefined,
  );
});

test("malformed keys are refused before any lookup", async () => {
  const apiKeys = new AppApiKeys(
    { findBySlug: async () => assert.fail("no lookup") },
    { findByRelease: async () => assert.fail("no lookup") },
    { resolve: async () => assert.fail("no lookup") },
    {
      current: async () => assert.fail("no lookup"),
      verifies: async () => assert.fail("no lookup"),
    },
  );
  const valid = newAppApiKey();
  for (const key of [
    "",
    "secret",
    `${valid}, ${valid}`,
    `${valid} `,
    valid.slice(0, -1),
    `${valid}A`,
    valid.toUpperCase(),
    `Bearer ${valid}`,
    valid.replace("everything_app_key_", "everything_view_"),
  ])
    assert.equal(await apiKeys.authenticate("hooks", key), undefined, key);
});

test("the owner sees an enabled app's current key; others and disabled apps get none", async () => {
  const { apiKeys, keys, deployed, deployments, secrets } = await apiKeyApps();
  const hooks = await deployed("hooks", ["api-key"]);
  await deployed("plain", []);
  assert.deepEqual(await apiKeys.reveal(owner, "hooks"), {
    apiKey: keys.get("hooks"),
  });
  assert.deepEqual(await apiKeys.reveal(owner, hooks.id), {
    apiKey: keys.get("hooks"),
  });
  await assert.rejects(apiKeys.reveal("someone-else", "hooks"), {
    code: "ARTIFACT_NOT_FOUND",
  });
  await assert.rejects(apiKeys.reveal("someone-else", hooks.id), {
    code: "ARTIFACT_NOT_FOUND",
  });
  await assert.rejects(apiKeys.reveal(owner, "plain"), {
    code: "APP_API_KEY_UNAVAILABLE",
  });
  await secrets.write(hooks.id, "api-key", { APP_API_KEY: newAppApiKey() });
  await assert.rejects(
    apiKeys.reveal(owner, "hooks"),
    { code: "APP_API_KEY_UNAVAILABLE" },
    "a Secret that no longer matches the record is never revealed",
  );
  await secrets.write(hooks.id, "api-key", { APP_API_KEY: keys.get("hooks")! });
  deployments.records[0] = { ...deployments.records[0]!, capabilities: [] };
  await assert.rejects(apiKeys.reveal(owner, "hooks"), {
    code: "APP_API_KEY_UNAVAILABLE",
  });
});
