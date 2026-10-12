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
