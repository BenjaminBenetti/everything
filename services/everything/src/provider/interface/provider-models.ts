import type { ProviderId } from "@everything/provider-contracts";
import type {
  InferenceEffort,
  InferenceSelection,
  ProviderModel,
} from "@everything/provider-contracts/inference";
import type { VerificationInput } from "./connection-verifier.js";

/** Account-specific model choices and selection validation. */
export interface ProviderModels {
  /** Discover models using the authenticated owner's active connection. */
  list(ownerId: string, provider: ProviderId): Promise<ProviderModel[]>;
  /** Reject models, efforts, and speeds outside the owner's available catalog. */
  validate(ownerId: string, selection: InferenceSelection): Promise<void>;
  /** Validate a selection and return its model as discovered, with any limits its provider reports. */
  select(
    ownerId: string,
    selection: InferenceSelection,
  ): Promise<DiscoveredModel>;
}

/** Token limits a provider reports for one of its models; absent values are unknown. */
export interface ModelLimits {
  /** Tokens one request may hold, prompt and response together, as the server runs the model. */
  readonly contextWindow?: number;
  /** Most tokens one response may generate, reasoning included. */
  readonly maxOutputTokens?: number;
}

/**
 * Effort levels a provider's model list reports for one model. Only levels its metadata covers are
 * present; the runtime knows nothing more about the rest.
 */
export interface AdvertisedReasoning {
  /** The provider's value to send for each covered level, or null where the model rejects it. */
  readonly levels: Readonly<Partial<Record<InferenceEffort, string | null>>>;
  /** The provider's default level, present only when the model accepts it. */
  readonly defaultEffort?: InferenceEffort;
}

/** What a provider reports about one model beyond its identity; absent values are unknown. */
export interface ModelMetadata extends ModelLimits {
  /** Effort support from the provider's own model list, when it reports any usable metadata. */
  readonly reasoning?: AdvertisedReasoning;
}

/** Provider-advertised model identity, limits, and effort support, independent of runtime implementation. */
export interface DiscoveredModel extends ModelMetadata {
  readonly id: string;
  readonly name: string;
}

/** Account-aware model discovery performs no inference. */
export interface ProviderModelDiscovery {
  /** List only the models exposed by this connection. */
  discover(
    provider: ProviderId,
    connection: VerificationInput,
  ): Promise<DiscoveredModel[]>;
}

/** Runtime-specific supported settings projected to a safe public contract. */
export interface ModelCapabilities {
  /** Describe only effort and speed settings the runtime can apply to this model. */
  describe(provider: ProviderId, model: DiscoveredModel): ProviderModel;
}
