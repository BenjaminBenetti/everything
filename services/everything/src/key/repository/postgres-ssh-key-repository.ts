import { BaseRepository } from "@everything/persistence/repository";
import { IsNull, Not, type DataSource, type FindOptionsWhere } from "typeorm";
import type { StoredKey } from "../model/stored-key.js";
import type { SshKeyScope } from "../model/ssh-key-scope.js";
import type { SshKeyRepository } from "../interface/ssh-key-repository.js";
import { KeyEntity } from "../schema/key-entity.js";

/** Read only SSH keys for the explicitly shared installation runtime. */
export class PostgresSshKeyRepository
  extends BaseRepository<StoredKey, SshKeyScope>
  implements SshKeyRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Reuse mapped reads with stable ordering and no plaintext database fields. */
  constructor(database: DataSource) {
    super(database.getRepository(KeyEntity), { order: { id: "ASC" } });
  }

  // ===========================================
  // Scope and projection
  // ===========================================

  /** Require the internal installation-use scope and filter types inside the database query. */
  protected scopeWhere(scope: SshKeyScope): FindOptionsWhere<StoredKey> {
    if (scope.usage !== "installation-ssh")
      throw new Error("SSH key use requires an explicit installation scope");
    return { type: "ssh", ownerId: Not(IsNull()) };
  }

  /** Keep ciphertext internal to synchronization. */
  protected toEntity(record: StoredKey): StoredKey {
    return record;
  }
}
