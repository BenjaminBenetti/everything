import type { OwnedEntity } from "@everything/persistence/entity";

/** How long a view link stays usable. */
export const grantLifetimeMs = 2 * 60 * 1000;

/** How long a viewer stays signed in to the artifact host. */
export const viewSessionLifetimeMs = 12 * 60 * 60 * 1000;

/** A one-time link that signs the viewer in to the artifact host and opens one artifact path. */
export interface ViewGrant extends OwnedEntity {
  /** SHA-256 of the code in the link; the code itself is never stored. */
  readonly tokenHash: string;
  /** Path on the artifact host to open after signing in, such as `/report/`. */
  readonly next: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

/** A viewer signed in to the artifact host by a view link. */
export interface ViewSession extends OwnedEntity {
  /** SHA-256 of the session cookie's value. */
  readonly tokenHash: string;
  readonly expiresAt: string;
}
