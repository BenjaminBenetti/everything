import type { AppApiClients } from "../interface/app-api-clients.js";
import type {
  CapabilityOwner,
  CapabilityProvider,
} from "../interface/artifact-capabilities.js";

/** The service endpoints apps reach over the cluster network. */
export interface EverythingApiEndpoints {
  readonly apiUrl: string;
  readonly tokenUrl: string;
}

/** Give an app its own client credentials for acting as its owner through the Everything API. */
export class EverythingApiCapability implements CapabilityProvider {
  readonly name = "everything-api";

  // ===========================================
  // Construction
  // ===========================================

  /** Keep client provisioning independent of Kubernetes credential storage. */
  constructor(
    private readonly clients: AppApiClients,
    private readonly endpoints: EverythingApiEndpoints,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Return the four reserved environment variables for this app's backend. */
  async ensure(
    owner: CapabilityOwner,
  ): Promise<Readonly<Record<string, string>>> {
    const client = await this.clients.ensure(owner.id, owner.ownerId);
    return {
      EVERYTHING_API_URL: this.endpoints.apiUrl,
      EVERYTHING_CLIENT_ID: client.clientId,
      EVERYTHING_CLIENT_SECRET: client.clientSecret,
      EVERYTHING_TOKEN_URL: this.endpoints.tokenUrl,
    };
  }

  /** Delete the client so it can no longer obtain access tokens. */
  async remove(appId: string): Promise<void> {
    await this.clients.remove(appId);
  }
}
