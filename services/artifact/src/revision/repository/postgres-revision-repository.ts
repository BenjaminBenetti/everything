import { randomUUID } from "node:crypto";
import { In, type DataSource } from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { RevisionRepository } from "../interface/revision-repository.js";
import type {
  NewRevision,
  Revision,
  RevisionRecord,
  RevisionSummary,
} from "../model/revision.js";
import { RevisionEntity } from "../schema/revision-entity.js";

/** Persist revisions, scoped to their owner and artifact. */
export class PostgresRevisionRepository
  extends BaseRepository<Revision, WithinArtifactScope, RevisionRecord>
  implements RevisionRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository with newest-first listings. */
  constructor(database: DataSource) {
    super(database.getRepository(RevisionEntity), {
      order: { number: "DESC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Find one revision by number within scope. */
  async findByNumber(
    scope: WithinArtifactScope,
    number: number,
  ): Promise<Revision | undefined> {
    const record = await this.orm.findOneBy({
      ...this.scopeWhere(scope),
      number,
    });
    return record ? this.toEntity(record) : undefined;
  }

  /** Read recent revisions without loading their file lists. */
  async history(
    scope: WithinArtifactScope,
    limit: number,
  ): Promise<RevisionSummary[]> {
    const records = await this.orm.find({
      select: {
        number: true,
        createdAt: true,
        authorId: true,
        authorName: true,
        fileCount: true,
        totalSize: true,
      },
      where: this.scopeWhere(scope),
      order: { number: "DESC" },
      take: limit,
    });
    return records.map((record) => ({
      number: record.number,
      createdAt: record.createdAt,
      author: { id: record.authorId, name: record.authorName },
      fileCount: record.fileCount,
      totalSize: record.totalSize,
    }));
  }

  /** Highest number in scope, or 0. */
  async latestNumber(scope: WithinArtifactScope): Promise<number> {
    return (await this.orm.maximum("number", this.scopeWhere(scope))) ?? 0;
  }

  /** Save a new revision of the artifact in scope. */
  async create(
    scope: WithinArtifactScope,
    revision: NewRevision,
  ): Promise<Revision> {
    const record = await this.orm.save(
      this.orm.create({
        ...this.scopeWhere(scope),
        id: randomUUID(),
        number: revision.number,
        authorId: revision.author.id,
        authorName: revision.author.name,
        files: [...revision.files],
        fileCount: revision.files.length,
        totalSize: revision.totalSize,
      }),
    );
    return this.toEntity(record);
  }

  /** Keep the newest revisions and the protected one, deleting the rest. */
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

  /** Scope to the owner's artifact, refusing an incomplete scope before any query is built. */
  protected scopeWhere({ ownerId, artifactId }: WithinArtifactScope): {
    ownerId: string;
    artifactId: string;
  } {
    if (!ownerId || !artifactId)
      throw new Error("Revision operations require an owner and an artifact");
    return { ownerId, artifactId };
  }

  /** Rebuild the author from its flattened columns. */
  protected toEntity({
    authorId,
    authorName,
    ...record
  }: RevisionRecord): Revision {
    return { ...record, author: { id: authorId, name: authorName } };
  }
}
