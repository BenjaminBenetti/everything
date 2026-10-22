import { BaseRepository } from "@everything/persistence/repository";
import {
  Not,
  IsNull,
  QueryFailedError,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import type { StoredKey } from "../model/stored-key.js";
import type { KeyRepository } from "../interface/key-repository.js";
import { KeyEntity } from "../schema/key-entity.js";
import type { KeyScope } from "../model/key-scope.js";
import { KeyNameTakenError } from "../error/key-errors.js";

/** Whether a write failed because a live generic credential already has the name. */
function nameTaken(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string; constraint?: string }).code ===
      "23505" &&
    (error.driverError as { constraint?: string }).constraint ===
      "keys_generic_name"
  );
}

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
    try {
      await this.orm.insert(key);
    } catch (error) {
      if (nameTaken(error)) throw new KeyNameTakenError(key.name);
      throw error;
    }
  }

  /** Apply the installation scope to the update and inherited lookup; deleted records can't change. */
  async rename(
    scope: KeyScope,
    id: string,
    name: string,
    description?: string,
  ): Promise<StoredKey | undefined> {
    if (!id) throw new Error("A key identifier is required");
    try {
      const result = await this.orm.update(
        { ...this.scopeWhere(scope), id, deletedAt: IsNull() },
        { name, ...(description !== undefined ? { description } : {}) },
      );
      return result.affected ? this.getById(scope, id) : undefined;
    } catch (error) {
      if (nameTaken(error)) throw new KeyNameTakenError(name);
      throw error;
    }
  }

  /** Raise the version in the same statement that stores the value, matching only the creator. */
  async replaceMaterial(
    scope: KeyScope,
    id: string,
    encryptedMaterial: string,
  ): Promise<StoredKey | undefined> {
    if (!id) throw new Error("A key identifier is required");
    const result = await this.orm.update(
      {
        ...this.scopeWhere(scope),
        id,
        ownerId: scope.actorId,
        type: "generic",
        deletedAt: IsNull(),
      },
      {
        encryptedMaterial,
        version: () => "version + 1",
        updatedAt: new Date().toISOString(),
      },
    );
    return result.affected ? this.getById(scope, id) : undefined;
  }

  /** Erase the value in the same update that marks the generic credential deleted. */
  async markDeleted(scope: KeyScope, id: string): Promise<void> {
    if (!id) throw new Error("A key identifier is required");
    await this.orm.update(
      { ...this.scopeWhere(scope), id, type: "generic", deletedAt: IsNull() },
      { encryptedMaterial: "", deletedAt: new Date().toISOString() },
    );
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
