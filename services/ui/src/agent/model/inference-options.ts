import type { InferenceEffort } from "@everything/provider-contracts/inference";

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

/** Fast mode wording describes a request to the provider, never a guaranteed faster reply. */
export const fastModeLabels = {
  switch: "Request Fast mode",
  summary: "Fast requested",
  details: "Fast mode requested",
  warning:
    "Asks the provider to reply faster with the same model and effort level. It uses your plan or credits faster, or costs more, and the provider may still answer some replies at its usual speed or decline Fast mode for your account.",
  unsupported:
    "Fast mode isn’t available for this model. Turn it off to save this model.",
} as const;
