import {
  BaseRepository,
  type OwnerScope,
} from "@everything/persistence/repository";
import type { DataSource, FindOptionsWhere } from "typeorm";
import type { ProviderRepository } from "../interface/provider-repository.js";
import type { StoredProvider } from "../model/stored-provider.js";
import { ProviderEntity } from "../schema/provider-entity.js";

/** Mapped encrypted connection storage, with inherited scoped reads and deletes. */
export class PostgresProviderRepository
  extends BaseRepository<StoredProvider, OwnerScope>
  implements ProviderRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the service-owned schema and stable ordering. */
  constructor(database: DataSource) {
    super(database.getRepository(ProviderEntity), {
      order: { createdAt: "ASC", id: "ASC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Use an owner/provider conflict key and refuse records from another scope. */
  async save(scope: OwnerScope, connection: StoredProvider): Promise<void> {
    this.scopeWhere(scope);
    if (connection.ownerId !== scope.ownerId)
      throw new Error("Provider ownership mismatch");
    await this.orm.upsert(connection, {
      conflictPaths: ["ownerId", "provider"],
    });
  }

  /** Require ownership on every mapped operation. */
  protected scopeWhere({
    ownerId,
  }: OwnerScope): FindOptionsWhere<StoredProvider> {
    if (!ownerId) throw new Error("Provider storage requires an owner");
    return { ownerId };
  }

  /** Retain encrypted fields for the owning service only. */
  protected toEntity(record: StoredProvider): StoredProvider {
    return record;
  }
}
