import assert from "node:assert/strict";
import { test } from "node:test";
import { arrangeTeammates, moveTeammate } from "../model/teammate-order.js";

/** Teammates in creation order, as the API lists them. */
const team = ["ada", "bo", "cy", "di", "ed"].map((id) => ({ id }));

/** Read only the IDs of an arranged team. */
function ids(teammates: readonly { id: string }[]): string[] {
  return teammates.map((teammate) => teammate.id);
}

test("teammates keep creation order until the owner saves one", () => {
  assert.deepEqual(ids(arrangeTeammates(team, [])), [
    "ada",
    "bo",
    "cy",
    "di",
    "ed",
  ]);
  assert.deepEqual(arrangeTeammates([], ["ada"]), []);
});

test("a saved order applies, and new teammates follow it in creation order", () => {
  assert.deepEqual(ids(arrangeTeammates(team, ["di", "ada", "cy"])), [
    "di",
    "ada",
    "cy",
    "bo",
    "ed",
  ]);
});

test("deleted and repeated saved IDs are skipped without moving anyone else", () => {
  assert.deepEqual(
    ids(arrangeTeammates(team, ["gone", "ed", "ada", "ed", "gone", "bo"])),
    ["ed", "ada", "bo", "cy", "di"],
  );
  const agent = { id: "ada", name: "Ada" };
  assert.equal(arrangeTeammates([agent], ["ada"])[0], agent);
});

test("moving a teammate places them in the target's position in either direction", () => {
  const order = ids(team);
  assert.deepEqual(moveTeammate(order, "ada", "cy"), [
    "bo",
    "cy",
    "ada",
    "di",
    "ed",
  ]);
  assert.deepEqual(moveTeammate(order, "ed", "bo"), [
    "ada",
    "ed",
    "bo",
    "cy",
    "di",
  ]);
  assert.deepEqual(moveTeammate(order, "ed", "ada"), [
    "ed",
    "ada",
    "bo",
    "cy",
    "di",
  ]);
  assert.deepEqual(order, ["ada", "bo", "cy", "di", "ed"], "Input unchanged");
});

test("moves that change nothing, or name an unknown teammate, report no change", () => {
  const order = ids(team);
  assert.equal(moveTeammate(order, "cy", "cy"), undefined);
  assert.equal(moveTeammate(order, "gone", "cy"), undefined);
  assert.equal(moveTeammate(order, "cy", "gone"), undefined);
  assert.equal(moveTeammate([], "cy", "cy"), undefined);
});

test("moving within a filtered view keeps hidden teammates in their relative order", () => {
  const order = ids(team);
  const visible = ["ada", "cy", "ed"];
  const moved = moveTeammate(order, "ed", "ada")!;
  assert.deepEqual(moved, ["ed", "ada", "bo", "cy", "di"]);
  assert.deepEqual(
    moved.filter((id) => !visible.includes(id)),
    ["bo", "di"],
  );
  assert.deepEqual(
    moved.filter((id) => visible.includes(id)),
    ["ed", "ada", "cy"],
  );
});
