import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStorage } from "../fixture/browser-fakes.js";
import {
  attentionLifetime,
  NotificationAttention,
} from "../service/notification-attention.js";

/** A tab whose visibility and focus the test controls. */
function tab(storage: MemoryStorage, clock: { now: number }, name: string) {
  const page = { visible: true, focused: true };
  const attention = new NotificationAttention(
    () => storage,
    { visible: () => page.visible, focused: () => page.focused },
    () => clock.now,
    name,
  );
  return { attention, page };
}

test("a chat counts as attended only while its page is visible and focused", () => {
  const { attention, page } = tab(new MemoryStorage(), { now: 0 }, "a");
  assert.equal(attention.attending("avery"), false);
  attention.show("avery");
  assert.equal(attention.attendedAgent(), "avery");
  assert.equal(attention.attending("avery"), true);
  assert.equal(attention.attending("blake"), false);
  page.focused = false;
  assert.equal(attention.attending("avery"), false);
  page.focused = true;
  page.visible = false;
  assert.equal(attention.attending("avery"), false);
  page.visible = true;
  attention.show(undefined);
  assert.equal(attention.attending("avery"), false);
});

test("other tabs see the attended chat until it's withdrawn", () => {
  const storage = new MemoryStorage();
  const clock = { now: 0 };
  const front = tab(storage, clock, "front");
  const back = tab(storage, clock, "back");
  back.page.visible = false;
  front.attention.show("avery");
  front.attention.publish();
  assert.equal(back.attention.attending("avery"), true);
  assert.equal(back.attention.attending("blake"), false);
  front.page.focused = false;
  front.attention.publish();
  assert.equal(back.attention.attending("avery"), false);
});

test("a record that isn't renewed expires, such as after the tab crashes", () => {
  const storage = new MemoryStorage();
  const clock = { now: 0 };
  const front = tab(storage, clock, "front");
  const back = tab(storage, clock, "back");
  back.page.visible = false;
  front.attention.show("avery");
  front.attention.publish();
  clock.now = attentionLifetime - 1;
  assert.equal(back.attention.attending("avery"), true);
  clock.now = attentionLifetime;
  assert.equal(back.attention.attending("avery"), false);
});

test("a tab withdraws only its own record, leaving a newer one from another tab", () => {
  const storage = new MemoryStorage();
  const clock = { now: 0 };
  const first = tab(storage, clock, "first");
  const second = tab(storage, clock, "second");
  const third = tab(storage, clock, "third");
  third.page.visible = false;
  first.attention.show("avery");
  first.attention.publish();
  second.attention.show("blake");
  second.attention.publish();
  first.attention.withdraw();
  assert.equal(third.attention.attending("blake"), true);
  second.attention.withdraw();
  assert.equal(third.attention.attending("blake"), false);
});

test("malformed records and unusable storage mean no other tab is attending", () => {
  const storage = new MemoryStorage();
  const clock = { now: 0 };
  const back = tab(storage, clock, "back");
  back.page.visible = false;
  storage.setItem("everything-notification-attention", "{not json");
  assert.equal(back.attention.attending("avery"), false);
  storage.setItem(
    "everything-notification-attention",
    JSON.stringify({ tab: "x", agentId: 5, expiresAt: 10 }),
  );
  assert.equal(back.attention.attending("avery"), false);
  storage.failReads = true;
  storage.failWrites = true;
  const front = tab(storage, clock, "front");
  front.attention.show("avery");
  front.attention.publish();
  assert.equal(front.attention.attending("avery"), true);
  assert.equal(back.attention.attending("avery"), false);
});
