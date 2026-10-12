import type { OwnedEntity } from "@everything/persistence/entity";
import type { ProviderId } from "@everything/provider-contracts";

/** Durable owner-scoped connection metadata and encrypted credentials. */
export interface StoredProvider extends OwnedEntity {
  readonly provider: ProviderId;
  readonly configured: boolean;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly account: string | null;
  readonly encryptedCredential: string;
  readonly encryptedPending: string | null;
  readonly verifiedAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly verificationError: string | null;
}

/** Secret material never included in a public connection response. */
export interface ProviderCredential {
  readonly apiKey?: string;
  readonly hostId?: string;
  readonly clientId?: string;
  readonly subject?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
}

/** The full OAuth attempt survives a process restart, encrypted at rest. */
export interface PendingAuthorization {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly expiresAt: number;
}
