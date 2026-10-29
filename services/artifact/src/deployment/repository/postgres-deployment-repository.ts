import { randomUUID } from "node:crypto";
import { In, type DataSource } from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { DeploymentRepository } from "../interface/deployment-repository.js";
import type {
  Deployment,
  DeploymentRecord,
  NewDeployment,
} from "../model/deployment.js";
import { DeploymentEntity } from "../schema/deployment-entity.js";

/** Persist deployments, scoped to their owner and artifact. */
export class PostgresDeploymentRepository
  extends BaseRepository<Deployment, WithinArtifactScope, DeploymentRecord>
  implements DeploymentRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository with newest-first listings. */
  constructor(database: Pick<DataSource, "getRepository">) {
    super(database.getRepository(DeploymentEntity), {
      order: { release: "DESC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Find the deployment of one release within scope. */
  async findByRelease(
    scope: WithinArtifactScope,
    release: number,
  ): Promise<Deployment | undefined> {
    const record = await this.orm.findOneBy({
      ...this.scopeWhere(scope),
      release,
    });
    return record ? this.toEntity(record) : undefined;
  }

  /** Save a new deployment of the artifact in scope. */
  async create(
    scope: WithinArtifactScope,
    { author, env, capabilities, ...deployment }: NewDeployment,
  ): Promise<Deployment> {
    const record = await this.orm.save(
      this.orm.create({
        ...this.scopeWhere(scope),
        ...deployment,
        env: { ...env },
        capabilities: [...capabilities],
        id: randomUUID(),
        authorId: author.id,
        authorName: author.name,
      }),
    );
    return this.toEntity(record);
  }

  /** Keep the newest deployments and the protected release, deleting the rest. */
  async prune(
    scope: WithinArtifactScope,
    keep: number,
    protect: number,
  ): Promise<void> {
    const where = this.scopeWhere(scope);
    const expired = (
      await this.orm.find({
        select: { release: true },
        where,
        order: { release: "DESC" },
        skip: keep,
      })
    )
      .map((record) => record.release)
      .filter((release) => release !== protect);
    if (expired.length)
      await this.orm.delete({ ...where, release: In(expired) });
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Scope to the owner's artifact, refusing an incomplete scope before any query is built. */
  protected scopeWhere({ ownerId, artifactId }: WithinArtifactScope): {
    ownerId: string;
    artifactId: string;
  } {
    if (!ownerId || !artifactId)
      throw new Error("Deployment operations require an owner and an artifact");
    return { ownerId, artifactId };
  }

  /** Rebuild the author from its flattened columns. */
  protected toEntity({
    authorId,
    authorName,
    ...record
  }: DeploymentRecord): Deployment {
    return { ...record, author: { id: authorId, name: authorName } };
  }
}
