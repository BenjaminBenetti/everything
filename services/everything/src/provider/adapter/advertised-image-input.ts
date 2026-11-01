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
 * OpenRouter's model-list architecture declares the complete input modality list:
 * https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
 * Compatible servers using that contract can advertise support without a catalog entry.
 * Do not apply this schema to SIWC, which documents no modality contract.
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
