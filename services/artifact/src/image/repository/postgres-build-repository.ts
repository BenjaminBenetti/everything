import { randomUUID } from "node:crypto";
import { In, type DataSource, type FindOptionsWhere } from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type {
  BuildRepository,
  BuildScope,
} from "../interface/build-repository.js";
import {
  activeBuildStatuses,
  type Build,
  type BuildProgressChanges,
  type BuildRecord,
  type BuildSummary,
  type NewBuild,
} from "../model/build.js";
import { BuildEntity } from "../schema/build-entity.js";

/** Persist builds, scoped to their artifact, to unfinished builds, or to a source token. */
export class PostgresBuildRepository
  extends BaseRepository<Build, BuildScope, BuildRecord>
  implements BuildRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository with newest-first listings. */
  constructor(database: DataSource) {
    super(database.getRepository(BuildEntity), {
      order: { createdAt: "DESC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Find one build by number within the artifact. */
  async findByNumber(
    scope: WithinArtifactScope,
    number: number,
  ): Promise<Build | undefined> {
    const record = await this.orm.findOneBy({
      ...this.scopeWhere(scope),
      number,
    });
    return record ? this.toEntity(record) : undefined;
  }

  /** Find the artifact's newest successful build. */
  async latestSucceeded(
    scope: WithinArtifactScope,
  ): Promise<Build | undefined> {
    const record = await this.orm.findOne({
      where: { ...this.scopeWhere(scope), status: "succeeded" },
      order: { number: "DESC" },
    });
    return record ? this.toEntity(record) : undefined;
  }

  /** Read recent builds without loading their file lists or logs. */
  async history(
    scope: WithinArtifactScope,
    limit: number,
  ): Promise<BuildSummary[]> {
    const records = await this.orm.find({
      select: {
        number: true,
        createdAt: true,
        authorId: true,
        authorName: true,
        status: true,
        dockerfile: true,
        fileCount: true,
        totalSize: true,
        imageDigest: true,
        error: true,
        finishedAt: true,
      },
      where: this.scopeWhere(scope),
      order: { number: "DESC" },
      take: limit,
    });
    return records.map((record) => ({
      number: record.number,
      createdAt: record.createdAt,
      author: { id: record.authorId, name: record.authorName },
      status: record.status,
      dockerfile: record.dockerfile,
      fileCount: record.fileCount,
      totalSize: record.totalSize,
      imageDigest: record.imageDigest,
      error: record.error,
      finishedAt: record.finishedAt,
    }));
  }

  /** Highest number within the artifact, or 0. */
  async latestNumber(scope: WithinArtifactScope): Promise<number> {
    return (await this.orm.maximum("number", this.scopeWhere(scope))) ?? 0;
  }

  /** Save a new queued build of the artifact. */
  async create(scope: WithinArtifactScope, build: NewBuild): Promise<Build> {
    const record = await this.orm.save(
      this.orm.create({
        ownerId: scope.ownerId,
        artifactId: scope.artifactId,
        id: randomUUID(),
        number: build.number,
        authorId: build.author.id,
        authorName: build.author.name,
        status: "queued",
        dockerfile: build.dockerfile,
        buildArgs: { ...build.buildArgs },
        files: [...build.files],
        fileCount: build.files.length,
        totalSize: build.totalSize,
        imageDigest: null,
        log: null,
        error: null,
        sourceTokenHash: build.sourceTokenHash,
        finishedAt: null,
      }),
    );
    return this.toEntity(record);
  }

  /** Update a build in scope with its latest progress. */
  async record(
    scope: BuildScope,
    id: string,
    changes: BuildProgressChanges,
  ): Promise<void> {
    if (!id) throw new Error("A build identifier is required");
    await this.orm.update({ ...this.scopeWhere(scope), id }, changes);
  }

  /** Keep the newest builds and the protected one, deleting the rest. */
  async prune(
    scope: WithinArtifactScope,
    keep: number,
    protect: number | null,
  ): Promise<void> {
    const where = this.scopeWhere(scope);
    const expired = (
      await this.orm.find({
        select: { number: true },
        where,
        order: { number: "DESC" },
        skip: keep,
      })
    )
      .map((record) => record.number)
      .filter((number) => number !== protect);
    if (expired.length)
      await this.orm.delete({ ...where, number: In(expired) });
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Apply one of the three scopes, refusing an incomplete one before any query is built. */
  protected scopeWhere(scope: BuildScope): FindOptionsWhere<BuildRecord> {
    if ("active" in scope) return { status: In([...activeBuildStatuses]) };
    if ("sourceTokenHash" in scope) {
      if (!scope.sourceTokenHash) throw new Error("A source token is required");
      return { sourceTokenHash: scope.sourceTokenHash };
    }
    if (!scope.ownerId || !scope.artifactId)
      throw new Error("Build operations require an owner and an artifact");
    return { ownerId: scope.ownerId, artifactId: scope.artifactId };
  }

  /** Rebuild the author from its flattened columns. */
  protected toEntity({ authorId, authorName, ...record }: BuildRecord): Build {
    return { ...record, author: { id: authorId, name: authorName } };
  }
}
