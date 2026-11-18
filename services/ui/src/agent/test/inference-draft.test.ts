import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderModel } from "@everything/provider-contracts/inference";
import { fastModeLabels, speedLabels } from "../model/inference-options.js";
import {
  draftSelection,
  inferenceDraft,
  isChangedDraft,
  isSupportedDraft,
  offeredSpeeds,
  offersFast,
  speedControl,
  withModel,
  withProvider,
} from "../model/inference-draft.js";

const fastModel: ProviderModel = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  effortSource: "catalog",
  speeds: ["standard", "fast"],
};
const ultrafastModel: ProviderModel = {
  ...fastModel,
  id: "gpt-6.2-sol",
  name: "GPT-6.2 Sol",
  speeds: ["standard", "fast", "ultrafast"],
};
const standardModel: ProviderModel = {
  id: "o3-mini",
  name: "o3-mini",
  efforts: ["low", "medium", "high"],
  defaultEffort: "low",
  effortSource: "catalog",
  speeds: ["standard"],
};

test("new teammates and selections saved before speeds existed start with Fast mode off", () => {
  assert.deepEqual(inferenceDraft(undefined), {
    provider: "",
    model: "",
    effort: "",
    speed: "standard",
  });
  const legacy = {
    provider: "chatgpt",
    model: "o3-mini",
    effort: "high",
  } as const;
  const draft = inferenceDraft(legacy);
  assert.equal(draft.speed, "standard");
  assert.equal(isChangedDraft(draft, legacy), false);
  assert.equal(isChangedDraft({ ...draft, speed: "fast" }, legacy), true);
  assert.deepEqual(
    inferenceDraft({ ...legacy, model: "gpt-6.1-sol", speed: "fast" }).speed,
    "fast",
  );
});

test("changing provider or model turns Fast mode off instead of keeping a hidden paid speed", () => {
  const fast = {
    provider: "chatgpt",
    model: "gpt-6.1-sol",
    effort: "high",
    speed: "fast",
  } as const;
  assert.deepEqual(withProvider("anthropic"), {
    provider: "anthropic",
    model: "",
    effort: "",
    speed: "standard",
  });
  assert.deepEqual(withModel(fast, standardModel.id, standardModel), {
    provider: "chatgpt",
    model: "o3-mini",
    effort: "low",
    speed: "standard",
  });
  // Even another Fast-capable model starts with Fast mode off.
  assert.equal(withModel(fast, fastModel.id, fastModel).speed, "standard");
});

test("Fast mode is offered and valid only for models that list it", () => {
  assert.equal(offersFast(fastModel), true);
  assert.equal(offersFast(standardModel), false);
  assert.equal(offersFast(undefined), false);
  const draft = {
    provider: "chatgpt",
    model: fastModel.id,
    effort: "high",
    speed: "fast",
  } as const;
  assert.equal(isSupportedDraft(draft, fastModel), true);
  assert.equal(
    isSupportedDraft({ ...draft, model: standardModel.id }, standardModel),
    false,
  );
  assert.equal(
    isSupportedDraft(
      { ...draft, model: standardModel.id, speed: "standard" },
      standardModel,
    ),
    true,
  );
  assert.equal(isSupportedDraft({ ...draft, effort: "" }, fastModel), false);
  assert.equal(isSupportedDraft(draft, undefined), false);
  // An API from before speeds existed lists no speeds: standard only, without failing.
  const { speeds: _speeds, ...older } = fastModel;
  const listed = older as ProviderModel;
  assert.equal(offersFast(listed), false);
  assert.equal(isSupportedDraft({ ...draft, speed: "standard" }, listed), true);
  assert.equal(isSupportedDraft(draft, listed), false);
});

test("the saved selection is complete before saving and names a speed only when Fast is requested", () => {
  assert.equal(draftSelection(withProvider("chatgpt")), undefined);
  assert.deepEqual(
    draftSelection({
      provider: "chatgpt",
      model: fastModel.id,
      effort: "high",
      speed: "fast",
    }),
    { provider: "chatgpt", model: fastModel.id, effort: "high", speed: "fast" },
  );
  assert.deepEqual(
    draftSelection(
      inferenceDraft({
        provider: "anthropic",
        model: "claude-opus-4-6",
        effort: "high",
      }),
    ),
    { provider: "anthropic", model: "claude-opus-4-6", effort: "high" },
  );
});

test("Fast mode wording names a request, never a confirmed faster reply", () => {
  assert.equal(fastModeLabels.switch, "Request Fast mode");
  assert.equal(fastModeLabels.summary, "Fast requested");
  assert.equal(fastModeLabels.details, "Fast mode requested");
  for (const label of Object.values(fastModeLabels))
    assert.doesNotMatch(label, /\b(active|enabled|guaranteed|always)\b/i);
});

test("Ultrafast is valid only for models that list it, is saved as itself, and never carries over to another model", () => {
  const ultrafast = {
    provider: "chatgpt",
    model: ultrafastModel.id,
    effort: "high",
    speed: "ultrafast",
  } as const;
  assert.deepEqual(offeredSpeeds(ultrafastModel), [
    "standard",
    "fast",
    "ultrafast",
  ]);
  assert.deepEqual(offeredSpeeds(undefined), []);
  assert.equal(isSupportedDraft(ultrafast, ultrafastModel), true);
  // A model offering only Fast, as on another account, keeps the saved Ultrafast unsaveable.
  assert.equal(isSupportedDraft(ultrafast, fastModel), false);
  assert.equal(
    isSupportedDraft({ ...ultrafast, speed: "fast" }, fastModel),
    true,
  );
  assert.equal(inferenceDraft(ultrafast).speed, "ultrafast");
  assert.equal(
    isChangedDraft({ ...ultrafast, speed: "fast" }, ultrafast),
    true,
  );
  assert.deepEqual(draftSelection(ultrafast), ultrafast);
  assert.equal(
    withModel(ultrafast, ultrafastModel.id, ultrafastModel).speed,
    "standard",
  );
  assert.equal(withProvider("chatgpt").speed, "standard");
});

test("Ultrafast gets a speed menu, Fast alone keeps its switch, and a saved speed the model no longer offers stays visible as unavailable", () => {
  /** The menu's speeds, with unavailable ones marked. */
  const menu = (control: ReturnType<typeof speedControl>) =>
    control.choices.map(({ speed, offered }) =>
      offered ? speed : `${speed} (unavailable)`,
    );
  assert.deepEqual(speedControl("standard", undefined), {
    kind: "none",
    choices: [],
  });
  assert.deepEqual(speedControl("standard", standardModel), {
    kind: "none",
    choices: [],
  });
  assert.deepEqual(speedControl("fast", fastModel), {
    kind: "switch",
    choices: [],
  });
  // Fast saved on a model that no longer offers it keeps the switch, to turn it off.
  assert.deepEqual(speedControl("fast", standardModel), {
    kind: "switch",
    choices: [],
    unsupported: "fast",
  });
  const offered = speedControl("standard", ultrafastModel);
  assert.equal(offered.kind, "menu");
  assert.deepEqual(menu(offered), ["standard", "fast", "ultrafast"]);
  assert.equal(offered.unsupported, undefined);
  // Ultrafast saved where it isn't offered, as after switching accounts, is never shown as Fast.
  for (const [model, choices] of [
    [fastModel, ["standard", "fast", "ultrafast (unavailable)"]],
    [standardModel, ["standard", "ultrafast (unavailable)"]],
  ] as const) {
    const stale = speedControl("ultrafast", model);
    assert.equal(stale.kind, "menu");
    assert.deepEqual(menu(stale), choices);
    assert.equal(stale.unsupported, "ultrafast");
  }
  const withoutFast = speedControl("fast", {
    ...ultrafastModel,
    speeds: ["standard", "ultrafast"],
  });
  assert.deepEqual(menu(withoutFast), [
    "standard",
    "fast (unavailable)",
    "ultrafast",
  ]);
  assert.equal(withoutFast.unsupported, "fast");
});

test("speed menu wording names each speed and its higher usage, without promising speed or estimating cost", () => {
  assert.deepEqual(speedLabels.options, {
    standard: "Standard",
    fast: "Fast",
    ultrafast: "Ultrafast",
  });
  assert.equal(speedLabels.summary.ultrafast, "Ultrafast requested");
  assert.equal(speedLabels.details.ultrafast, "Ultrafast requested");
  assert.match(speedLabels.warning, /plan or credits faster, or cost more/);
  for (const label of [
    speedLabels.warning,
    ...Object.values(speedLabels.summary),
    ...Object.values(speedLabels.details),
    ...Object.values(speedLabels.unsupported),
  ]) {
    assert.doesNotMatch(label, /\b(active|enabled|guaranteed|always)\b/i);
    assert.doesNotMatch(label, /\d|[$%×]/, "no latency or cost estimates");
  }
  assert.doesNotMatch(speedLabels.unsupported.ultrafast, /Fast mode/);
});

test("a saved Default effort a model no longer offers keeps the draft unsaveable, unchanged, until a listed effort is chosen", () => {
  const saved = {
    provider: "chatgpt",
    model: "gpt-6.1-terra",
    effort: "off",
  } as const;
  const listed: ProviderModel = {
    id: "gpt-6.1-terra",
    name: "GPT-6.1 Terra",
    efforts: ["low", "high"],
    defaultEffort: "low",
    effortSource: "provider",
    speeds: ["standard"],
  };
  const draft = inferenceDraft(saved);
  // The stale effort is kept, never swapped for the model's default, and cannot be saved.
  assert.equal(draft.effort, "off");
  assert.equal(isChangedDraft(draft, saved), false);
  assert.equal(isSupportedDraft(draft, listed), false);
  // Choosing a listed effort, as the effort menu does, makes the draft a saveable change.
  const repaired = { ...draft, effort: "high" } as const;
  assert.equal(isSupportedDraft(repaired, listed), true);
  assert.equal(isChangedDraft(repaired, saved), true);
  assert.deepEqual(draftSelection(repaired), { ...saved, effort: "high" });
});
