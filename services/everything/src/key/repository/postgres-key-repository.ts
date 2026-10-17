import { BaseRepository } from "@everything/persistence/repository";
import { Not, IsNull, type DataSource, type FindOptionsWhere } from "typeorm";
import type { StoredKey } from "../model/stored-key.js";
import type { KeyRepository } from "../interface/key-repository.js";
import { KeyEntity } from "../schema/key-entity.js";
import type { KeyScope } from "../model/key-scope.js";

/** Persist encrypted keys using the shared scoped ORM defaults. */
export class PostgresKeyRepository
  extends BaseRepository<StoredKey, KeyScope>
  implements KeyRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the service-owned key schema; listing order belongs to the service. */
  constructor(database: DataSource) {
    super(database.getRepository(KeyEntity), {});
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Attribute new records to the caller while keeping them installation-wide. */
  async create(scope: KeyScope, key: StoredKey): Promise<void> {
    this.scopeWhere(scope);
    if (key.ownerId !== scope.actorId) throw new Error("Key creator mismatch");
    await this.orm.insert(key);
  }

  /** Apply the installation scope to the update and inherited lookup. */
  async rename(
    scope: KeyScope,
    id: string,
    name: string,
  ): Promise<StoredKey | undefined> {
    if (!id) throw new Error("A key identifier is required");
    const result = await this.orm.update(
      { ...this.scopeWhere(scope), id },
      { name },
    );
    return result.affected ? this.getById(scope, id) : undefined;
  }

  // ===========================================
  // Scope and projection
  // ===========================================

  /** Require an authenticated actor and explicitly select the installation's attributed records. */
  protected scopeWhere(scope: KeyScope): FindOptionsWhere<StoredKey> {
    if (scope.usage !== "installation" || !scope.actorId)
      throw new Error(
        "Key storage requires an authenticated installation scope",
      );
    return { ownerId: Not(IsNull()) };
  }

  /** Retain ciphertext only within the owning service's persistence boundary. */
  protected toEntity(record: StoredKey): StoredKey {
    return record;
  }
}
