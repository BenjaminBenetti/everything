import type { AgentModelInfo } from "@everything/agent-contracts";
import type { InferenceSelection } from "@everything/provider-contracts/inference";

/** Bound untrusted cached/wire counts without inventing a model's capacity. */
export function contextTokens(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 100_000_000
  );
}

/** A pinned budget is applicable only to the provider/model displayed in this card. */
export function matchingContext(
  info: AgentModelInfo,
  selection: InferenceSelection,
): number | undefined {
  for (const model of [info.applied, info.selected]) {
    if (
      model?.provider === selection.provider &&
      model.model === selection.model &&
      contextTokens(model.contextWindow)
    )
      return model.contextWindow;
  }
  return undefined;
}
