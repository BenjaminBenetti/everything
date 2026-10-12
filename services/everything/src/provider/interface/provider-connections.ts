import type {
  ApiKeyProviderId,
  ProviderAuthorization,
  ProviderConnection,
  ProviderDisconnection,
  ProviderId,
  SaveProviderInput,
} from "@everything/provider-contracts";

/** Owner-scoped provider settings exposed independently of teammate execution. */
export interface ProviderConnections {
  /** Return safe metadata for all supported choices. */
  list(ownerId: string): Promise<ProviderConnection[]>;
  /** Persist settings and run a real provider check. */
  save(
    ownerId: string,
    provider: ApiKeyProviderId,
    input: SaveProviderInput,
  ): Promise<ProviderConnection>;
  /** Check saved credentials without resubmitting them through the browser. */
  verify(ownerId: string, provider: ProviderId): Promise<ProviderConnection>;
  /** Remove credentials and cancel any pending authorization. */
  disconnect(
    ownerId: string,
    provider: ProviderId,
  ): Promise<ProviderDisconnection>;
  /** Save an OAuth attempt before opening ChatGPT. */
  authorize(ownerId: string): Promise<ProviderAuthorization>;
  /** Complete the owner's pending authorization and verify plan access. */
  complete(ownerId: string, callback: string): Promise<ProviderConnection>;
}
