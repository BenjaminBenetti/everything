import assert from "node:assert/strict";
import { test } from "node:test";
import { chatGptSpeeds } from "../adapter/advertised-speeds.js";

/** Codex-shaped service tier entries for the given tier IDs. */
function tiers(
  ...ids: string[]
): { id: string; name: string; description: string }[] {
  return ids.map((id) => ({ id, name: id, description: `${id} processing` }));
}

test("a ChatGPT service tier list is the model's complete set of paid speeds", () => {
  for (const [ids, offered] of [
    [
      ["priority", "ultrafast"],
      ["fast", "ultrafast"],
    ],
    [
      ["ultrafast", "priority"],
      ["fast", "ultrafast"],
    ],
    [["priority"], ["fast"]],
    // `fast` is the documented alias of `priority`.
    [["fast"], ["fast"]],
    [["ultrafast"], ["ultrafast"]],
    // Tiers the runtime has no speed for are left out, so they are never offered or sent.
    [["flex", "Ultrafast", "ultra_fast", "priority"], ["fast"]],
    [[], []],
  ] as const)
    assert.deepEqual(
      chatGptSpeeds({ slug: "gpt-new", service_tiers: tiers(...ids) }),
      { offered, complete: true },
      JSON.stringify(ids),
    );
});

test("only each tier's ID is read; its catalog name, description, and the default tier don't change the speeds", () => {
  assert.deepEqual(
    chatGptSpeeds({
      service_tiers: [
        { id: "priority", name: "Ultrafast", description: "4.5x speed" },
        { id: "flex", name: "Fast" },
      ],
      default_service_tier: "ultrafast",
    }),
    { offered: ["fast"], complete: true },
  );
});

test("a complete service tier list wins over the deprecated speed list", () => {
  assert.deepEqual(
    chatGptSpeeds({ service_tiers: [], additional_speed_tiers: ["fast"] }),
    { offered: [], complete: true },
  );
  assert.deepEqual(
    chatGptSpeeds({
      service_tiers: tiers("ultrafast"),
      additional_speed_tiers: ["fast"],
    }),
    { offered: ["ultrafast"], complete: true },
  );
});

test("the deprecated speed list can only add Fast, and denies nothing it leaves out", () => {
  for (const entry of [
    { additional_speed_tiers: ["fast"] },
    { additional_speed_tiers: ["fast", "ultrafast"] },
    { service_tiers: "priority", additional_speed_tiers: ["fast"] },
  ])
    assert.deepEqual(
      chatGptSpeeds(entry),
      { offered: ["fast"], complete: false },
      JSON.stringify(entry),
    );
  for (const entry of [
    { additional_speed_tiers: [] },
    { additional_speed_tiers: ["ultrafast"] },
    { additional_speed_tiers: ["priority"] },
    { additional_speed_tiers: ["fast", 1] },
    { additional_speed_tiers: "fast" },
    { additional_speed_tiers: Array(33).fill("fast") },
  ])
    assert.equal(chatGptSpeeds(entry), undefined, JSON.stringify(entry));
});

test("missing or malformed ChatGPT speed metadata reports nothing instead of a guess", () => {
  for (const entry of [
    null,
    "gpt-6.2-sol",
    { slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", visibility: "list" },
    { service_tiers: null },
    { service_tiers: "ultrafast" },
    { service_tiers: { id: "ultrafast" } },
    { service_tiers: ["ultrafast"] },
    { service_tiers: [{ id: "ultrafast" }, { id: 3 }] },
    { service_tiers: [{ id: "ultrafast" }, null] },
    { service_tiers: [{ name: "Ultrafast" }] },
    { service_tiers: tiers(...Array(33).fill("ultrafast")) },
  ])
    assert.equal(chatGptSpeeds(entry), undefined, JSON.stringify(entry));
});
