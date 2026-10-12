import type { ModelLimits } from "../interface/provider-models.js";

/** Largest token count accepted from a provider, so a malformed value can't produce absurd limits. */
const maximumTokens = 100_000_000;

/**
 * Where model lists report the context a model runs with, preferring the running size over the
 * model's maximum. llama.cpp's `meta.n_ctx_train` is left out on purpose: it is the context the
 * model was trained with, which the running server may not provide.
 */
const contextPaths = [
  // llama.cpp-style servers that list the running context.
  ["meta", "n_ctx"],
  // LM Studio, for the loaded model.
  ["loaded_context_length"],
  // vLLM.
  ["max_model_len"],
  // Groq.
  ["context_window"],
  // OpenRouter, for the provider that serves the request.
  ["top_provider", "context_length"],
  // OpenRouter, Together, and Fireworks.
  ["context_length"],
  // LM Studio and Mistral.
  ["max_context_length"],
  // DeepInfra.
  ["metadata", "context_length"],
] as const;

/** Where model lists report the most tokens one response may generate. */
const outputPaths = [
  // OpenRouter.
  ["top_provider", "max_completion_tokens"],
  // Groq.
  ["max_completion_tokens"],
  ["max_output_tokens"],
] as const;

/** A positive whole token count at `path` in a provider's JSON, if one is there. */
function tokens(source: unknown, path: readonly string[]): number | undefined {
  let value = source;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= maximumTokens
    ? value
    : undefined;
}

/** Limits from whichever of `paths` comes first in `source`. */
function limits(
  source: unknown,
  context: readonly (readonly string[])[],
  output: readonly (readonly string[])[],
): ModelLimits {
  const contextWindow = context
    .map((path) => tokens(source, path))
    .find((value) => value !== undefined);
  const maxOutputTokens = output
    .map((path) => tokens(source, path))
    .find((value) => value !== undefined);
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

/** Limits a model-list entry reports, under any of the field names common servers use. */
export function advertisedLimits(entry: unknown): ModelLimits {
  return limits(entry, contextPaths, outputPaths);
}

/**
 * Limits from a llama.cpp server's `/props`: the context each request runs with, and the response
 * cap when one is set (`n_predict` is -1 when responses are unlimited).
 */
export function serverPropsLimits(props: unknown): ModelLimits {
  return limits(
    props,
    [["default_generation_settings", "n_ctx"]],
    [["default_generation_settings", "params", "n_predict"]],
  );
}
