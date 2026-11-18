/** Read one documented Anthropic capability flag; absent or malformed is unknown. */
export function anthropicImageInput(
  capabilities: unknown,
): boolean | undefined {
  const flag = (
    capabilities as { image_input?: { supported?: unknown } } | null
  )?.image_input?.supported;
  return typeof flag === "boolean" ? flag : undefined;
}

/**
 * Image input from one ChatGPT model-list entry, or undefined when it reports none. The sign-in
 * model list documents only `slug`, `display_name`, and `visibility`
 * (https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference); this reads
 * the optional `input_modalities` only when present, in the shape Codex's open-source `ModelInfo`
 * defines (lowercase `text`, `image`, and `audio`, see
 * https://github.com/openai/codex/blob/345f166d01fda88e6e723afbbfdce2efde843f74/codex-rs/protocol/src/openai_models.rs).
 * Codex assumes text and image when the field is missing; here a missing or malformed list stays
 * unknown, so it never grants image input.
 */
export function chatGptImageInput(entry: unknown): boolean | undefined {
  const modalities = (entry as { input_modalities?: unknown } | null)
    ?.input_modalities;
  if (
    !Array.isArray(modalities) ||
    modalities.length > 16 ||
    !modalities.includes("text") ||
    !modalities.every(
      (item) =>
        typeof item === "string" && ["text", "image", "audio"].includes(item),
    )
  )
    return undefined;
  return modalities.includes("image");
}

/**
 * OpenRouter's model-list architecture declares the complete input modality list:
 * https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
 * Compatible servers using that contract can advertise support for any model they serve.
 * ChatGPT sign-in entries are read only in Codex's shape above.
 */
export function compatibleImageInput(entry: unknown): boolean | undefined {
  const modalities = (
    entry as { architecture?: { input_modalities?: unknown } } | null
  )?.architecture?.input_modalities;
  if (
    !Array.isArray(modalities) ||
    modalities.length === 0 ||
    modalities.length > 16 ||
    !modalities.every(
      (item) =>
        typeof item === "string" &&
        ["text", "image", "audio", "file"].includes(item),
    )
  )
    return undefined;
  return modalities.includes("image");
}
