import type { AccessTokenSource } from "@everything/security/client-credentials";
import {
  everythingAppClaims,
  everythingAppClientId,
} from "@everything/artifact-contracts/everything-api";
import type {
  AppApiClient,
  AppApiClients,
} from "../interface/app-api-clients.js";

/** Endpoints and audience supplied by the composition root. */
export interface AppClientSettings {
  /** Realm Admin REST API URL, ending in `/admin/realms/<realm>`. */
  readonly adminUrl: string;
  readonly audience: string;
}

/** Fields used to verify that an existing client belongs to this provisioner and app. */
interface StoredClient {
  readonly id: string;
  readonly clientId: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

/** Provision confidential clients using only the artifact service's management credential. */
export class KeycloakAppApiClients implements AppApiClients {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject the management token source and HTTP transport; app credentials never receive admin roles. */
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly settings: AppClientSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Repair only our own client, retaining its secret across deployments and service restarts. */
  async ensure(appId: string, ownerId: string): Promise<AppApiClient> {
    if (!ownerId.trim()) throw new Error("An app client requires an owner");
    const clientId = everythingAppClientId(appId);
    let client = await this.find(clientId);
    if (!client) {
      await this.request(
        "",
        {
          method: "POST",
          body: JSON.stringify(this.definition(appId, ownerId)),
        },
        [409],
      );
      client = await this.find(clientId);
    }
    if (!client) throw new Error("The app client was not created");
    this.requireOwned(client, appId, ownerId);
    await this.request(`/${encodeURIComponent(client.id)}`, {
      method: "PUT",
      body: JSON.stringify(this.definition(appId, ownerId)),
    });
    const secret = (await (
      await this.request(`/${encodeURIComponent(client.id)}/client-secret`)
    ).json()) as { value?: unknown };
    if (typeof secret.value !== "string" || !secret.value)
      throw new Error("The identity provider returned no app client secret");
    return { clientId, clientSecret: secret.value };
  }

  /** Delete only a client carrying this app's provisioning marker; absence is idempotent. */
  async remove(appId: string): Promise<void> {
    const client = await this.find(everythingAppClientId(appId));
    if (!client) return;
    this.requireOwned(client, appId);
    await this.request(
      `/${encodeURIComponent(client.id)}`,
      { method: "DELETE" },
      [404],
    );
  }

  // ===========================================
  // Keycloak boundary
  // ===========================================

  /** Find an exact client ID; never adopt a partial match returned by the admin search endpoint. */
  private async find(clientId: string): Promise<StoredClient | undefined> {
    const response = await this.request(
      `?${new URLSearchParams({ clientId, search: "false" })}`,
    );
    const clients = (await response.json()) as StoredClient[];
    if (!Array.isArray(clients))
      throw new Error("The identity provider returned invalid clients");
    return clients.find((client) => client.clientId === clientId);
  }

  /** Refuse name collisions and attempts to change a client's owner. */
  private requireOwned(
    client: StoredClient,
    appId: string,
    ownerId?: string,
  ): void {
    if (
      !client.id ||
      client.attributes?.[everythingAppClaims.app] !== appId ||
      !client.attributes?.[everythingAppClaims.owner] ||
      (ownerId !== undefined &&
        client.attributes[everythingAppClaims.owner] !== ownerId)
    )
      throw new Error("The app client does not belong to this app and owner");
  }

  /** Use only client credentials, with signed owner claims and the Everything API audience. */
  private definition(appId: string, ownerId: string): Record<string, unknown> {
    return {
      clientId: everythingAppClientId(appId),
      name: `Everything app ${appId}`,
      enabled: true,
      protocol: "openid-connect",
      publicClient: false,
      clientAuthenticatorType: "client-secret",
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      fullScopeAllowed: false,
      redirectUris: [],
      webOrigins: [],
      defaultClientScopes: ["basic"],
      optionalClientScopes: [],
      attributes: {
        [everythingAppClaims.app]: appId,
        [everythingAppClaims.owner]: ownerId,
        "access.token.lifespan": "300",
        "client_credentials.use_refresh_token": "false",
      },
      protocolMappers: [
        {
          name: "Everything API audience",
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          config: {
            "included.custom.audience": this.settings.audience,
            "access.token.claim": "true",
            "id.token.claim": "false",
          },
        },
        ...Object.entries({
          [everythingAppClaims.app]: appId,
          [everythingAppClaims.owner]: ownerId,
        }).map(([name, value]) => ({
          name,
          protocol: "openid-connect",
          protocolMapper: "oidc-hardcoded-claim-mapper",
          config: {
            "claim.name": name,
            "claim.value": value,
            "jsonType.label": "String",
            "access.token.claim": "true",
            "id.token.claim": "false",
            "userinfo.token.claim": "false",
          },
        })),
      ],
    };
  }

  /** Bound every request and report only HTTP status, never tokens, credentials, or provider bodies. */
  private async request(
    path: string,
    init: RequestInit = {},
    accepted: readonly number[] = [],
  ): Promise<Response> {
    const response = await this.fetcher(
      `${this.settings.adminUrl}/clients${path}`,
      {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${await this.tokens.token()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
    );
    if (!response.ok && !accepted.includes(response.status))
      throw new Error(
        `The identity provider refused app client provisioning (${response.status})`,
      );
    return response;
  }
}
