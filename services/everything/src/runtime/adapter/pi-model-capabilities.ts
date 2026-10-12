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
} from "../../provider/interface/provider-models.js";
import type { RuntimeModelCatalog } from "../interface/inference-runtime.js";
import { compatibleModelMetadata } from "../model/compatible-model-metadata.js";

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

  /** Show only effort levels that Pi can apply, with a supported default. */
  describe(provider: ProviderId, model: DiscoveredModel): ProviderModel {
    const efforts = getSupportedThinkingLevels(
      this.resolve(provider, model.id, ""),
    );
    return {
      ...model,
      efforts,
      defaultEffort: efforts.includes("medium") ? "medium" : efforts[0]!,
    };
  }

  /** Bind catalog or local-model capabilities while retaining the endpoint's exact model identity. */
  resolve(provider: ProviderId, id: string, baseUrl: string): Model<Api> {
    const known =
      provider === "openai-compatible"
        ? compatibleModelMetadata(id, this.catalog.getModels())
        : this.catalog.getModel(
            provider === "chatgpt" ? "openai" : provider,
            id,
          );
    return {
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
      ...known,
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
