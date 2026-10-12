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
}

/** Provider-advertised model identity, independent of runtime implementation. */
export interface DiscoveredModel {
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
