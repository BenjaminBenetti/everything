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
}
