import type { Repository } from "@everything/persistence/repository";
import type { StoredKey } from "../model/stored-key.js";
import type { KeyScope } from "../model/key-scope.js";

/** Installation-scoped persistence for extensible key records. */
export interface KeyRepository extends Repository<StoredKey, KeyScope> {
  /** Insert a newly encrypted record attributed to its authenticated creator. */
  create(scope: KeyScope, key: StoredKey): Promise<void>;
  /** Rename a shared record and report a missing identifier uniformly. */
  rename(
    scope: KeyScope,
    id: string,
    name: string,
  ): Promise<StoredKey | undefined>;
}
