import { BaseRepository } from "@everything/persistence/repository";
import {
  IsNull,
  LessThanOrEqual,
  Or,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import type { ProviderCheckRepository } from "../interface/provider-check-repository.js";
import type {
  ProviderCheckScope,
  ProviderCheckTarget,
} from "../model/provider-check.js";
import type { StoredProvider } from "../model/stored-provider.js";
import { ProviderEntity } from "../schema/provider-entity.js";

/** Discover a bounded batch of scheduled checks, separately from owner-scoped settings access. */
export class PostgresProviderCheckRepository
  extends BaseRepository<
    ProviderCheckTarget,
    ProviderCheckScope,
    StoredProvider
  >
  implements ProviderCheckRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Reuse mapped reads and limit each scheduling pass to twenty due connections. */
  constructor(database: DataSource) {
    super(database.getRepository(ProviderEntity), {
      order: { lastCheckedAt: "ASC", id: "ASC" },
      take: 20,
    });
  }

  // ===========================================
  // Maintenance scope
  // ===========================================

  /** Apply configured state and the explicit cutoff in every database query. */
  protected scopeWhere({
    checkedBefore,
  }: ProviderCheckScope): FindOptionsWhere<StoredProvider> {
    if (
      !(checkedBefore instanceof Date) ||
      !Number.isFinite(checkedBefore.getTime())
    )
      throw new Error("Provider checks require a valid scheduling cutoff");
    return {
      configured: true,
      lastCheckedAt: Or(IsNull(), LessThanOrEqual(checkedBefore)),
    };
  }

  /** Supply only the ownership and identity needed to request a scoped verification. */
  protected toEntity(record: StoredProvider): ProviderCheckTarget {
    return {
      id: record.id,
      ownerId: record.ownerId,
      createdAt: record.createdAt,
      provider: record.provider,
    };
  }
}
