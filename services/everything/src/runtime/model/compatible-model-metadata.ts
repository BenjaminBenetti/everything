import type { Api, Model } from "@earendil-works/pi-ai";

// ===========================================
// Supplemental model capabilities
// ===========================================

/**
 * The open-weight Flash Next model is missing from Pi's bundled catalog.
 * Its published template accepts low, medium and xhigh; omitting the effort
 * preserves the server default, including for existing saved selections.
 * https://huggingface.co/Qwen/Qwen3.8-Flash-Next#api-usage
 */
const qwenFlashNextReasoning = {
  reasoning: true,
  thinkingLevelMap: {
    minimal: null,
    low: "low",
    medium: "medium",
    high: null,
    xhigh: "xhigh",
    max: null,
  },
} satisfies Pick<Model<Api>, "reasoning" | "thinkingLevelMap">;

// ===========================================
// Compatible model lookup
// ===========================================

/** Match catalog identities and local quantizations without changing the server's model ID. */
export function compatibleModelMetadata(
  id: string,
  models: readonly Model<Api>[],
): Partial<Model<Api>> | undefined {
  const identity = modelIdentity(id);
  const exact = models.find((model) => model.id === id);
  const aliases = models.filter(
    (model) => modelIdentity(model.id) === identity,
  );
  // Gateway copies can omit effort restrictions that the original catalog entry supplies.
  const known =
    exact?.thinkingLevelMap || exact?.reasoning === false
      ? exact
      : (aliases.find((model) => model.thinkingLevelMap) ??
        exact ??
        aliases[0]);
  return identity === "qwen3.8-flash-next"
    ? { ...known, ...qwenFlashNextReasoning }
    : known;
}

/** Remove packaging details only; retain model sizes, versions and instruction variants. */
function modelIdentity(id: string): string {
  return id
    .split("/")
    .at(-1)!
    .toLowerCase()
    .replace(/\.gguf$/, "")
    .replace(/-\d{5}-of-\d{5}$/, "")
    .replace(/[-:](?:ud-)?(?:i?q\d[\w.-]*|bf16|f16|f32)$/, "")
    .replace(/-unsloth$/, "")
    .replace(/-gguf$/, "");
}
