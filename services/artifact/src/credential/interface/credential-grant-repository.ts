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
export type VersionOutcome = "current" | "superseded";

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
   * Make these the app's grants. Grants not already held exactly are refused when their credential
   * was revoked or a newer version was delivered; unchanged and removed grants are never refused.
   */
  replace(
    scope: WithinArtifactScope,
    bindings: readonly NewCredentialBinding[],
  ): Promise<void>;
  /** Record a delivered version; a revoked credential is refused and an older version superseded. */
  recordVersion(credentialId: string, version: number): Promise<VersionOutcome>;
  /** Raise the app's grants of a credential to a delivered version whose value is stored. */
  advance(
    scope: WithinArtifactScope,
    credentialId: string,
    version: number,
  ): Promise<void>;
  /** Record the credential's revocation and delete every grant of it, returning the apps that had one. */
  revoke(credentialId: string): Promise<WithinArtifactScope[]>;
  /** Records of the given credentials, or every record when none are given. */
  records(credentialIds?: readonly string[]): Promise<CredentialRecord[]>;
}
