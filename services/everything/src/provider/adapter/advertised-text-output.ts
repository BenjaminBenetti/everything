/** Most output modalities accepted for one model, so a malformed list can't grow without bound. */
const maximumModalities = 16;

/**
 * Whether a compatible model writes text, from the complete output modality list OpenRouter's
 * model list declares in `architecture.output_modalities`
 * (https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), or
 * undefined when the entry has no such list or it is malformed. False means the provider says the
 * model can't write a teammate's replies, such as an image or embedding model; undefined means the
 * server didn't say, and a model's name is never taken as an answer.
 */
export function compatibleTextOutput(entry: unknown): boolean | undefined {
  const modalities = (
    entry as { architecture?: { output_modalities?: unknown } } | null
  )?.architecture?.output_modalities;
  if (
    !Array.isArray(modalities) ||
    modalities.length === 0 ||
    modalities.length > maximumModalities ||
    !modalities.every((item) => typeof item === "string" && item.length > 0)
  )
    return undefined;
  return modalities.includes("text");
}
