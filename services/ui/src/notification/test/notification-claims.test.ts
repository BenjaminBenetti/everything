import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStorage, serialLocks } from "../fixture/browser-fakes.js";
import { NotificationClaims } from "../service/notification-claims.js";

const storageKey = "everything-notified-messages";

test("a message is claimed once within a tab", async () => {
  const claims = new NotificationClaims(
    () => new MemoryStorage(),
    null,
    () => 1_000,
  );
  assert.equal(await claims.claim("m1"), true);
  assert.equal(await claims.claim("m1"), false);
  assert.equal(await claims.claim("m2"), true);
});

test("tabs sharing storage claim each message once, even when they claim at the same time", async () => {
  const storage = new MemoryStorage();
  const locks = serialLocks();
  const tabs = [1, 2, 3].map(
    () =>
      new NotificationClaims(
        () => storage,
        locks,
        () => 1_000,
      ),
  );
  const results = await Promise.all(tabs.map((tab) => tab.claim("m1")));
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.deepEqual(locks.names, [storageKey, storageKey, storageKey]);
});

test("without the Web Locks API, a later tab still sees an earlier claim", async () => {
  const storage = new MemoryStorage();
  const first = new NotificationClaims(
    () => storage,
    null,
    () => 1_000,
  );
  const second = new NotificationClaims(
    () => storage,
    null,
    () => 1_000,
  );
  assert.equal(await first.claim("m1"), true);
  assert.equal(await second.claim("m1"), false);
});

test("a failing lock or unusable storage still allows the claim in this tab", async () => {
  const storage = new MemoryStorage();
  const failing = new NotificationClaims(
    () => storage,
    { request: (() => Promise.reject(new Error("Lock aborted"))) as never },
    () => 1_000,
  );
  assert.equal(await failing.claim("m1"), true);
  assert.equal(await failing.claim("m1"), false);

  storage.failReads = true;
  const blocked = new NotificationClaims(
    () => storage,
    null,
    () => 1_000,
  );
  assert.equal(await blocked.claim("m2"), true);
  assert.equal(await blocked.claim("m2"), false);
});

test("stored claims are bounded, expire after a day, and malformed entries are ignored", async () => {
  const storage = new MemoryStorage();
  let clock = 1_000;
  storage.setItem(
    storageKey,
    JSON.stringify([["old", 0], "broken", ["kept", 999], [5, 1]]),
  );
  const claims = new NotificationClaims(
    () => storage,
    null,
    () => clock,
  );
  assert.equal(await claims.claim("new"), true);
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)!), [
    ["old", 0],
    ["kept", 999],
    ["new", 1_000],
  ]);
  clock = 24 * 60 * 60 * 1000 + 500;
  const later = new NotificationClaims(
    () => storage,
    null,
    () => clock,
  );
  // "old" has expired, so the same ID could be claimed again by a fresh tab.
  assert.equal(await later.claim("old"), true);
  for (let index = 0; index < 400; index++)
    await later.claim(`message-${index}`);
  assert.equal(JSON.parse(storage.getItem(storageKey)!).length, 300);

  storage.setItem(storageKey, "not json");
  assert.equal(await later.claim("after-corruption"), true);
});
