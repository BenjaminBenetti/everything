import type {
  ApiKeyProviderId,
  ProviderAuthorization,
  ProviderConnection,
  ProviderDisconnection,
  ProviderId,
  SaveProviderInput,
} from "@everything/provider-contracts";
import type { ProviderModel } from "@everything/provider-contracts/inference";

/** Browser capabilities reveal only safe connection metadata. */
export interface ProviderConnections {
  /** List models and supported efforts for one active connection. */
  models(provider: ProviderId, signal?: AbortSignal): Promise<ProviderModel[]>;
  /** Read saved status without performing inference. */
  list(signal?: AbortSignal): Promise<ProviderConnection[]>;
  /** Save a write-only API key and check it. */
  save(
    provider: ApiKeyProviderId,
    input: SaveProviderInput,
  ): Promise<ProviderConnection>;
  /** Recheck saved credentials. */
  verify(provider: ProviderId): Promise<ProviderConnection>;
  /** Remove a saved connection. */
  disconnect(provider: ProviderId): Promise<ProviderDisconnection>;
  /** Start a ChatGPT sign-in bound to the current user. */
  authorize(): Promise<ProviderAuthorization>;
  /** Complete ChatGPT sign-in using the returned callback address. */
  complete(callback: string): Promise<ProviderConnection>;
}
