import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderId } from "@everything/provider-contracts";
import {
  inferenceEfforts,
  type EffortSource,
  type ProviderModel,
} from "@everything/provider-contracts/inference";
import type {
  AdvertisedReasoning,
  DiscoveredModel,
  ModelCapabilities,
  ModelMetadata,
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

/** Catalog capabilities for one model, and where its effort levels come from. */
interface KnownModel {
  readonly known: Partial<Model<Api>> | undefined;
  readonly effortSource: EffortSource;
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
   * Show only effort levels that Pi can apply, preferring the levels the provider lists for this
   * model, with a supported default, and Fast mode only where its provider documents it for this
   * exact model.
   */
  describe(provider: ProviderId, model: DiscoveredModel): ProviderModel {
    const { effortSource } = this.known(provider, model.id, model.reasoning);
    const efforts = getSupportedThinkingLevels(
      this.resolve(provider, model.id, "", model),
    );
    const advertised = model.reasoning?.defaultEffort;
    return {
      id: model.id,
      name: model.name,
      efforts,
      defaultEffort:
        effortSource === "provider" &&
        advertised &&
        efforts.includes(advertised)
          ? advertised
          : efforts.includes("medium")
            ? "medium"
            : efforts[0]!,
      effortSource,
      speeds: fastModeModel(provider, model.id)
        ? ["standard", "fast"]
        : ["standard"],
    };
  }

  /**
   * Bind catalog or local-model capabilities while retaining the endpoint's exact model identity.
   * Limits and effort levels the provider reports win over the catalog, since a server may run a
   * model with a smaller or larger context than its maximum, and an account's model list describes
   * the model it actually serves.
   */
  resolve(
    provider: ProviderId,
    id: string,
    baseUrl: string,
    limits: ModelMetadata = {},
  ): Model<Api> {
    const { known } = this.known(provider, id, limits.reasoning);
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

  // ===========================================
  // Effort support
  // ===========================================

  /** Catalog capabilities, replaced by the provider's own effort levels when it reports usable ones. */
  private known(
    provider: ProviderId,
    id: string,
    reasoning: AdvertisedReasoning | undefined,
  ): KnownModel {
    const catalog =
      provider === "openai-compatible"
        ? compatibleModelMetadata(id, this.catalog.getModels())
        : this.catalog.getModel(
            provider === "chatgpt" ? "openai" : provider,
            id,
          );
    const advertised =
      reasoning && advertisedModel(provider, catalog, reasoning);
    return advertised
      ? { known: advertised, effortSource: "provider" }
      : { known: catalog, effortSource: catalog ? "catalog" : "unknown" };
  }
}

/**
 * A model's capabilities with the provider's effort levels applied, or undefined when they can't
 * steer what the runtime sends. Claude models the catalog runs with token-budget thinking ignore
 * Anthropic's effort levels, which only apply with adaptive thinking. Levels the provider doesn't
 * cover keep the catalog's support, and are unsupported for a model the catalog doesn't know.
 */
function advertisedModel(
  provider: ProviderId,
  catalog: Partial<Model<Api>> | undefined,
  reasoning: AdvertisedReasoning,
): Partial<Model<Api>> | undefined {
  if (provider === "openai-compatible") return undefined;
  const compat = catalog?.compat as { forceAdaptiveThinking?: boolean };
  if (
    provider === "anthropic" &&
    catalog &&
    compat?.forceAdaptiveThinking !== true
  )
    return undefined;
  const thinkingLevelMap = Object.fromEntries(
    inferenceEfforts.map((level) => [
      level,
      Object.hasOwn(reasoning.levels, level)
        ? (reasoning.levels[level] ?? null)
        : catalog
          ? catalog.thinkingLevelMap?.[level]
          : null,
    ]),
  );
  const supported = Object.values(thinkingLevelMap).some(
    (value) => typeof value === "string",
  );
  return {
    ...catalog,
    // A model accepting none of the runtime's levels runs at the provider's default.
    reasoning: supported,
    thinkingLevelMap,
    ...(provider === "anthropic" && !catalog
      ? { compat: { forceAdaptiveThinking: true } }
      : {}),
  } as Partial<Model<Api>>;
}
