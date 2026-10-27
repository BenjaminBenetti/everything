import type { InferenceEffort } from "@everything/provider-contracts/inference";
import type { AdvertisedReasoning } from "../interface/provider-models.js";

/** Most reasoning entries accepted for one model, so a malformed list can't grow without bound. */
const maximumLevels = 32;

// ===========================================
// ChatGPT
// ===========================================

/**
 * ChatGPT reasoning values the runtime can send as Responses `reasoning.effort`, by effort level.
 * `none` turns reasoning off. Values the runtime has no effort level for, such as `ultra`, are
 * left out, so they are never offered.
 */
const chatGptValues: Readonly<Record<string, InferenceEffort>> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Effort levels from one ChatGPT model-list entry, or undefined when the entry has none or they are
 * malformed. The sign-in model list documents only `slug`, `display_name`, and `visibility`
 * (https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference); this reads
 * the optional `supported_reasoning_levels` and `default_reasoning_level` only when present, in
 * the shape Codex's open-source `ModelInfo` defines (`[{ effort, description }]`, see
 * https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs). The list is
 * the model's complete set, so every level it leaves out is unsupported.
 */
export function chatGptReasoning(
  entry: unknown,
): AdvertisedReasoning | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { supported_reasoning_levels: listed, default_reasoning_level } =
    entry as Record<string, unknown>;
  if (!Array.isArray(listed) || listed.length > maximumLevels) return undefined;
  const efforts = new Set<InferenceEffort>();
  for (const item of listed) {
    const value = (item as { effort?: unknown } | null)?.effort;
    // One malformed entry makes the whole list untrustworthy as the model's complete set.
    if (typeof value !== "string") return undefined;
    const effort = Object.hasOwn(chatGptValues, value)
      ? chatGptValues[value]
      : undefined;
    if (effort) efforts.add(effort);
  }
  const levels = Object.fromEntries(
    Object.entries(chatGptValues).map(([value, effort]) => [
      effort,
      efforts.has(effort) ? value : null,
    ]),
  );
  const defaultEffort =
    typeof default_reasoning_level === "string" &&
    Object.hasOwn(chatGptValues, default_reasoning_level)
      ? chatGptValues[default_reasoning_level]
      : undefined;
  return {
    levels,
    ...(defaultEffort && efforts.has(defaultEffort) ? { defaultEffort } : {}),
  };
}

// ===========================================
// Anthropic
// ===========================================

/** Anthropic effort levels sent unchanged as `output_config.effort`. */
const anthropicLevels = ["low", "medium", "high", "xhigh", "max"] as const;

/** A `CapabilitySupport` object's flag, or undefined when the value isn't one. */
function supportFlag(value: unknown): boolean | undefined {
  const supported = (value as { supported?: unknown } | null)?.supported;
  return typeof supported === "boolean" ? supported : undefined;
}

/**
 * Effort levels from one Claude model's `capabilities`
 * (https://platform.claude.com/docs/en/api/models/list), or undefined when they are missing,
 * malformed, or don't control this model: the runtime sends an effort only with adaptive thinking.
 * Minimal is sent as `low`, so it follows low's support. Off isn't covered, because the runtime
 * turns thinking off differently by model.
 */
export function anthropicReasoning(
  capabilities: unknown,
): AdvertisedReasoning | undefined {
  if (typeof capabilities !== "object" || capabilities === null)
    return undefined;
  const { effort, thinking } = capabilities as Record<string, unknown>;
  const adaptive = (thinking as { types?: { adaptive?: unknown } } | null)
    ?.types?.adaptive;
  if (supportFlag(effort) !== true || supportFlag(adaptive) !== true)
    return undefined;
  const levels: Partial<Record<InferenceEffort, string | null>> = {};
  for (const level of anthropicLevels) {
    const value = (effort as Record<string, unknown>)[level];
    // The API reports a null xhigh for models without that level.
    const supported =
      level === "xhigh" && value === null ? false : supportFlag(value);
    if (supported === undefined) return undefined;
    levels[level] = supported ? level : null;
  }
  return { levels: { minimal: levels.low ? "low" : null, ...levels } };
}
