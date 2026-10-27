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

test("Claude effort capabilities map each level, and minimal is dropped wherever low is", () => {
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

/** Complete Claude effort flags with every level supported. */
const allEfforts = {
  supported: true,
  low: support(true),
  medium: support(true),
  high: support(true),
  xhigh: support(true),
  max: support(true),
};

test("missing or malformed Claude capabilities report nothing, so the catalog applies", () => {
  for (const capabilities of [
    null,
    undefined,
    {},
    { effort: allEfforts },
    { effort: allEfforts, thinking: { supported: true } },
    { effort: allEfforts, thinking: { types: { adaptive: support(true) } } },
    claude({ ...allEfforts, supported: undefined }),
    claude({ ...allEfforts, supported: "true" }),
    claude({ ...allEfforts, medium: undefined }),
    claude({ ...allEfforts, high: { supported: "yes" } }),
    claude({ ...allEfforts, max: null }),
    // A negative top-level flag still needs well-formed level flags to be trusted.
    claude({ ...allEfforts, supported: false, low: undefined }),
  ])
    assert.equal(
      anthropicReasoning(capabilities),
      undefined,
      JSON.stringify(capabilities),
    );
});

test("Claude models reporting no effort, adaptive thinking, or thinking accept none of the levels", () => {
  const none = {
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const capabilities of [
    // Effort withdrawn, even where a contradicting level flag says otherwise.
    claude({ ...allEfforts, supported: false }),
    // Adaptive thinking rejected: the runtime sends an effort only with it.
    claude(allEfforts, false),
    // Thinking reported unsupported overrides a contradicting adaptive flag.
    {
      effort: allEfforts,
      thinking: { supported: false, types: { adaptive: support(true) } },
    },
  ])
    assert.deepEqual(
      anthropicReasoning(capabilities),
      { levels: none },
      JSON.stringify(capabilities),
    );
});
