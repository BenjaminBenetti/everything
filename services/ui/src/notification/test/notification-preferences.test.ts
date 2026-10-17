import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStorage } from "../fixture/browser-fakes.js";
import { NotificationPreferences } from "../service/notification-preferences.js";

/** A storage event as another tab's change would deliver it. */
function storageEvent(key: string | null): Event {
  return Object.assign(new Event("storage"), { key });
}

/** Two tabs of one browser: shared storage, separate pages. */
function tabs() {
  const storage = new MemoryStorage();
  const firstEvents = new EventTarget();
  const secondEvents = new EventTarget();
  return {
    storage,
    firstEvents,
    secondEvents,
    first: new NotificationPreferences(() => storage, firstEvents),
    second: new NotificationPreferences(() => storage, secondEvents),
  };
}

test("notifications are off until each user turns them on, and the choice is saved for this device", () => {
  const { first, second } = tabs();
  assert.equal(first.enabled("owner"), false);
  first.setEnabled("owner", true);
  assert.equal(first.enabled("owner"), true);
  assert.equal(first.enabled("someone-else"), false);
  assert.equal(second.enabled("owner"), true);
  first.setEnabled("owner", false);
  assert.equal(second.enabled("owner"), false);
});

test("controls on this page and in other tabs hear about changes", () => {
  const { first, second, secondEvents } = tabs();
  let here = 0;
  let there = 0;
  const stopHere = first.subscribe(() => here++);
  const stopThere = second.subscribe(() => there++);
  first.setEnabled("owner", true);
  assert.equal(here, 1);
  // Browsers announce another tab's change with a storage event.
  secondEvents.dispatchEvent(
    storageEvent("everything-desktop-notifications:owner"),
  );
  secondEvents.dispatchEvent(storageEvent("everything-theme"));
  assert.equal(there, 1);
  stopHere();
  stopThere();
  first.setEnabled("owner", false);
  assert.equal(here, 1);
});

test("a choice storage refuses to save still applies on this page", () => {
  const { first, storage } = tabs();
  storage.failWrites = true;
  first.setEnabled("owner", true);
  assert.equal(first.enabled("owner"), true);
  first.setEnabled("owner", false);
  assert.equal(first.enabled("owner"), false);
  // Once storage accepts the choice again, the saved value is used.
  storage.failWrites = false;
  first.setEnabled("owner", true);
  storage.failWrites = true;
  assert.equal(first.enabled("owner"), true);
});

test("turning notifications off still works when storage can't remove the saved choice", () => {
  const { first, second, storage } = tabs();
  first.setEnabled("owner", true);
  storage.failWrites = true;
  first.setEnabled("owner", false);
  assert.equal(first.enabled("owner"), false);
  // Another tab still reads what's saved; this page keeps its own choice.
  assert.equal(second.enabled("owner"), true);
});

test("a newer choice saved in another tab replaces one this page couldn't save", () => {
  const { first, second, storage, firstEvents } = tabs();
  first.subscribe(() => undefined);
  storage.failWrites = true;
  first.setEnabled("owner", true);
  storage.failWrites = false;
  second.setEnabled("owner", false);
  firstEvents.dispatchEvent(
    storageEvent("everything-desktop-notifications:owner"),
  );
  assert.equal(first.enabled("owner"), false);
  // Clearing storage in another tab also resets choices this page couldn't save.
  storage.failWrites = true;
  first.setEnabled("owner", true);
  storage.failWrites = false;
  firstEvents.dispatchEvent(storageEvent(null));
  assert.equal(first.enabled("owner"), false);
});

test("unavailable or blocked storage keeps the choice for this page only", () => {
  const events = new EventTarget();
  const missing = new NotificationPreferences(() => undefined, events);
  missing.setEnabled("owner", true);
  assert.equal(missing.enabled("owner"), true);

  const storage = new MemoryStorage();
  storage.failReads = true;
  storage.failWrites = true;
  const blocked = new NotificationPreferences(() => storage, events);
  assert.equal(blocked.enabled("owner"), false);
  blocked.setEnabled("owner", true);
  assert.equal(blocked.enabled("owner"), true);
});
