import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QueryClient,
  QueryObserver,
  focusManager,
} from "@tanstack/react-query";
import type { ProviderConnection } from "@everything/provider-contracts";
import type { AgentModelInfo } from "@everything/agent-contracts";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import { HttpAgentDirectory } from "../adapter/http-agent-directory.js";
import { contextQueryOptions } from "../model/context-query.js";
import {
  ModelContextCache,
  contextCacheKey,
  contextFreshMs,
} from "../service/model-context-cache.js";

const selection: InferenceSelection = {
  provider: "chatgpt",
  model: "gpt-6.1-terra",
  effort: "off",
};
const connection: ProviderConnection = {
  provider: "chatgpt",
  configured: true,
  status: "verified",
  baseUrl: "https://synthetic.invalid",
  model: null,
  account: "synthetic-account",
  verifiedAt: null,
  lastCheckedAt: null,
  message: null,
};
const info: AgentModelInfo = {
  applied: null,
  selected: {
    ...selection,
    contextWindow: 200000,
    contextSource: "fallback",
    imageInput: true,
    imageSource: "documentation",
  },
  selectionError: false,
};

/** Real storage shape; no cache function is replaced in these tests. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("real row query + HTTP adapter: reopen/focus/navigation/reload suppress fresh discovery for 24h", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const storage = new MemoryStorage();
  const calls: string[] = [];
  let fail = false;
  const directory = new HttpAgentDirectory({
    request: async <T>(path: string) => {
      calls.push(path);
      if (fail) throw new Error("Synthetic unavailable");
      return info as T;
    },
  });
  const clients: QueryClient[] = [];
  const client = () => {
    const result = new QueryClient();
    result.mount();
    clients.push(result);
    return result;
  };
  t.after(() => {
    for (const item of clients) {
      item.unmount();
      item.clear();
    }
    focusManager.setFocused(undefined);
  });
  let cache = new ModelContextCache(() => storage);
  let queries = client();
  const mount = () => {
    const scope = cache.scope("owner-a", "avery", selection);
    const observer = new QueryObserver(
      queries,
      contextQueryOptions(directory, cache, scope, selection),
    );
    const off = observer.subscribe(() => {});
    return { observer, off };
  };
  let row = mount();
  await row.observer.refetch();
  assert.equal(row.observer.getCurrentResult().data, 200000);
  row.off();
  const writtenAt = JSON.parse(storage.getItem(contextCacheKey)!).entries[0]
    .updatedAt;
  row = mount(); // Route/card reopen uses the actual shared query options.
  await settle();
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await settle();
  assert.equal(calls.length, 1);
  row.off();
  queries.clear();
  cache = new ModelContextCache(() => storage); // Full process/query-cache replacement models reload.
  queries = client();
  now += contextFreshMs - 1;
  row = mount();
  assert.equal(row.observer.getCurrentResult().data, 200000);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(
    JSON.parse(storage.getItem(contextCacheKey)!).entries[0].updatedAt,
    writtenAt,
  );
  row.off();
  queries.clear();
  now += 2;
  fail = true;
  row = mount();
  assert.equal(row.observer.getCurrentResult().data, 200000);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(row.observer.getCurrentResult().isError, true);
  assert.equal(row.observer.getCurrentResult().data, 200000);
  fail = false;
  await row.observer.refetch();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((path) => path === "/v1/agents/avery/model-info"));
  row.off();
});

test("model/provider/effort/speed/owner changes isolate old counts and late responses including A→B→A", () => {
  const storage = new MemoryStorage();
  const cache = new ModelContextCache(() => storage);
  const first = cache.scope("owner-a", "avery", selection);
  cache.write(first, 200000);
  assert.equal(
    cache.scope("owner-a", "avery", { ...selection }).revision,
    first.revision,
  );
  for (const next of [
    { ...selection, model: "another-model" },
    { ...selection, provider: "anthropic" as const },
    { ...selection, effort: "high" as const },
    { ...selection, speed: "fast" as const },
  ]) {
    const changed = cache.scope("owner-a", "avery", next);
    assert.equal(cache.read(changed), undefined);
    assert.equal(cache.write(first, 8192), false);
  }
  const back = cache.scope("owner-a", "avery", selection);
  assert.notEqual(back.revision, first.revision);
  assert.equal(cache.write(first, 8192), false);
  cache.write(back, 16384);
  cache.discard("owner-a", "avery");
  assert.equal(cache.write(back, 200000), false);
  assert.equal(
    cache.read(cache.scope("owner-a", "avery", selection)),
    undefined,
  );
  const ownerB = cache.scope("owner-b", "avery", selection);
  assert.equal(cache.read(ownerB), undefined);
  assert.equal(cache.write(back, 200000), false);
  assert.ok(!storage.getItem(contextCacheKey)!.includes("owner-a"));
  cache.clear();
  assert.equal(storage.getItem(contextCacheKey), null);
  assert.equal(cache.write(ownerB, 8192), false);
  assert.equal(
    cache.read(cache.scope("owner-a", "avery", selection)),
    undefined,
  );
});

test("connection edits invalidate; status polling and matching reload fingerprints do not; only a digest is persisted", async () => {
  const storage = new MemoryStorage();
  let cache = new ModelContextCache(() => storage);
  cache.activate("owner-a");
  await cache.observeConnection("owner-a", "chatgpt", connection);
  let scope = cache.scope("owner-a", "avery", selection);
  cache.write(scope, 200000);
  await cache.observeConnection("owner-a", "chatgpt", {
    ...connection,
    status: "error",
    lastCheckedAt: new Date().toISOString(),
    message: "Not part of identity",
  });
  assert.equal(cache.read(scope)?.tokens, 200000);
  cache = new ModelContextCache(() => storage);
  cache.activate("owner-a");
  await cache.observeConnection("owner-a", "chatgpt", connection);
  scope = cache.scope("owner-a", "avery", selection);
  assert.equal(cache.read(scope)?.tokens, 200000);
  const persisted = storage.getItem(contextCacheKey)!;
  for (const secret of [
    "synthetic.invalid",
    "synthetic-account",
    "Not part of identity",
    "imageInput",
    "contextSource",
  ])
    assert.ok(!persisted.includes(secret));
  await cache.observeConnection("owner-a", "chatgpt", {
    ...connection,
    account: "changed-account",
  });
  assert.equal(cache.read(scope), undefined);
  assert.equal(cache.write(scope, 200000), false);
  scope = cache.scope("owner-a", "avery", selection);
  cache.write(scope, 8192);
  cache.invalidateProvider("owner-a", "chatgpt"); // Same-address/key-only edit still invalidates.
  assert.equal(cache.read(scope), undefined);
  scope = cache.scope("owner-a", "avery", selection);
  cache.write(scope, 16384);
  await cache.observeConnection("owner-a", "chatgpt"); // Missing/disconnected connection is also an identity change.
  assert.equal(cache.read(scope), undefined);
});

test("two observers deduplicate and a held real adapter response cannot overwrite a new selection", async (t) => {
  const cache = new ModelContextCache(() => undefined);
  const client = new QueryClient();
  t.after(() => client.clear());
  let release!: (value: AgentModelInfo) => void;
  let calls = 0;
  const directory = new HttpAgentDirectory({
    request: <T>() => {
      calls++;
      return new Promise<AgentModelInfo>((resolve) => {
        release = resolve;
      }) as Promise<T>;
    },
  });
  const old = cache.scope("owner-a", "avery", selection);
  const options = contextQueryOptions(directory, cache, old, selection);
  const first = new QueryObserver(client, options);
  const second = new QueryObserver(client, options);
  const off = first.subscribe(() => {});
  const off2 = second.subscribe(() => {});
  assert.equal(calls, 1);
  const next = cache.scope("owner-a", "avery", {
    ...selection,
    model: "another-model",
  });
  cache.write(next, 8192);
  release(info);
  await settle();
  assert.equal(cache.read(next)?.tokens, 8192);
  assert.equal(cache.read(old), undefined);
  off();
  off2();
});

test("corrupt, old-schema, oversized, invalid-number and future/fully-expired storage fail quietly", () => {
  const storage = new MemoryStorage();
  for (const value of [
    "{",
    "null",
    JSON.stringify({ version: 0 }),
    "x".repeat(65537),
  ]) {
    storage.setItem(contextCacheKey, value);
    const cache = new ModelContextCache(() => storage);
    assert.equal(
      cache.read(cache.scope("owner-a", "avery", selection)),
      undefined,
    );
  }
  let now = Date.now();
  const cache = new ModelContextCache(
    () => storage,
    () => now,
  );
  const scope = cache.scope("owner-a", "avery", selection);
  cache.write(scope, 200000);
  const saved = storage.getItem(contextCacheKey)!;
  for (const patch of [
    { tokens: -1 },
    { tokens: "200000" },
    { updatedAt: now + 1 },
    { updatedAt: now - 8 * contextFreshMs },
  ]) {
    const data = JSON.parse(saved);
    Object.assign(data.entries[0], patch);
    storage.setItem(contextCacheKey, JSON.stringify(data));
    const reloaded = new ModelContextCache(
      () => storage,
      () => now,
    );
    assert.equal(
      reloaded.read(reloaded.scope("owner-a", "avery", selection)),
      undefined,
    );
  }
  storage.setItem(contextCacheKey, saved);
  now += 8 * contextFreshMs;
  assert.equal(
    cache.read(cache.scope("owner-a", "avery", selection)),
    undefined,
  );
});

test("entry and UTF-8 size bounds, missing/throwing storage, and invalid response numbers remain safe", () => {
  const storage = new MemoryStorage();
  const cache = new ModelContextCache(() => storage);
  for (let i = 0; i < 100; i++)
    cache.write(
      cache.scope("owner-a", `teammate-${i}`, {
        ...selection,
        model: "🧪".repeat(100),
      }),
      200000,
    );
  const text = storage.getItem(contextCacheKey)!;
  assert.ok(new TextEncoder().encode(text).length <= 65536);
  assert.ok(JSON.parse(text).entries.length <= 64);
  const last = cache.scope("owner-a", "teammate-99", {
    ...selection,
    model: "🧪".repeat(100),
  });
  assert.equal(cache.read(last)?.tokens, 200000);
  for (const access of [
    () => undefined,
    () => {
      throw new Error("Storage blocked");
    },
  ]) {
    const memory = new ModelContextCache(access);
    const scope = memory.scope("owner-a", "avery", selection);
    assert.equal(memory.write(scope, NaN), false);
    assert.equal(memory.write(scope, 200000), true);
    assert.equal(memory.read(scope)?.tokens, 200000);
    memory.clear();
  }
});
