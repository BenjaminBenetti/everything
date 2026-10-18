import {
  inferenceSpeeds,
  type InferenceSpeed,
} from "@everything/provider-contracts/inference";

/** A speed the provider reports serving a response at; unknown when it reports none or another tier. */
export type EffectiveSpeed = InferenceSpeed | "unknown";

/** Why a provider refused a Fast request: unavailable to this account or model, or over its Fast limit. */
export type SpeedFailure = "rejected" | "limited";

/** A provider's own speed or tier name for a response, with its normalized meaning. */
export interface ReportedSpeed {
  /** The provider's value, such as `priority`, `default`, or `fast`; absent when it reports none. */
  readonly tier?: string;
  readonly effective: EffectiveSpeed;
}

/** The speed a response was requested at and the speed its provider reports serving it at. */
export interface SpeedReport {
  readonly requested: InferenceSpeed;
  /** Normalized provider-reported speed; unknown when the provider reported none or the request failed. */
  readonly effective: EffectiveSpeed;
  /** The provider's own reported value, kept so aliases and new tiers are not lost. */
  readonly reportedTier?: string;
  readonly failure?: SpeedFailure;
}

/** Diagnostic type that records a response's speed on its transcript message. */
export const speedDiagnosticType = "inference-speed";

/** Provider tier names are short identifiers; anything else is not kept. */
const tierPattern = /^[\w.-]{1,32}$/;

/** A provider's reported tier when it is a short identifier, so no other response text is stored. */
export function reportedTier(value: unknown): string | undefined {
  return typeof value === "string" && tierPattern.test(value)
    ? value
    : undefined;
}

/** The speed recorded on a response message, or undefined for messages recorded without one. */
export function speedReport(message: {
  readonly diagnostics?: readonly { type: string; details?: unknown }[];
}): SpeedReport | undefined {
  const details = message.diagnostics?.findLast(
    (diagnostic) => diagnostic.type === speedDiagnosticType,
  )?.details as Partial<Record<keyof SpeedReport, unknown>> | undefined;
  if (
    !details ||
    !inferenceSpeeds.includes(details.requested as InferenceSpeed) ||
    ![...inferenceSpeeds, "unknown"].includes(details.effective as string)
  )
    return undefined;
  const tier = reportedTier(details.reportedTier);
  return {
    requested: details.requested as InferenceSpeed,
    effective: details.effective as EffectiveSpeed,
    ...(tier !== undefined ? { reportedTier: tier } : {}),
    ...(details.failure === "rejected" || details.failure === "limited"
      ? { failure: details.failure }
      : {}),
  };
}
