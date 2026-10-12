import type {
  ApiKeyProviderId,
  ProviderAuthorization,
  ProviderConnection,
  ProviderDisconnection,
  ProviderId,
  SaveProviderInput,
} from "@everything/provider-contracts";
import type { ProviderModel } from "@everything/provider-contracts/inference";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { ProviderConnections } from "../interface/provider-connections.js";

/** Adapt connection capabilities to the same-origin authenticated API. */
export class HttpProviderConnections implements ProviderConnections {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive authentication and transport policy from the composition root. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Connection operations
  // ===========================================

  /** Discover choices using saved credentials without returning them to the browser. */
  async models(
    provider: ProviderId,
    signal?: AbortSignal,
  ): Promise<ProviderModel[]> {
    return (
      await this.transport.request<{ models: ProviderModel[] }>(
        `/v1/providers/${provider}/models`,
        signal ? { signal } : {},
      )
    ).models;
  }

  /** Return public metadata only. */
  async list(signal?: AbortSignal): Promise<ProviderConnection[]> {
    return (
      await this.transport.request<{ providers: ProviderConnection[] }>(
        "/v1/providers",
        signal ? { signal } : {},
      )
    ).providers;
  }
  /** Submit a secret once; it is never read back into a field. */
  save(
    provider: ApiKeyProviderId,
    input: SaveProviderInput,
  ): Promise<ProviderConnection> {
    return this.transport.request("/v1/providers/" + provider, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  /** Run an explicit check with saved credentials. */
  verify(provider: ProviderId): Promise<ProviderConnection> {
    return this.transport.request("/v1/providers/" + provider + "/verify", {
      method: "POST",
    });
  }
  /** Remove this owner's connection. */
  disconnect(provider: ProviderId): Promise<ProviderDisconnection> {
    return this.transport.request("/v1/providers/" + provider, {
      method: "DELETE",
    });
  }

  // ===========================================
  // ChatGPT authorization
  // ===========================================

  /** Receive the authorization link without receiving tokens. */
  authorize(): Promise<ProviderAuthorization> {
    return this.transport.request("/v1/providers/chatgpt/authorize", {
      method: "POST",
    });
  }
  /** Keep the authorization code in a protected request body. */
  complete(callback: string): Promise<ProviderConnection> {
    return this.transport.request("/v1/providers/chatgpt/complete", {
      method: "POST",
      body: JSON.stringify({ callback }),
    });
  }
}
