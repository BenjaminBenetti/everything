import { createHash } from "node:crypto";
import type { OwnedEntity } from "@everything/persistence/entity";

/** How long a view link stays usable. */
export const grantLifetimeMs = 2 * 60 * 1000;

/** How long a viewer stays signed in to the artifact host. */
export const viewSessionLifetimeMs = 12 * 60 * 60 * 1000;

/** How long a teammate's pass to one artifact stays usable. */
export const viewPassLifetimeMs = 10 * 60 * 1000;

/**
 * Prefix of every teammate pass, so the artifact host recognizes its own bearer tokens and leaves
 * an artifact's own `Authorization` headers alone.
 */
export const viewPassPrefix = "everything_view_";

/** Artifact host path that stores a teammate pass in a browser cookie, then opens its artifact. */
export const viewPassSignInPath = "/_teammate-access";

/** A path inside an artifact, optionally with a query, that cannot leave the artifact host. */
export const artifactPathPattern = /^\/(?!\/)[^\\\s]*$/;

/** Hash a view secret for storage and lookup; secrets themselves are never stored. */
export function credentialHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

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

/** A teammate's short-lived pass to view one of the owner's artifacts from inside the cluster. */
export interface ViewPass extends OwnedEntity {
  readonly artifactId: string;
  /** SHA-256 of the pass; the pass itself is never stored. */
  readonly tokenHash: string;
  /** Path inside the artifact that the pass's browser link opens, such as `/docs/`. */
  readonly path: string;
  readonly expiresAt: string;
}

/** Who a request views artifacts as: the owner, limited to one artifact for a teammate pass. */
export interface ArtifactViewer {
  readonly ownerId: string;
  /** The only artifact a teammate pass opens, or null for every artifact of the owner. */
  readonly artifactId: string | null;
}
