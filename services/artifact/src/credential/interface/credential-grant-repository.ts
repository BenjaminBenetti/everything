import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type {
  CredentialBinding,
  CredentialRecord,
  NewCredentialBinding,
} from "../model/credential-binding.js";

/** A change to one app's grants, and the generation the grants it adds were authorized against. */
export interface GrantChange {
  readonly bindings: readonly NewCredentialBinding[];
  /** Required when the change adds a grant the app doesn't hold exactly. */
  readonly expectedGeneration: number | undefined;
}

/** Every app's grants of one credential, across owners, for delivering or revoking it. */
export interface CredentialScope {
  readonly credentialId: string;
}

/** Every grant, for the inventory Everything synchronizes against. */
export interface InventoryScope {
  readonly inventory: true;
}

/** One app's grants, one owner's, one credential's, or all of them for system work. */
export type CredentialGrantScope =
  WithinArtifactScope | OwnerScope | CredentialScope | InventoryScope;

/** Whether a delivered version became the credential's newest. */
export type VersionOutcome = "current" | "superseded" | "conflict";

/**
 * Persistence of credential grants and of each credential's record. Changes that add access are
 * checked against the record in the same serializable transaction that revocation writes it in,
 * so a grant and a revocation can never both succeed out of order.
 */
export interface CredentialGrantRepository extends Repository<
  CredentialBinding,
  CredentialGrantScope
> {
  /**
   * Make these the app's grants and return its new generation. Grants not already held exactly are
   * refused when the app's generation moved on since they were authorized, when their credential was
   * revoked, when a newer version was delivered, or when their version was already delivered with a
   * different value. Unchanged and removed grants are never refused; any change advances the
   * generation.
   */
  replace(scope: WithinArtifactScope, change: GrantChange): Promise<number>;
  /**
   * Record a delivered version and its value's identity. A revoked credential is refused, an older
   * version is superseded, and a different value at the newest version is a conflict.
   */
  recordVersion(
    credentialId: string,
    version: number,
    valueId: string,
  ): Promise<VersionOutcome>;
  /** Raise the app's grants of a credential to a delivered version whose value is stored. */
  advance(
    scope: WithinArtifactScope,
    credentialId: string,
    version: number,
    valueId: string,
  ): Promise<void>;
  /**
   * Record the credential's revocation, delete every grant of it, and advance the affected apps'
   * generations in one transaction, returning the apps that had a grant.
   */
  revoke(credentialId: string): Promise<WithinArtifactScope[]>;
  /** Current grant generations of the given apps; an app without changes is at 0. */
  generations(
    artifactIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
  /** Records of the given credentials, or every record when none are given. */
  records(credentialIds?: readonly string[]): Promise<CredentialRecord[]>;
}
