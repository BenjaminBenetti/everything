import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { AppApiKeyRepository } from "../interface/app-api-key-repository.js";
import type { AppApiKeyRecord } from "../model/app-api-key.js";
import { AppApiKeyEntity } from "../schema/app-api-key-entity.js";

/** Persist API key verification records, scoped to their owner and app. */
export class PostgresAppApiKeyRepository
  extends BaseRepository<AppApiKeyRecord, WithinArtifactScope>
  implements AppApiKeyRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository; an app has at most one record, so listings need no order. */
  constructor(database: DataSource) {
    super(database.getRepository(AppApiKeyEntity), {});
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Find the app's record within scope. */
  async find(scope: WithinArtifactScope): Promise<AppApiKeyRecord | undefined> {
    return (await this.orm.findOneBy(this.scopeWhere(scope))) ?? undefined;
  }

  /** Delete the scoped record and insert the new one together, so no older key outlives the change. */
  async replace(scope: WithinArtifactScope, keyHash: string): Promise<void> {
    const where = this.scopeWhere(scope);
    await serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(AppApiKeyEntity);
      await repository.delete(where);
      await repository.insert({ ...where, id: randomUUID(), keyHash });
    });
  }

  /** Delete the app's record within scope. */
  async revoke(scope: WithinArtifactScope): Promise<void> {
    await this.orm.delete(this.scopeWhere(scope));
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Scope to the owner's app, refusing an incomplete scope before any query is built. */
  protected scopeWhere({ ownerId, artifactId }: WithinArtifactScope): {
    ownerId: string;
    artifactId: string;
  } {
    if (!ownerId || !artifactId)
      throw new Error("API key operations require an owner and an app");
    return { ownerId, artifactId };
  }

  /** Records carry no persistence-only fields. */
  protected toEntity(record: AppApiKeyRecord): AppApiKeyRecord {
    return record;
  }
}
