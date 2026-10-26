import { randomUUID } from "node:crypto";
import {
  QueryFailedError,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import {
  BaseRepository,
  type OwnerScope,
} from "@everything/persistence/repository";
import type {
  ArtifactAuthor,
  ArtifactVisibility,
  CreateArtifactInput,
} from "@everything/artifact-contracts";
import { SlugTakenError } from "../error/artifact-errors.js";
import type {
  ArtifactRepository,
  ArtifactScope,
} from "../interface/artifact-repository.js";
import type {
  Artifact,
  ArtifactChanges,
  ArtifactRecord,
} from "../model/artifact.js";
import { ArtifactEntity } from "../schema/artifact-entity.js";

/** Persist artifacts, scoped to their owner, to their kind for system work, or to public ones for visitors. */
export class PostgresArtifactRepository
  extends BaseRepository<Artifact, ArtifactScope, ArtifactRecord>
  implements ArtifactRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository with most-recently-updated-first listings. */
  constructor(database: DataSource) {
    super(database.getRepository(ArtifactEntity), {
      order: { updatedAt: "DESC", id: "ASC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Find an artifact in scope by slug. */
  async findBySlug(
    scope: ArtifactScope,
    slug: string,
  ): Promise<Artifact | undefined> {
    if (
      ("ownerId" in scope && !scope.ownerId) ||
      ("kind" in scope && !scope.kind) ||
      !slug
    )
      throw new Error("Lookup requires a scope and a slug");
    const record = await this.orm.findOneBy({
      ...this.scopeWhere(scope),
      slug,
    });
    return record ? this.toEntity(record) : undefined;
  }

  /** Save a new private artifact with no release, translating a taken slug into a caller-safe error. */
  async create(
    { ownerId }: OwnerScope,
    input: CreateArtifactInput,
    author: ArtifactAuthor,
  ): Promise<Artifact> {
    if (!ownerId) throw new Error("Creation requires an owner");
    const now = new Date().toISOString();
    try {
      const record = await this.orm.save(
        this.orm.create({
          id: randomUUID(),
          ownerId,
          updatedAt: now,
          slug: input.slug,
          kind: input.kind,
          title: input.title,
          description: input.description,
          createdById: author.id,
          createdByName: author.name,
          updatedById: author.id,
          updatedByName: author.name,
          release: 0,
          liveRevision: null,
          liveDeployment: null,
          running: false,
          diskGi: null,
          visibility: "private",
        }),
      );
      return this.toEntity(record);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === "23505"
      )
        throw new SlugTakenError(input.slug);
      throw error;
    }
  }

  /** Apply changes within the owner's scope and record who made them. */
  async update(
    scope: OwnerScope,
    id: string,
    { updatedBy, ...changes }: ArtifactChanges,
  ): Promise<Artifact | undefined> {
    if (!scope.ownerId || !id)
      throw new Error("Updates require an owner and an artifact identifier");
    const result = await this.orm.update(
      { ...this.scopeWhere(scope), id },
      {
        ...changes,
        updatedAt: new Date().toISOString(),
        updatedById: updatedBy.id,
        updatedByName: updatedBy.name,
      },
    );
    return result.affected ? this.getById(scope, id) : undefined;
  }

  /** Set who can open the owner's artifact, recording the change like any other. */
  async setVisibility(
    scope: OwnerScope,
    id: string,
    visibility: ArtifactVisibility,
    updatedBy: ArtifactAuthor,
  ): Promise<Artifact | undefined> {
    if (!scope.ownerId || !id)
      throw new Error("Updates require an owner and an artifact identifier");
    const result = await this.orm.update(
      { ...this.scopeWhere(scope), id },
      {
        visibility,
        updatedAt: new Date().toISOString(),
        updatedById: updatedBy.id,
        updatedByName: updatedBy.name,
      },
    );
    return result.affected ? this.getById(scope, id) : undefined;
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Scope to the owner, to one kind of artifact for system work, or to public artifacts. */
  protected scopeWhere(scope: ArtifactScope): FindOptionsWhere<ArtifactRecord> {
    if ("ownerId" in scope) return { ownerId: scope.ownerId };
    if ("kind" in scope) return { kind: scope.kind };
    // Fail closed if an unchecked caller ever passes another visibility as a scope.
    if (scope.visibility !== "public")
      throw new Error("Only public artifacts form a visibility scope");
    return { visibility: "public" };
  }

  /** Rebuild authors from their flattened columns. */
  protected toEntity({
    createdById,
    createdByName,
    updatedById,
    updatedByName,
    ...record
  }: ArtifactRecord): Artifact {
    return {
      ...record,
      createdBy: { id: createdById, name: createdByName },
      updatedBy: { id: updatedById, name: updatedByName },
    };
  }
}
