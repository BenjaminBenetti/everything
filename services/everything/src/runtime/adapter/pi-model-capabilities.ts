import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
} from "@earendil-works/pi-ai";
import type { ProviderId } from "@everything/provider-contracts";
import {
  inferenceEfforts,
  type ProviderModel,
  type EffectiveModel,
} from "@everything/provider-contracts/inference";
import type {
  AdvertisedReasoning,
  DiscoveredModel,
  ModelCapabilities,
  ModelMetadata,
  ModelResolution,
} from "../../provider/interface/provider-models.js";
import { modelTokenLimit } from "../../provider/model/model-token-limit.js";
import type { RuntimeModelCatalog } from "../interface/inference-runtime.js";
import { offeredSpeeds } from "../model/speed-support.js";

/**
 * Planning limits only when the provider reports no valid value. The decimal 200,000-token context
 * is an unknown-model fallback, not a provider guarantee or floor.
 */
const unknownModelLimits = { contextWindow: 200000, maxTokens: 4096 } as const;

/**
 * Response room for a model whose server reports its context but no response cap: a quarter of the
 * context, at most 32,768 tokens, which leaves room for reasoning and long tool calls.
 */
function responseRoom(contextWindow: number): number {
  return Math.max(1, Math.min(32768, Math.floor(contextWindow / 4)));
}

// ===========================================
// Provider transports
// ===========================================

/** How Pi reaches one provider, the same for every model the provider serves. */
interface Transport {
  readonly provider: string;
  readonly api: Api;
  readonly compat: NonNullable<Model<Api>["compat"]>;
}

/**
 * Each provider's request protocol, chosen by the connection and never by the model.
 * - ChatGPT sign-in uses the public Responses API, which treats a function tool sent without
 *   `strict` as strict when it can, making every optional field required
 *   (https://developers.openai.com/api/docs/guides/function-calling). Pi writes `strict: false`
 *   only when `supportsStrictMode` is set, so it is set for every model.
 * - Claude uses the Messages API. Effort is sent only with adaptive thinking, where the model list
 *   reports it; Pi's token-budget thinking and managed-effort mode are never chosen.
 * - OpenAI-compatible servers get Chat Completions without OpenAI-only fields. No effort is sent,
 *   because compatible model lists have no effort contract.
 */
const transports: Readonly<Record<ProviderId, Transport>> = {
  chatgpt: {
    provider: "openai",
    api: "openai-responses",
    compat: { supportsStrictMode: true } satisfies OpenAIResponsesCompat,
  },
  anthropic: {
    provider: "anthropic",
    api: "anthropic-messages",
    compat: { forceAdaptiveThinking: true },
  },
  "openai-compatible": {
    provider: "everything-openai-compatible",
    api: "openai-completions",
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    } satisfies OpenAICompletionsCompat,
  },
};

// ===========================================
// Effort support
// ===========================================

/**
 * Pi's thinking switch and level map for exactly the levels the provider reports. Every level is
 * listed, so one the provider doesn't report is unsupported instead of falling to Pi's defaults,
 * which treat unlisted levels as supported. A model reporting no usable level, or nothing at all,
 * runs at the provider's default with no effort sent.
 */
function reportedEfforts(
  reasoning: AdvertisedReasoning | undefined,
): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  const thinkingLevelMap = Object.fromEntries(
    inferenceEfforts.map((level) => [
      level,
      reasoning && Object.hasOwn(reasoning.levels, level)
        ? (reasoning.levels[level] ?? null)
        : null,
    ]),
  );
  return {
    reasoning: Object.values(thinkingLevelMap).some(
      (value) => typeof value === "string",
    ),
    thinkingLevelMap,
  };
}

/** The effort levels a provider reports; compatible model lists have no effort contract. */
function providerReasoning(
  provider: ProviderId,
  metadata: ModelMetadata,
): AdvertisedReasoning | undefined {
  return provider === "openai-compatible" ? undefined : metadata.reasoning;
}

// ===========================================
// Capabilities
// ===========================================

/**
 * Describe and run each model from what its provider reports for the owner's account, over its
 * provider's transport. The model's ID is passed through as its identity and never decides what it
 * supports, so a new or renamed model reporting the same metadata is offered and sent the same.
 */
export class PiModelCapabilities
  implements ModelCapabilities, RuntimeModelCatalog, ModelResolution
{
  // ===========================================
  // Model projection
  // ===========================================

  /** Project exactly the resolution used to build a runtime, without creating a session. */
  effective(provider: ProviderId, model: DiscoveredModel): EffectiveModel {
    return this.resolve(provider, model.id, "", model).resolution;
  }

  /**
   * Offer exactly the effort levels the provider reports, with its default when it is one of them,
   * and only the paid speeds its model list offers. A model reporting no levels offers only the
   * provider's default effort.
   */
  describe(provider: ProviderId, model: DiscoveredModel): ProviderModel {
    const efforts = getSupportedThinkingLevels(
      this.resolve(provider, model.id, "", model),
    );
    const reasoning = providerReasoning(provider, model);
    const advertised = reasoning?.defaultEffort;
    return {
      id: model.id,
      name: model.name,
      efforts,
      defaultEffort:
        advertised && efforts.includes(advertised)
          ? advertised
          : efforts.includes("medium")
            ? "medium"
            : efforts[0]!,
      effortSource: reasoning ? "provider" : "unknown",
      speeds: offeredSpeeds(provider, model),
    };
  }

  /**
   * Bind the provider's reported limits, image input, and effort levels to its transport, keeping
   * the endpoint's exact model identity. Valid provider limits win, even when smaller than the
   * fallback, and only unknown limits use it. Images are sent only where the provider reports them.
   */
  resolve(
    provider: ProviderId,
    id: string,
    baseUrl: string,
    metadata: ModelMetadata = {},
  ): Model<Api> & { readonly resolution: EffectiveModel } {
    const advertisedContext = modelTokenLimit(metadata.contextWindow);
    const contextWindow = advertisedContext ?? unknownModelLimits.contextWindow;
    const imageInput =
      typeof metadata.imageInput === "boolean" ? metadata.imageInput : null;
    const maxTokens = Math.min(
      contextWindow,
      modelTokenLimit(metadata.maxOutputTokens) ??
        (advertisedContext !== undefined
          ? responseRoom(contextWindow)
          : unknownModelLimits.maxTokens),
    );
    const transport = transports[provider];
    return {
      id,
      name: id,
      provider: transport.provider,
      api: transport.api,
      baseUrl,
      ...reportedEfforts(providerReasoning(provider, metadata)),
      input: imageInput === true ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      compat: transport.compat,
      resolution: {
        provider,
        model: id,
        contextWindow,
        contextSource:
          advertisedContext !== undefined ? "provider" : "fallback",
        imageInput,
        imageSource: imageInput !== null ? "provider" : "unknown",
      },
    };
  }
}
