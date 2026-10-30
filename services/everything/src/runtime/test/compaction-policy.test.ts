import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldCompact } from "@earendil-works/pi-coding-agent";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { compactionPolicy } from "../model/compaction-policy.js";

test("unknown context compacts strictly above 183616 tokens with bounded output and retention", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const model = capabilities.resolve("chatgpt", "unlisted-context-fixture", "");
  const settings = compactionPolicy(model.contextWindow);
  assert.equal(model.contextWindow, 200000);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(settings, {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  });
  assert.equal(shouldCompact(183616, model.contextWindow, settings), false);
  assert.equal(shouldCompact(183617, model.contextWindow, settings), true);
});

test("smaller advertised context still bounds output allowance, reserve, and retained history", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const model = capabilities.resolve(
    "chatgpt",
    "unlisted-context-fixture",
    "",
    {
      contextWindow: 8192,
      maxOutputTokens: 65536,
    },
  );
  assert.equal(model.contextWindow, 8192);
  assert.equal(model.maxTokens, 8192);
  const settings = compactionPolicy(model.contextWindow);
  assert.deepEqual(settings, {
    enabled: true,
    reserveTokens: 2048,
    keepRecentTokens: 2048,
  });
  assert.equal(shouldCompact(6144, model.contextWindow, settings), false);
  assert.equal(shouldCompact(6145, model.contextWindow, settings), true);
});
