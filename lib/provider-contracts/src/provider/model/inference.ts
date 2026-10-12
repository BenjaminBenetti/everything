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

/** One complete choice, replaced atomically when a teammate is edited. */
export interface InferenceSelection {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: InferenceEffort;
}

/** Safe model metadata; available efforts depend on the selected model. */
export interface ProviderModel {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly InferenceEffort[];
  readonly defaultEffort: InferenceEffort;
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
