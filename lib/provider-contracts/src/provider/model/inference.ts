import type { ProviderConnection, ProviderId } from "./provider.js";

/** Effort settings understood by the inference runtime. */
export const inferenceEfforts = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type InferenceEffort = (typeof inferenceEfforts)[number];

/**
 * Serving speeds a teammate can request. Fast runs the same model and effort faster at a higher
 * usage cost; standard requests no speed, so the provider's default applies.
 */
export const inferenceSpeeds = ["standard", "fast"] as const;
export type InferenceSpeed = (typeof inferenceSpeeds)[number];

/**
 * Where a model's effort levels come from: the provider's own model list, the runtime's bundled
 * model catalog, or neither, in which case only the provider's default effort is offered.
 */
export const effortSources = ["provider", "catalog", "unknown"] as const;
export type EffortSource = (typeof effortSources)[number];

/** One complete choice, replaced atomically when a teammate is edited. */
export interface InferenceSelection {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: InferenceEffort;
  /** Requested serving speed; selections saved before speeds existed omit it and mean standard. */
  readonly speed?: InferenceSpeed;
}

/** Safe model metadata; available efforts and speeds depend on the selected model. */
export interface ProviderModel {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly InferenceEffort[];
  readonly defaultEffort: InferenceEffort;
  /** Where `efforts` was learned, so a model without known effort levels can say so. */
  readonly effortSource: EffortSource;
  /** Always includes standard; includes fast only where the provider documents it for this model. */
  readonly speeds: readonly InferenceSpeed[];
}

/** A successful connection remains usable until a check fails or it is disconnected. */
export function isActiveProvider(connection: ProviderConnection): boolean {
  return (
    connection.configured &&
    connection.verifiedAt !== null &&
    connection.status !== "error" &&
    connection.status !== "disconnected"
  );
}
