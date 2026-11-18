import type {
  InferenceEffort,
  InferenceSpeed,
} from "@everything/provider-contracts/inference";

/** Plain labels shared by the editor and the saved teammate details. */
export const effortLabels: Record<InferenceEffort, string> = {
  off: "Default (no effort setting)",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

/** A saved effort the model's provider no longer lists, shown until the owner chooses another. */
export function effortUnsupported(effort: string): string {
  return `The provider doesn’t list the saved effort level, ${effort}, for this model. Choose one of the levels it offers to save this model.`;
}

/** Fast mode wording describes a request to the provider, never a guaranteed faster reply. */
export const fastModeLabels = {
  switch: "Request Fast mode",
  summary: "Fast requested",
  details: "Fast mode requested",
  warning:
    "Asks the provider to reply faster with the same model and effort level. It uses your plan or credits faster, or costs more, and the provider may still answer some replies at its usual speed or decline Fast mode for your account.",
  unsupported:
    "The provider’s model list doesn’t offer Fast mode for this model. Turn it off to save this model.",
} as const;

/** A speed beyond standard, which uses more of the plan or credits. */
type PaidSpeed = Exclude<InferenceSpeed, "standard">;

/**
 * Speed menu wording for models that offer Ultrafast, where a switch can't hold three choices. Like
 * Fast mode's, it describes a request to the provider and its higher usage, never a guaranteed
 * faster reply or an estimated cost.
 */
export const speedLabels: {
  readonly field: string;
  readonly placeholder: string;
  readonly options: Readonly<Record<InferenceSpeed, string>>;
  readonly unavailable: string;
  readonly summary: Readonly<Record<PaidSpeed, string>>;
  readonly details: Readonly<Record<PaidSpeed, string>>;
  readonly warning: string;
  readonly unsupported: Readonly<Record<PaidSpeed, string>>;
} = {
  field: "Speed",
  placeholder: "Choose a speed",
  options: { standard: "Standard", fast: "Fast", ultrafast: "Ultrafast" },
  unavailable: "unavailable",
  summary: { fast: fastModeLabels.summary, ultrafast: "Ultrafast requested" },
  details: { fast: fastModeLabels.details, ultrafast: "Ultrafast requested" },
  warning:
    "Fast and Ultrafast ask the provider to reply faster with the same model and effort level. They use your plan or credits faster, or cost more, and the provider may still answer some replies at another speed or decline the speed for your account.",
  unsupported: {
    fast: "Fast mode isn’t available for this model. Choose another speed to save this model.",
    ultrafast:
      "Ultrafast isn’t available for this model on your account. Choose another speed to save this model.",
  },
};
