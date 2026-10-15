import { randomUUID } from "node:crypto";
import type { DataSource, FindOptionsWhere } from "typeorm";
import {
  BaseRepository,
  type OwnerScope,
} from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import type { GeneralSettings } from "@everything/settings-contracts";
import type { GeneralSettingsRepository } from "../interface/general-settings-repository.js";
import type { StoredGeneralSettings } from "../model/general-settings.js";
import { GeneralSettingsEntity } from "../schema/general-settings-entity.js";

/** Store general preferences independently of worker availability and browser state. */
export class PostgresGeneralSettingsRepository
  extends BaseRepository<StoredGeneralSettings, OwnerScope>
  implements GeneralSettingsRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the singleton-per-owner settings mapping. */
  constructor(database: DataSource) {
    super(database.getRepository(GeneralSettingsEntity), { take: 1 });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Serialize creation and replacement without changing the record's ID or creation time. */
  async save(scope: OwnerScope, settings: GeneralSettings): Promise<void> {
    const where = this.scopeWhere(scope);
    await serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(GeneralSettingsEntity);
      const previous = await repository.findOneBy(where);
      await repository.save(
        repository.create({
          ...previous,
          id: previous?.id ?? randomUUID(),
          ownerId: scope.ownerId,
          summarizeUpdates: settings.summarizeUpdates,
        }),
      );
    });
  }

  // ===========================================
  // Domain mapping
  // ===========================================

  /** Refuse missing ownership before it can broaden an ORM query. */
  protected scopeWhere({
    ownerId,
  }: OwnerScope): FindOptionsWhere<StoredGeneralSettings> {
    if (!ownerId) throw new Error("General settings require an owner");
    return { ownerId };
  }

  /** Project only persisted settings and their ownership metadata. */
  protected toEntity({
    id,
    ownerId,
    createdAt,
    summarizeUpdates,
  }: StoredGeneralSettings): StoredGeneralSettings {
    return { id, ownerId, createdAt, summarizeUpdates };
  }
}
