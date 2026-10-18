import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderId } from "@everything/provider-contracts";
import type { ProviderModel } from "@everything/provider-contracts/inference";
import type {
  DiscoveredModel,
  ModelCapabilities,
  ModelLimits,
} from "../../provider/interface/provider-models.js";
import type { RuntimeModelCatalog } from "../interface/inference-runtime.js";
import { compatibleModelMetadata } from "../model/compatible-model-metadata.js";
import { fastModeModel } from "../model/fast-mode-support.js";

/** Limits assumed for a model that neither its server nor Pi's catalog describes. */
const unknownModelLimits = { contextWindow: 32768, maxTokens: 4096 } as const;

/**
 * Response room for a model whose server reports its context but no response cap: a quarter of the
 * context, at most 32,768 tokens, which leaves room for reasoning and long tool calls.
 */
function responseRoom(contextWindow: number): number {
  return Math.max(1, Math.min(32768, Math.floor(contextWindow / 4)));
}

/** Keep the model picker and execution on Pi's same capability definitions. */
export class PiModelCapabilities
  implements ModelCapabilities, RuntimeModelCatalog
{
  // ===========================================
  // Construction
  // ===========================================

  /** Use catalog metadata without global credentials or availability assumptions. */
  constructor(
    private readonly catalog: Pick<ModelRuntime, "getModel" | "getModels">,
  ) {}

  // ===========================================
  // Model projection
  // ===========================================

  /**
   * Show only effort levels that Pi can apply, with a supported default, and Fast mode only where
   * its provider documents it for this exact model.
   */
  describe(provider: ProviderId, model: DiscoveredModel): ProviderModel {
    const efforts = getSupportedThinkingLevels(
      this.resolve(provider, model.id, ""),
    );
    return {
      id: model.id,
      name: model.name,
      efforts,
      defaultEffort: efforts.includes("medium") ? "medium" : efforts[0]!,
      speeds: fastModeModel(provider, model.id)
        ? ["standard", "fast"]
        : ["standard"],
    };
  }

  /**
   * Bind catalog or local-model capabilities while retaining the endpoint's exact model identity.
   * Limits the provider reports win over the catalog, since a server may run a model with a smaller
   * or larger context than its maximum.
   */
  resolve(
    provider: ProviderId,
    id: string,
    baseUrl: string,
    limits: ModelLimits = {},
  ): Model<Api> {
    const known =
      provider === "openai-compatible"
        ? compatibleModelMetadata(id, this.catalog.getModels())
        : this.catalog.getModel(
            provider === "chatgpt" ? "openai" : provider,
            id,
          );
    const contextWindow =
      limits.contextWindow ??
      known?.contextWindow ??
      unknownModelLimits.contextWindow;
    const maxTokens = Math.min(
      contextWindow,
      limits.maxOutputTokens ??
        known?.maxTokens ??
        (limits.contextWindow !== undefined
          ? responseRoom(contextWindow)
          : unknownModelLimits.maxTokens),
    );
    return {
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...known,
      contextWindow,
      maxTokens,
      id,
      provider:
        provider === "chatgpt"
          ? "openai"
          : provider === "anthropic"
            ? "anthropic"
            : "everything-openai-compatible",
      api:
        provider === "anthropic"
          ? "anthropic-messages"
          : provider === "chatgpt"
            ? "openai-responses"
            : "openai-completions",
      baseUrl,
      ...(provider === "openai-compatible"
        ? {
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: known?.reasoning ?? false,
              maxTokensField: "max_tokens" as const,
            },
          }
        : {}),
    };
  }
}
