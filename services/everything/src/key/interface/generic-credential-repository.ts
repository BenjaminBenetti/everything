import type { Repository } from "@everything/persistence/repository";
import type {
  CredentialGrantScope,
  GenericCredentialScope,
} from "../model/generic-credential-scope.js";
import type { StoredKey } from "../model/stored-key.js";

/** Generic credentials as granting and synchronizing apps read them. */
export interface GenericCredentialRepository extends Repository<
  StoredKey,
  GenericCredentialScope
> {
  /** Credentials in scope whose name matches, ignoring case. */
  findByName(scope: CredentialGrantScope, name: string): Promise<StoredKey[]>;
  /** Delete a credential's record once it is deleted and no app holds it; live ones are kept. */
  purge(id: string): Promise<void>;
  /**
   * Save a live credential's unchanged value under a higher version, only if its version and value
   * identity are still those given. Returns whether it did.
   */
  advanceVersion(
    id: string,
    from: { readonly version: number; readonly valueId: string },
    version: number,
  ): Promise<boolean>;
}
