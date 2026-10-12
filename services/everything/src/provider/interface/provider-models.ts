import type { ProviderId } from "@everything/provider-contracts";
import type {
  InferenceSelection,
  ProviderModel,
} from "@everything/provider-contracts/inference";
import type { VerificationInput } from "./connection-verifier.js";

/** Account-specific model choices and selection validation. */
export interface ProviderModels {
  /** Discover models using the authenticated owner's active connection. */
  list(ownerId: string, provider: ProviderId): Promise<ProviderModel[]>;
  /** Reject models and efforts outside the owner's available catalog. */
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

/** Provider-advertised model identity and limits, independent of runtime implementation. */
export interface DiscoveredModel extends ModelLimits {
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
  /** Describe only effort settings the runtime can apply to this model. */
  describe(provider: ProviderId, model: DiscoveredModel): ProviderModel;
}
