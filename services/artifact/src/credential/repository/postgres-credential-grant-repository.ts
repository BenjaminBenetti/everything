import { randomUUID } from "node:crypto";
import {
  In,
  IsNull,
  LessThan,
  Not,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import {
  CredentialChangedError,
  CredentialRevokedError,
} from "../error/credential-errors.js";
import type {
  CredentialGrantRepository,
  CredentialGrantScope,
  VersionOutcome,
} from "../interface/credential-grant-repository.js";
import type {
  CredentialBinding,
  CredentialRecord,
  NewCredentialBinding,
} from "../model/credential-binding.js";
import {
  CredentialBindingEntity,
  CredentialRecordEntity,
} from "../schema/credential-entities.js";

/** Whether two grants name the same credential, variable, and version. */
function sameGrant(a: NewCredentialBinding, b: NewCredentialBinding): boolean {
  return (
    a.credentialId === b.credentialId &&
    a.env === b.env &&
    a.version === b.version
  );
}

/** Persist grants and credential records with the shared scoped ORM defaults. */
export class PostgresCredentialGrantRepository
  extends BaseRepository<CredentialBinding, CredentialGrantScope>
  implements CredentialGrantRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the grant table; listings follow variable names so results are stable. */
  constructor(database: DataSource) {
    super(database.getRepository(CredentialBindingEntity), {
      order: { env: "ASC", id: "ASC" },
    });
  }

  // ===========================================
  // Grants
  // ===========================================

  /** Check new grants against their records and swap the app's set in one serializable transaction. */
  async replace(
    scope: WithinArtifactScope,
    bindings: readonly NewCredentialBinding[],
  ): Promise<void> {
    const where = this.appWhere(scope);
    await serializableTransaction(this.orm.manager, async (manager) => {
      const grants = manager.getRepository(CredentialBindingEntity);
      const records = manager.getRepository(CredentialRecordEntity);
      const current = await grants.findBy(where);
      const added = bindings.filter(
        (binding) => !current.some((held) => sameGrant(held, binding)),
      );
      const ids = [...new Set(added.map((binding) => binding.credentialId))];
      const known = ids.length ? await records.findBy({ id: In(ids) }) : [];
      for (const id of ids) {
        const record = known.find((candidate) => candidate.id === id);
        const version = Math.max(
          ...added
            .filter((binding) => binding.credentialId === id)
            .map((binding) => binding.version),
        );
        const oldest = Math.min(
          ...added
            .filter((binding) => binding.credentialId === id)
            .map((binding) => binding.version),
        );
        if (record?.revokedAt) throw new CredentialRevokedError();
        if (record && record.version > oldest)
          throw new CredentialChangedError();
        if (!record) await records.insert({ id, version, revokedAt: null });
        else if (record.version < version)
          await records.update({ id }, { version });
      }
      await grants.delete(where);
      if (bindings.length)
        await grants.insert(
          bindings.map((binding) => ({
            ...where,
            ...binding,
            id: randomUUID(),
          })),
        );
    });
  }

  /** Raise only older grants, so a concurrent revocation or newer delivery is never undone. */
  async advance(
    scope: WithinArtifactScope,
    credentialId: string,
    version: number,
  ): Promise<void> {
    if (!credentialId) throw new Error("A credential identifier is required");
    await this.orm.update(
      { ...this.appWhere(scope), credentialId, version: LessThan(version) },
      { version },
    );
  }

  // ===========================================
  // Records
  // ===========================================

  /** Refuse revoked credentials and report deliveries older than the newest one. */
  async recordVersion(
    credentialId: string,
    version: number,
  ): Promise<VersionOutcome> {
    if (!credentialId) throw new Error("A credential identifier is required");
    return serializableTransaction(this.orm.manager, async (manager) => {
      const records = manager.getRepository(CredentialRecordEntity);
      const record = await records.findOneBy({ id: credentialId });
      if (record?.revokedAt) throw new CredentialRevokedError();
      if (record && record.version > version) return "superseded";
      if (!record)
        await records.insert({ id: credentialId, version, revokedAt: null });
      else if (record.version < version)
        await records.update({ id: credentialId }, { version });
      return "current";
    });
  }

  /** Write the revocation before deleting grants, in the same transaction that reads them. */
  async revoke(credentialId: string): Promise<WithinArtifactScope[]> {
    if (!credentialId) throw new Error("A credential identifier is required");
    return serializableTransaction(this.orm.manager, async (manager) => {
      const records = manager.getRepository(CredentialRecordEntity);
      const grants = manager.getRepository(CredentialBindingEntity);
      const record = await records.findOneBy({ id: credentialId });
      const revokedAt = new Date().toISOString();
      if (!record)
        await records.insert({ id: credentialId, version: 1, revokedAt });
      else if (!record.revokedAt)
        await records.update({ id: credentialId }, { revokedAt });
      const revoked = await grants.findBy({ credentialId });
      if (revoked.length) await grants.delete({ credentialId });
      const apps = new Map(
        revoked.map(({ ownerId, artifactId }) => [
          artifactId,
          { ownerId, artifactId },
        ]),
      );
      return [...apps.values()];
    });
  }

  /** Read records by ID, or all of them. */
  async records(
    credentialIds?: readonly string[],
  ): Promise<CredentialRecord[]> {
    const records = this.orm.manager.getRepository(CredentialRecordEntity);
    if (credentialIds === undefined)
      return records.find({ order: { id: "ASC" } });
    return credentialIds.length
      ? records.findBy({ id: In([...credentialIds]) })
      : [];
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Scope to one app, one owner, one credential, or every grant for system work. */
  protected scopeWhere(
    scope: CredentialGrantScope,
  ): FindOptionsWhere<CredentialBinding> {
    if ("inventory" in scope) return { ownerId: Not(IsNull()) };
    if ("credentialId" in scope) {
      if (!scope.credentialId)
        throw new Error("Credential grants require a credential");
      return { credentialId: scope.credentialId };
    }
    if ("artifactId" in scope) return this.appWhere(scope);
    if (!scope.ownerId) throw new Error("Credential grants require an owner");
    return { ownerId: scope.ownerId };
  }

  /** Grants carry no persistence-only fields. */
  protected toEntity(record: CredentialBinding): CredentialBinding {
    return record;
  }

  /** Scope to the owner's app, refusing an incomplete scope before any query is built. */
  private appWhere({ ownerId, artifactId }: WithinArtifactScope): {
    ownerId: string;
    artifactId: string;
  } {
    if (!ownerId || !artifactId)
      throw new Error("Credential grants require an owner and an app");
    return { ownerId, artifactId };
  }
}
