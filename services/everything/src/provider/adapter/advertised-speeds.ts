import type {
  AdvertisedSpeeds,
  PaidSpeed,
} from "../interface/provider-models.js";

/** Most tier entries accepted for one model, so a malformed list can't grow without bound. */
const maximumTiers = 32;

/** Paid speeds in the order the model picker lists them. */
const paidSpeeds = [
  "fast",
  "ultrafast",
] as const satisfies readonly PaidSpeed[];

/**
 * Paid speeds by the tier IDs Codex's model metadata uses for them: `priority`, which `fast`
 * aliases, and `ultrafast`. Other tiers, such as `flex`, are not speeds the runtime offers.
 */
const chatGptTiers: Readonly<Record<string, PaidSpeed>> = {
  priority: "fast",
  fast: "fast",
  ultrafast: "ultrafast",
};

/**
 * Paid speeds from one ChatGPT model-list entry, or undefined when it reports none that are usable.
 * The sign-in model list documents only `slug`, `display_name`, and `visibility`
 * (https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference); this reads
 * two optional fields only when present, in the shape Codex's open-source `ModelInfo` defines (see
 * https://github.com/openai/codex/blob/345f166d01fda88e6e723afbbfdce2efde843f74/codex-rs/protocol/src/openai_models.rs):
 * - `service_tiers` (`[{ id, name, description }]`) lists the tiers the model can run with, so a
 *   well-formed list, even an empty one, is its complete set. Only each `id` is read.
 * - The deprecated `additional_speed_tiers` can name only `fast`. It is read only when
 *   `service_tiers` is absent or malformed, and only to offer Fast, so leaving `fast` out denies
 *   nothing.
 *
 * A listed `default_service_tier` is ignored: standard sends no tier, so no paid speed is a default.
 */
export function chatGptSpeeds(entry: unknown): AdvertisedSpeeds | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { service_tiers: tiers, additional_speed_tiers: legacy } =
    entry as Record<string, unknown>;
  const listed = tierSpeeds(tiers);
  if (listed) return { offered: listed, complete: true };
  return Array.isArray(legacy) &&
    legacy.length <= maximumTiers &&
    legacy.every((tier) => typeof tier === "string") &&
    legacy.includes("fast")
    ? { offered: ["fast"], complete: false }
    : undefined;
}

/** The paid speeds a `service_tiers` list names, or undefined when it is absent or malformed. */
function tierSpeeds(tiers: unknown): PaidSpeed[] | undefined {
  if (!Array.isArray(tiers) || tiers.length > maximumTiers) return undefined;
  const offered = new Set<PaidSpeed>();
  for (const tier of tiers) {
    const id = (tier as { id?: unknown } | null)?.id;
    // One malformed entry makes the whole list untrustworthy as the model's complete set.
    if (typeof id !== "string") return undefined;
    const speed = Object.hasOwn(chatGptTiers, id)
      ? chatGptTiers[id]
      : undefined;
    if (speed) offered.add(speed);
  }
  return paidSpeeds.filter((speed) => offered.has(speed));
}
