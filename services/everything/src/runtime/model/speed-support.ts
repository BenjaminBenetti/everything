import type { ProviderId } from "@everything/provider-contracts";
import {
  inferenceSpeeds,
  type InferenceSpeed,
} from "@everything/provider-contracts/inference";
import type {
  DiscoveredModel,
  PaidSpeed,
} from "../../provider/interface/provider-models.js";
import { fastModeModel, type FastModeModel } from "./fast-mode-support.js";

/** The paid speed one request asks for, with anything more the model needs to request it. */
export interface RequestedSpeed extends FastModeModel {
  readonly speed: PaidSpeed;
}

/** A model as discovered, with the speed metadata its provider lists, if any. */
type SpeedModel = Pick<DiscoveredModel, "id" | "speeds">;

/**
 * The paid speeds a model offers and what each needs. The model picker, selection validation, and
 * every request a runtime sends use this one decision. The account's model list decides first: a
 * complete list offers exactly the speeds it names, even where documentation names Fast, and a
 * legacy list can only add Fast. Without either, Fast follows the provider's documentation for the
 * exact model. Ultrafast needs a complete list that names it; neither documentation, pricing, nor
 * a model's name ever turns it on.
 */
function speedSupport(
  provider: ProviderId,
  model: SpeedModel,
): Readonly<Partial<Record<PaidSpeed, FastModeModel>>> {
  const documented = fastModeModel(provider, model.id);
  // Only ChatGPT sign-in's account model list reports speeds, which Responses can request.
  const listed = provider === "chatgpt" ? model.speeds : undefined;
  const fast = listed?.offered.includes("fast")
    ? (documented ?? {})
    : listed?.complete
      ? undefined
      : documented;
  const ultrafast = listed?.complete && listed.offered.includes("ultrafast");
  return { ...(fast ? { fast } : {}), ...(ultrafast ? { ultrafast: {} } : {}) };
}

/** Every speed the model offers, starting with standard, in the order the model picker lists them. */
export function offeredSpeeds(
  provider: ProviderId,
  model: SpeedModel,
): InferenceSpeed[] {
  const support = speedSupport(provider, model);
  return inferenceSpeeds.filter(
    (speed) => speed === "standard" || support[speed] !== undefined,
  );
}

/** The paid speed a selection asks for, or undefined for standard or a speed the model doesn't offer. */
export function requestedSpeed(
  provider: ProviderId,
  model: SpeedModel,
  speed: InferenceSpeed | undefined,
): RequestedSpeed | undefined {
  if (speed === undefined || speed === "standard") return undefined;
  const needs = speedSupport(provider, model)[speed];
  return needs && { ...needs, speed };
}
