import { randomUUID } from "node:crypto";
import {
  In,
  IsNull,
  LessThan,
  Not,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
} from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import {
  CredentialChangedError,
  CredentialGrantsChangedError,
  CredentialRevokedError,
  CredentialValueConflictError,
} from "../error/credential-errors.js";
import type {
  CredentialGrantRepository,
  CredentialGrantScope,
  GrantChange,
  VersionOutcome,
} from "../interface/credential-grant-repository.js";
import type {
  CredentialBinding,
  CredentialRecord,
  NewCredentialBinding,
} from "../model/credential-binding.js";
import {
  CredentialBindingEntity,
  CredentialGenerationEntity,
  CredentialRecordEntity,
} from "../schema/credential-entities.js";

/** Whether two grants name the same credential, variable, version, and value. */
function sameGrant(a: NewCredentialBinding, b: NewCredentialBinding): boolean {
  return (
    a.credentialId === b.credentialId &&
    a.env === b.env &&
    a.version === b.version &&
    a.valueId === b.valueId
  );
}

/** Scope to the owner's app, refusing an incomplete scope before any query is built. */
function appWhere({ ownerId, artifactId }: WithinArtifactScope): {
  ownerId: string;
  artifactId: string;
} {
  if (!ownerId || !artifactId)
    throw new Error("Credential grants require an owner and an app");
  return { ownerId, artifactId };
}

/** Store an app's next grant generation. */
async function advanceGeneration(
  manager: EntityManager,
  artifactId: string,
  current: number,
): Promise<number> {
  const generations = manager.getRepository(CredentialGenerationEntity);
  if (current === 0 && !(await generations.existsBy({ id: artifactId })))
    await generations.insert({ id: artifactId, generation: 1 });
  else
    await generations.update({ id: artifactId }, { generation: current + 1 });
  return current + 1;
}

/**
 * Change one app's grants inside the caller's serializable transaction, so a release can commit its
 * grants together with its deployment. See `CredentialGrantRepository.replace`.
 */
export async function changeGrants(
  manager: EntityManager,
  scope: WithinArtifactScope,
  change: GrantChange,
): Promise<number> {
  const where = appWhere(scope);
  const grants = manager.getRepository(CredentialBindingEntity);
  const records = manager.getRepository(CredentialRecordEntity);
  const current = await grants.findBy(where);
  const generation =
    (
      await manager
        .getRepository(CredentialGenerationEntity)
        .findOneBy({ id: scope.artifactId })
    )?.generation ?? 0;
  const added = change.bindings.filter(
    (binding) => !current.some((held) => sameGrant(held, binding)),
  );
  const removed = current.filter(
    (held) => !change.bindings.some((binding) => sameGrant(held, binding)),
  );
  if (added.length && change.expectedGeneration !== generation)
    throw new CredentialGrantsChangedError();
  const ids = [...new Set(added.map((binding) => binding.credentialId))];
  const known = ids.length ? await records.findBy({ id: In(ids) }) : [];
  for (const id of ids) {
    const record = known.find((candidate) => candidate.id === id);
    const granted = added
      .filter((binding) => binding.credentialId === id)
      .sort((a, b) => a.version - b.version);
    const oldest = granted[0]!;
    const newest = granted.at(-1)!;
    if (record?.revokedAt) throw new CredentialRevokedError();
    if (record && record.version > oldest.version)
      throw new CredentialChangedError();
    if (
      granted.some(
        (binding) =>
          (binding.version === newest.version &&
            binding.valueId !== newest.valueId) ||
          (record?.valueId &&
            binding.version === record.version &&
            binding.valueId !== record.valueId),
      )
    )
      throw new CredentialValueConflictError();
    if (!record)
      await records.insert({
        id,
        version: newest.version,
        valueId: newest.valueId,
        revokedAt: null,
      });
    else if (record.version < newest.version || !record.valueId)
      await records.update(
        { id },
        { version: newest.version, valueId: newest.valueId },
      );
  }
  if (!added.length && !removed.length) return generation;
  await grants.delete(where);
  if (change.bindings.length)
    await grants.insert(
      change.bindings.map((binding) => ({
        ...where,
        ...binding,
        id: randomUUID(),
      })),
    );
  return advanceGeneration(manager, scope.artifactId, generation);
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
  constructor(database: Pick<DataSource, "getRepository">) {
    super(database.getRepository(CredentialBindingEntity), {
      order: { env: "ASC", id: "ASC" },
    });
  }

  // ===========================================
  // Grants
  // ===========================================

  /** Check and swap the app's grants in one serializable transaction. */
  replace(scope: WithinArtifactScope, change: GrantChange): Promise<number> {
    return serializableTransaction(this.orm.manager, (manager) =>
      changeGrants(manager, scope, change),
    );
  }

  /** Raise only older grants, so a concurrent revocation or newer delivery is never undone. */
  async advance(
    scope: WithinArtifactScope,
    credentialId: string,
    version: number,
    valueId: string,
  ): Promise<void> {
    if (!credentialId) throw new Error("A credential identifier is required");
    await this.orm.update(
      { ...appWhere(scope), credentialId, version: LessThan(version) },
      { version, valueId },
    );
    // Grants made before value identities existed take the delivered version's identity.
    await this.orm.update(
      { ...appWhere(scope), credentialId, version, valueId: IsNull() },
      { valueId },
    );
  }

  // ===========================================
  // Records
  // ===========================================

  /** Refuse revoked credentials, and report older deliveries and different values at one version. */
  async recordVersion(
    credentialId: string,
    version: number,
    valueId: string,
  ): Promise<VersionOutcome> {
    if (!credentialId) throw new Error("A credential identifier is required");
    return serializableTransaction(this.orm.manager, async (manager) => {
      const records = manager.getRepository(CredentialRecordEntity);
      const record = await records.findOneBy({ id: credentialId });
      if (record?.revokedAt) throw new CredentialRevokedError();
      if (record && record.version > version) return "superseded";
      if (
        record?.version === version &&
        record.valueId &&
        record.valueId !== valueId
      )
        return "conflict";
      if (!record)
        await records.insert({
          id: credentialId,
          version,
          valueId,
          revokedAt: null,
        });
      else if (record.version < version || !record.valueId)
        await records.update({ id: credentialId }, { version, valueId });
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
        await records.insert({
          id: credentialId,
          version: 1,
          valueId: null,
          revokedAt,
        });
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
      const generations = manager.getRepository(CredentialGenerationEntity);
      for (const artifactId of apps.keys())
        await advanceGeneration(
          manager,
          artifactId,
          (await generations.findOneBy({ id: artifactId }))?.generation ?? 0,
        );
      return [...apps.values()];
    });
  }

  /** Read apps' generations; apps without a record are at 0. */
  async generations(
    artifactIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const found = artifactIds.length
      ? await this.orm.manager
          .getRepository(CredentialGenerationEntity)
          .findBy({ id: In([...artifactIds]) })
      : [];
    return new Map(
      artifactIds.map((id) => [
        id,
        found.find((record) => record.id === id)?.generation ?? 0,
      ]),
    );
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
    if ("artifactId" in scope) return appWhere(scope);
    if (!scope.ownerId) throw new Error("Credential grants require an owner");
    return { ownerId: scope.ownerId };
  }

  /** Grants carry no persistence-only fields. */
  protected toEntity(record: CredentialBinding): CredentialBinding {
    return record;
  }
}
