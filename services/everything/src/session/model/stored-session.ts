import type { OwnedEntity } from "@everything/persistence/entity";

/** Durable server session; neither token plaintext nor the browser capability is persisted. */
export interface StoredSession extends OwnedEntity {
  readonly tokenHash: string;
  readonly encryptedGrant: string;
  readonly expiresAt: Date;
}

/** Possession of a high-entropy cookie is the scope before identity is known. */
export interface SessionScope {
  readonly tokenHash: string;
}

/** Fixed upper bound; Keycloak's shorter refresh expiry still applies. */
export const sessionLifetimeMs = 8 * 60 * 60 * 1000;
export { sessionInputLimits } from "@everything/security/browser";
