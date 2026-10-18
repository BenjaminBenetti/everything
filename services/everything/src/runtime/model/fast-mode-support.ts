import type { ProviderId } from "@everything/provider-contracts";

/** What a model needs, beyond the provider's Fast request field, to request Fast mode. */
export interface FastModeModel {
  /** Beta feature the provider requires on Fast requests for this model, if any. */
  readonly beta?: string;
}

// ===========================================
// Documented support
// ===========================================

/**
 * Models whose provider documents Fast mode on the endpoint this application calls, checked
 * 2026-10-17. Only exact model IDs are listed: a new model, dated snapshot, or near-miss ID stays
 * unsupported until its provider documents it. Effort, model choice, flex, batch, and Ultrafast are
 * separate settings and are not Fast mode.
 *
 * ChatGPT sign-in sends `service_tier` to the public Responses API.
 * - https://learn.chatgpt.com/docs/agent-configuration/speed names GPT-6.1 Sol, GPT-6 Astra,
 *   GPT-6 Sol, GPT-6 Luna, and GPT-5.6 for ChatGPT sign-in.
 * - https://developers.openai.com/api/docs/pricing?latest-pricing=fast lists their exact slugs.
 * - https://developers.openai.com/api/docs/guides/fast-mode documents `fast` and its `priority`
 *   alias, and downgrades reported as `default`.
 * - https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery notes a
 *   plan may still reject a service-tier override.
 *
 * Anthropic sends `speed` to the Messages API.
 * - https://platform.claude.com/docs/en/build-with-claude/fast-mode makes Fast generally
 *   available on Claude Opus 5.5 and a research preview, which needs a beta and account access,
 *   on Claude Opus 5 and Claude Opus 4.8. Claude Opus 4.6 accepts the request but runs at standard
 *   speed, so it is not listed.
 *
 * OpenAI-compatible servers have no documented Fast contract.
 */
const fastModeModels: Readonly<
  Partial<Record<ProviderId, Readonly<Record<string, FastModeModel>>>>
> = {
  chatgpt: {
    "gpt-6.1-sol": {},
    "gpt-6-astra": {},
    "gpt-6-sol": {},
    "gpt-6-luna": {},
    "gpt-5.6-sol": {},
    "gpt-5.6-terra": {},
    "gpt-5.6-luna": {},
  },
  anthropic: {
    "claude-opus-5-5": {},
    "claude-opus-5": { beta: "fast-mode-2026-02-01" },
    "claude-opus-4-8": { beta: "fast-mode-2026-02-01" },
  },
};

// ===========================================
// Lookup
// ===========================================

/** Fast mode requirements for exactly this provider and model, or undefined when unsupported. */
export function fastModeModel(
  provider: ProviderId,
  id: string,
): FastModeModel | undefined {
  const models = fastModeModels[provider];
  return models && Object.hasOwn(models, id) ? models[id] : undefined;
}
