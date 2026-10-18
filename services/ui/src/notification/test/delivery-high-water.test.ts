import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryHighWater } from "../model/delivery-high-water.js";

/** A delivery at a whole second after a fixed start. */
function at(id: string, second: number) {
  return {
    id,
    createdAt: new Date(Date.UTC(2026, 9, 17, 9, 0, second)).toISOString(),
  };
}

/** IDs returned by an observation. */
function ids(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id);
}

test("the first observation is the baseline and later deliveries are new, oldest first", () => {
  const highWater = new DeliveryHighWater();
  assert.equal(highWater.started, false);
  assert.deepEqual(highWater.observe([at("b", 2), at("a", 1)]), []);
  assert.equal(highWater.started, true);
  assert.deepEqual(
    ids(highWater.observe([at("d", 4), at("c", 3), at("b", 2)])),
    ["c", "d"],
  );
});

test("older unread rows surfacing after newer ones are read are not new", () => {
  const highWater = new DeliveryHighWater();
  // The first page shows the newest rows; older unread rows wait beyond it.
  highWater.observe([at("u60", 60), at("u59", 59), at("u58", 58)]);
  // The user reads the newest rows, so older unread rows move onto the first page.
  assert.deepEqual(
    highWater.observe([at("u58", 58), at("u12", 12), at("u11", 11)]),
    [],
  );
  // Everything newer is read; the page holds only old rows never seen before.
  assert.deepEqual(highWater.observe([at("u10", 10), at("u09", 9)]), []);
  assert.deepEqual(ids(highWater.observe([at("new", 61), at("u10", 10)])), [
    "new",
  ]);
});

test("an empty page keeps the high-water mark, so old rows can't return as new", () => {
  const highWater = new DeliveryHighWater();
  highWater.observe([at("a", 5)]);
  assert.deepEqual(highWater.observe([]), []);
  assert.deepEqual(highWater.observe([at("old", 4)]), []);
  assert.deepEqual(ids(highWater.observe([at("next", 6)])), ["next"]);
});

test("an empty baseline means any later row is a new delivery", () => {
  const highWater = new DeliveryHighWater();
  highWater.observe([]);
  assert.deepEqual(ids(highWater.observe([at("first", 1)])), ["first"]);
});

test("observing the same page again, as after a reconnect, finds nothing", () => {
  const highWater = new DeliveryHighWater();
  highWater.observe([at("a", 1)]);
  assert.deepEqual(ids(highWater.observe([at("b", 2), at("a", 1)])), ["b"]);
  assert.deepEqual(highWater.observe([at("b", 2), at("a", 1)]), []);
  assert.deepEqual(highWater.observe([at("b", 2), at("a", 1)]), []);
});

test("deliveries at the same instant as the newest one seen are new only if unseen", () => {
  const highWater = new DeliveryHighWater();
  highWater.observe([at("first", 7)]);
  assert.deepEqual(ids(highWater.observe([at("twin", 7), at("first", 7)])), [
    "twin",
  ]);
  assert.deepEqual(highWater.observe([at("twin", 7), at("first", 7)]), []);
  assert.deepEqual(ids(highWater.observe([at("later", 8), at("twin", 7)])), [
    "later",
  ]);
  assert.deepEqual(highWater.observe([at("late-twin", 7)]), []);
});

test("rows without a valid delivery time are ignored", () => {
  const highWater = new DeliveryHighWater();
  highWater.observe([at("a", 1)]);
  assert.deepEqual(
    highWater.observe([{ id: "broken", createdAt: "not a date" }]),
    [],
  );
});

test("reset starts a new baseline, so nothing delivered meanwhile is replayed", () => {
  const highWater = new DeliveryHighWater();
  highWater.observe([at("a", 1)]);
  highWater.reset();
  assert.equal(highWater.started, false);
  assert.deepEqual(highWater.observe([at("c", 3), at("b", 2)]), []);
  assert.deepEqual(ids(highWater.observe([at("d", 4)])), ["d"]);
});

test("remembered IDs are bounded while the high-water mark still rejects old rows", () => {
  const highWater = new DeliveryHighWater();
  highWater.observe([at("start", 0)]);
  for (let second = 1; second <= 600; second++)
    assert.deepEqual(ids(highWater.observe([at(`m${second}`, second)])), [
      `m${second}`,
    ]);
  // The earliest IDs have been forgotten, but rows older than the mark still aren't new.
  assert.deepEqual(highWater.observe([at("m1", 1), at("start", 0)]), []);
});
