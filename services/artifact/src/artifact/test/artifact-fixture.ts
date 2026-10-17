import { randomUUID } from "node:crypto";
import type {
  ArtifactAuthor,
  ArtifactFile,
  ArtifactKind,
} from "@everything/artifact-contracts";
import type { OwnerScope } from "@everything/persistence/repository";
import type {
  BuildRepository,
  BuildScope,
} from "../../image/interface/build-repository.js";
import type {
  Build,
  BuildProgressChanges,
  NewBuild,
} from "../../image/model/build.js";
import type { DeploymentRepository } from "../../deployment/interface/deployment-repository.js";
import type {
  Deployment,
  NewDeployment,
} from "../../deployment/model/deployment.js";
import type { RevisionRepository } from "../../revision/interface/revision-repository.js";
import type { NewRevision, Revision } from "../../revision/model/revision.js";
import type {
  ArtifactRepository,
  ArtifactScope,
  WithinArtifactScope,
} from "../interface/artifact-repository.js";
import type { Artifact, ArtifactChanges } from "../model/artifact.js";

/** The owner every fixture artifact belongs to. */
export const owner = "owner";

/** The teammate making fixture changes. */
export const ada: ArtifactAuthor = { id: "agent-ada", name: "Ada" };

/** A second teammate, for authorship and conflicts. */
export const grace: ArtifactAuthor = { id: "agent-grace", name: "Grace" };

/** A file whose hash is derived from its path, so tests can name content by path. */
export function file(
  path: string,
  size = 10,
  executable = false,
): ArtifactFile {
  return {
    path,
    sha256: path
      .padEnd(64, "0")
      .replace(/[^0-9a-f]/g, "a")
      .slice(0, 64),
    size,
    executable,
  };
}

/** An in-memory artifact repository with the same scoping as the PostgreSQL one. */
export class MemoryArtifacts implements ArtifactRepository {
  readonly records = new Map<string, Artifact>();

  /** Seed an artifact directly. */
  add(
    kind: ArtifactKind,
    slug: string,
    changes: Partial<Artifact> = {},
  ): Artifact {
    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: randomUUID(),
      ownerId: owner,
      createdAt: now,
      updatedAt: now,
      slug,
      kind,
      title: slug,
      description: "",
      createdBy: ada,
      updatedBy: ada,
      release: 0,
      liveRevision: null,
      liveDeployment: null,
      running: kind === "static" && changes.liveRevision != null,
      diskGi: null,
      ...changes,
    };
    this.records.set(artifact.id, artifact);
    return artifact;
  }

  /** Whether the artifact is in scope. */
  private inScope(scope: ArtifactScope, artifact: Artifact): boolean {
    return "ownerId" in scope
      ? artifact.ownerId === scope.ownerId
      : artifact.kind === scope.kind;
  }

  async getById(scope: ArtifactScope, id: string) {
    const artifact = this.records.get(id);
    return artifact && this.inScope(scope, artifact) ? artifact : undefined;
  }
  async list(scope: ArtifactScope) {
    return [...this.records.values()].filter((artifact) =>
      this.inScope(scope, artifact),
    );
  }
  async delete(scope: ArtifactScope, id: string) {
    if (await this.getById(scope, id)) this.records.delete(id);
  }
  async findBySlug(scope: ArtifactScope, slug: string) {
    return [...this.records.values()].find(
      (artifact) => this.inScope(scope, artifact) && artifact.slug === slug,
    );
  }
  async create(
    scope: OwnerScope,
    input: {
      slug: string;
      kind: ArtifactKind;
      title: string;
      description: string;
    },
    author: ArtifactAuthor,
  ) {
    return this.add(input.kind, input.slug, {
      ownerId: scope.ownerId,
      title: input.title,
      description: input.description,
      createdBy: author,
      updatedBy: author,
    });
  }
  async update(
    scope: OwnerScope,
    id: string,
    { updatedBy, ...changes }: ArtifactChanges,
  ) {
    const artifact = await this.getById(scope, id);
    if (!artifact) return undefined;
    const updated = {
      ...artifact,
      ...changes,
      updatedBy,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, updated);
    return updated;
  }
}

/** Whether a record belongs to the scope's artifact. */
function within(
  scope: WithinArtifactScope,
  record: { ownerId: string; artifactId: string },
) {
  return (
    record.ownerId === scope.ownerId && record.artifactId === scope.artifactId
  );
}

/** An in-memory revision repository. */
export class MemoryRevisions implements RevisionRepository {
  readonly records: Revision[] = [];

  async getById(scope: WithinArtifactScope, id: string) {
    return this.records.find(
      (record) => record.id === id && within(scope, record),
    );
  }
  async list(scope: WithinArtifactScope) {
    return this.records.filter((record) => within(scope, record));
  }
  async delete(scope: WithinArtifactScope, id: string) {
    const index = this.records.findIndex(
      (record) => record.id === id && within(scope, record),
    );
    if (index >= 0) this.records.splice(index, 1);
  }
  async findByNumber(scope: WithinArtifactScope, number: number) {
    return this.records.find(
      (record) => record.number === number && within(scope, record),
    );
  }
  async history(scope: WithinArtifactScope, limit: number) {
    return (await this.list(scope))
      .sort((a, b) => b.number - a.number)
      .slice(0, limit)
      .map(({ number, createdAt, author, fileCount, totalSize }) => ({
        number,
        createdAt,
        author,
        fileCount,
        totalSize,
      }));
  }
  async latestNumber(scope: WithinArtifactScope) {
    return Math.max(
      0,
      ...(await this.list(scope)).map((record) => record.number),
    );
  }
  async create(scope: WithinArtifactScope, revision: NewRevision) {
    const record: Revision = {
      ...scope,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      number: revision.number,
      author: revision.author,
      files: revision.files,
      fileCount: revision.files.length,
      totalSize: revision.totalSize,
    };
    this.records.push(record);
    return record;
  }
  async prune(
    scope: WithinArtifactScope,
    keep: number,
    protect: number | null,
  ) {
    const expired = (await this.list(scope))
      .sort((a, b) => b.number - a.number)
      .slice(keep)
      .filter((record) => record.number !== protect);
    for (const record of expired) await this.delete(scope, record.id);
  }
}

/** An in-memory build repository. */
export class MemoryBuilds implements BuildRepository {
  readonly records: Build[] = [];

  /** Whether a build is in scope. */
  private inScope(scope: BuildScope, build: Build): boolean {
    if ("active" in scope)
      return build.status === "queued" || build.status === "running";
    if ("sourceTokenHash" in scope)
      return build.sourceTokenHash === scope.sourceTokenHash;
    return within(scope, build);
  }

  async getById(scope: BuildScope, id: string) {
    return this.records.find(
      (record) => record.id === id && this.inScope(scope, record),
    );
  }
  async list(scope: BuildScope) {
    return this.records.filter((record) => this.inScope(scope, record));
  }
  async delete(scope: BuildScope, id: string) {
    const index = this.records.findIndex(
      (record) => record.id === id && this.inScope(scope, record),
    );
    if (index >= 0) this.records.splice(index, 1);
  }
  async findByNumber(scope: WithinArtifactScope, number: number) {
    return this.records.find(
      (record) => record.number === number && within(scope, record),
    );
  }
  async latestSucceeded(scope: WithinArtifactScope) {
    return this.records
      .filter(
        (record) => within(scope, record) && record.status === "succeeded",
      )
      .sort((a, b) => b.number - a.number)[0];
  }
  async history(scope: WithinArtifactScope, limit: number) {
    return this.records
      .filter((record) => within(scope, record))
      .sort((a, b) => b.number - a.number)
      .slice(0, limit)
      .map((record) => ({
        number: record.number,
        createdAt: record.createdAt,
        author: record.author,
        status: record.status,
        dockerfile: record.dockerfile,
        fileCount: record.fileCount,
        totalSize: record.totalSize,
        imageDigest: record.imageDigest,
        error: record.error,
        finishedAt: record.finishedAt,
      }));
  }
  async latestNumber(scope: WithinArtifactScope) {
    return Math.max(
      0,
      ...this.records
        .filter((record) => within(scope, record))
        .map((record) => record.number),
    );
  }
  async create(scope: WithinArtifactScope, build: NewBuild) {
    const record: Build = {
      ...scope,
      ...build,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "queued",
      fileCount: build.files.length,
      imageDigest: null,
      log: null,
      error: null,
      finishedAt: null,
    };
    this.records.push(record);
    return record;
  }
  async record(scope: BuildScope, id: string, changes: BuildProgressChanges) {
    const index = this.records.findIndex(
      (record) => record.id === id && this.inScope(scope, record),
    );
    if (index >= 0)
      this.records[index] = { ...this.records[index]!, ...changes };
  }
  async prune(
    scope: WithinArtifactScope,
    keep: number,
    protect: number | null,
  ) {
    const expired = this.records
      .filter((record) => within(scope, record))
      .sort((a, b) => b.number - a.number)
      .slice(keep)
      .filter((record) => record.number !== protect);
    for (const record of expired) await this.delete(scope, record.id);
  }
}

/** An in-memory deployment repository. */
export class MemoryDeployments implements DeploymentRepository {
  readonly records: Deployment[] = [];

  async getById(scope: WithinArtifactScope, id: string) {
    return this.records.find(
      (record) => record.id === id && within(scope, record),
    );
  }
  async list(scope: WithinArtifactScope) {
    return this.records.filter((record) => within(scope, record));
  }
  async delete(scope: WithinArtifactScope, id: string) {
    const index = this.records.findIndex(
      (record) => record.id === id && within(scope, record),
    );
    if (index >= 0) this.records.splice(index, 1);
  }
  async findByRelease(scope: WithinArtifactScope, release: number) {
    return this.records.find(
      (record) => record.release === release && within(scope, record),
    );
  }
  async create(scope: WithinArtifactScope, deployment: NewDeployment) {
    const record: Deployment = {
      ...scope,
      ...deployment,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    return record;
  }
  async prune(scope: WithinArtifactScope, keep: number, protect: number) {
    const expired = this.records
      .filter((record) => within(scope, record))
      .sort((a, b) => b.release - a.release)
      .slice(keep)
      .filter((record) => record.release !== protect);
    for (const record of expired) await this.delete(scope, record.id);
  }
}
