import { randomUUID } from "node:crypto";
import type { DataSource, FindOptionsWhere } from "typeorm";
import {
  BaseRepository,
  type OwnerScope,
} from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import type { GeneralSettingsRepository } from "../interface/general-settings-repository.js";
import type {
  GeneralPreferences,
  StoredGeneralSettings,
} from "../model/general-settings.js";
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

  /** Serialize creation and changes without touching other preferences, the record's ID, or creation time. */
  async save(
    scope: OwnerScope,
    preferences: Partial<GeneralPreferences>,
  ): Promise<void> {
    const where = this.scopeWhere(scope);
    await serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(GeneralSettingsEntity);
      const previous = await repository.findOneBy(where);
      await repository.save(
        repository.create({
          ...previous,
          ...pickPreferences(preferences),
          id: previous?.id ?? randomUUID(),
          ownerId: scope.ownerId,
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
    teammateIds,
  }: StoredGeneralSettings): StoredGeneralSettings {
    return { id, ownerId, createdAt, summarizeUpdates, teammateIds };
  }
}

/** Copy only known preference fields so a caller's extra properties never reach a column. */
function pickPreferences({
  summarizeUpdates,
  teammateIds,
}: Partial<GeneralPreferences>): Partial<GeneralPreferences> {
  return {
    ...(summarizeUpdates === undefined ? {} : { summarizeUpdates }),
    ...(teammateIds === undefined ? {} : { teammateIds: [...teammateIds] }),
  };
}
