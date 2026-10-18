import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderModel } from "@everything/provider-contracts/inference";
import { fastModeLabels } from "../model/inference-options.js";
import {
  draftSelection,
  inferenceDraft,
  isChangedDraft,
  isSupportedDraft,
  offersFast,
  withModel,
  withProvider,
} from "../model/inference-draft.js";

const fastModel: ProviderModel = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  speeds: ["standard", "fast"],
};
const standardModel: ProviderModel = {
  id: "o3-mini",
  name: "o3-mini",
  efforts: ["low", "medium", "high"],
  defaultEffort: "low",
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
