import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicReasoning,
  chatGptReasoning,
} from "../adapter/advertised-reasoning.js";

/** Codex-shaped reasoning entries for the given provider values. */
function levels(
  ...efforts: string[]
): { effort: string; description: string }[] {
  return efforts.map((effort) => ({ effort, description: effort }));
}

/** An Anthropic capability flag. */
const support = (supported: boolean) => ({ supported });

/** Claude capabilities with adaptive thinking and the given effort flags. */
function claude(effort: Record<string, unknown>, adaptive = true): unknown {
  return {
    effort,
    thinking: { supported: true, types: { adaptive: support(adaptive) } },
  };
}

test("ChatGPT reasoning lists become the model's complete set of sendable levels", () => {
  assert.deepEqual(
    chatGptReasoning({
      slug: "gpt-new",
      supported_reasoning_levels: levels("none", "low", "high", "low"),
      default_reasoning_level: "high",
    }),
    {
      levels: {
        off: "none",
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
      defaultEffort: "high",
    },
  );
});

test("ChatGPT levels the runtime cannot send are dropped rather than offered", () => {
  const reasoning = chatGptReasoning({
    supported_reasoning_levels: levels("ultra", "persistent", "XHIGH", "max"),
    default_reasoning_level: "ultra",
  });
  assert.deepEqual(
    Object.entries(reasoning!.levels).filter(([, value]) => value !== null),
    [["max", "max"]],
  );
  assert.equal(reasoning!.defaultEffort, undefined);
});

test("ChatGPT defaults outside the listed levels are ignored", () => {
  assert.equal(
    chatGptReasoning({
      supported_reasoning_levels: levels("low"),
      default_reasoning_level: "medium",
    })!.defaultEffort,
    undefined,
  );
});

test("missing or malformed ChatGPT reasoning lists report nothing instead of a guess", () => {
  for (const entry of [
    null,
    "gpt-new",
    { slug: "gpt-new" },
    { supported_reasoning_levels: null },
    { supported_reasoning_levels: "low,medium" },
    { supported_reasoning_levels: { effort: "low" } },
    { supported_reasoning_levels: ["low", "medium"] },
    { supported_reasoning_levels: [{ effort: "low" }, { effort: 3 }] },
    { supported_reasoning_levels: [{ effort: "low" }, null] },
    { supported_reasoning_levels: levels(...Array(33).fill("low")) },
  ])
    assert.equal(chatGptReasoning(entry), undefined, JSON.stringify(entry));
});

test("an empty ChatGPT reasoning list reports that the model accepts no levels", () => {
  const reasoning = chatGptReasoning({ supported_reasoning_levels: [] });
  assert.ok(Object.values(reasoning!.levels).every((value) => value === null));
});

test("Claude effort capabilities apply only with adaptive thinking, and minimal follows low", () => {
  assert.deepEqual(
    anthropicReasoning(
      claude({
        supported: true,
        low: support(true),
        medium: support(true),
        high: support(true),
        xhigh: null,
        max: support(false),
      }),
    ),
    {
      levels: {
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    },
  );
  assert.equal(
    anthropicReasoning(
      claude({
        supported: true,
        low: support(false),
        medium: support(true),
        high: support(true),
        xhigh: support(true),
        max: support(true),
      }),
    )!.levels.minimal,
    null,
  );
});

test("missing, unsupported, or malformed Claude effort capabilities report nothing", () => {
  const complete = {
    supported: true,
    low: support(true),
    medium: support(true),
    high: support(true),
    xhigh: support(true),
    max: support(true),
  };
  for (const capabilities of [
    null,
    undefined,
    {},
    claude({ ...complete, supported: false }),
    claude(complete, false),
    { effort: complete },
    claude({ ...complete, medium: undefined }),
    claude({ ...complete, high: { supported: "yes" } }),
    claude({ ...complete, max: null }),
  ])
    assert.equal(anthropicReasoning(capabilities), undefined);
});
