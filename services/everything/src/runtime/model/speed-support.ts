import type { ProviderId } from "@everything/provider-contracts";
import {
  inferenceSpeeds,
  type InferenceSpeed,
} from "@everything/provider-contracts/inference";
import type {
  DiscoveredModel,
  PaidSpeed,
} from "../../provider/interface/provider-models.js";

/** The paid speed one request asks for. */
export interface RequestedSpeed {
  readonly speed: PaidSpeed;
}

/** A model as discovered, with the speed metadata its provider lists, if any. */
type SpeedModel = Pick<DiscoveredModel, "speeds">;

/**
 * The paid speeds a model offers. The model picker, selection validation, and every request a
 * runtime sends use this one decision, which only the account's model list makes: a complete list
 * offers exactly the speeds it names, and a legacy list can only offer Fast. Only ChatGPT sign-in's
 * model list reports speeds, which Responses can request. Neither documentation, pricing, nor a
 * model's name turns on a paid speed, so a model whose list reports none offers standard only.
 */
function speedSupport(
  provider: ProviderId,
  model: SpeedModel,
): ReadonlySet<PaidSpeed> {
  const listed = provider === "chatgpt" ? model.speeds : undefined;
  return new Set(
    listed?.offered.filter((speed) => speed === "fast" || listed.complete),
  );
}

/** Every speed the model offers, starting with standard, in the order the model picker lists them. */
export function offeredSpeeds(
  provider: ProviderId,
  model: SpeedModel,
): InferenceSpeed[] {
  const support = speedSupport(provider, model);
  return inferenceSpeeds.filter(
    (speed) => speed === "standard" || support.has(speed),
  );
}

/** The paid speed a selection asks for, or undefined for standard or a speed the model doesn't offer. */
export function requestedSpeed(
  provider: ProviderId,
  model: SpeedModel,
  speed: InferenceSpeed | undefined,
): RequestedSpeed | undefined {
  if (speed === undefined || speed === "standard") return undefined;
  return speedSupport(provider, model).has(speed) ? { speed } : undefined;
}
