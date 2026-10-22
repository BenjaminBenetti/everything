import { BaseRepository } from "@everything/persistence/repository";
import {
  IsNull,
  Not,
  Raw,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import type { GenericCredentialRepository } from "../interface/generic-credential-repository.js";
import type {
  CredentialGrantScope,
  GenericCredentialScope,
} from "../model/generic-credential-scope.js";
import type { StoredKey } from "../model/stored-key.js";
import { KeyEntity } from "../schema/key-entity.js";

/** Read generic credentials for granting and synchronizing apps, filtered in the database query. */
export class PostgresGenericCredentialRepository
  extends BaseRepository<StoredKey, GenericCredentialScope>
  implements GenericCredentialRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the key schema with stable ordering. */
  constructor(database: DataSource) {
    super(database.getRepository(KeyEntity), { order: { id: "ASC" } });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Compare names the same way the unique index does, with PostgreSQL's `lower`. */
  async findByName(
    scope: CredentialGrantScope,
    name: string,
  ): Promise<StoredKey[]> {
    return (
      await this.orm.find({
        where: {
          ...this.scopeWhere(scope),
          name: Raw((column) => `lower(${column}) = lower(:name)`, { name }),
        },
        order: { id: "ASC" },
      })
    ).map((record) => this.toEntity(record));
  }

  /** Delete only a record already marked deleted, so a live credential can never be purged. */
  async purge(id: string): Promise<void> {
    if (!id) throw new Error("A key identifier is required");
    await this.orm.delete({ id, type: "generic", deletedAt: Not(IsNull()) });
  }

  // ===========================================
  // Scope and projection
  // ===========================================

  /** Live credentials of one creator, or every generic credential for synchronization. */
  protected scopeWhere(
    scope: GenericCredentialScope,
  ): FindOptionsWhere<StoredKey> {
    if (scope.usage === "credential-grant") {
      if (!scope.ownerId)
        throw new Error("Credential grants require the credential's creator");
      return { type: "generic", ownerId: scope.ownerId, deletedAt: IsNull() };
    }
    if (scope.usage === "credential-sync")
      return { type: "generic", ownerId: Not(IsNull()) };
    throw new Error("Generic credentials require an explicit scope");
  }

  /** Keep ciphertext internal to granting and synchronization. */
  protected toEntity(record: StoredKey): StoredKey {
    return record;
  }
}
