import type {
  ActivateRevisionInput,
  ArtifactAuthor,
  PublishRevisionInput,
} from "@everything/artifact-contracts";
import type { ArtifactRepository } from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import {
  requireLatestRelease,
  type ArtifactLookup,
} from "../../artifact/service/artifact-lookup.js";
import { MissingContentError } from "../../content/error/content-errors.js";
import type { ContentStore } from "../../content/interface/content-store.js";
import { validateManifest } from "../../content/model/manifest.js";
import { RevisionNotFoundError } from "../error/revision-errors.js";
import type { RevisionRepository } from "../interface/revision-repository.js";
import { revisionRetention } from "../model/revision.js";

/** Publishes static artifact revisions and makes earlier ones live again. */
export class RevisionService {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject storage, content, lookup, and the per-artifact lock. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "update">,
    private readonly revisions: RevisionRepository,
    private readonly content: Pick<ContentStore, "missing">,
    private readonly lookup: ArtifactLookup,
    private readonly lock: ArtifactLock,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Store uploaded files as a new revision and make it live as the next release. */
  async publish(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    input: PublishRevisionInput,
  ): Promise<Artifact> {
    const { id } = await this.lookup.resolveKind(ownerId, reference, "static");
    return this.lock.run(id, async () => {
      const artifact = await this.lookup.resolveKind(ownerId, id, "static");
      requireLatestRelease(artifact, input.basedOn);
      const manifest = validateManifest(input.files);
      const missing = await this.content.missing(
        manifest.files.map((file) => file.sha256),
      );
      if (missing.length) throw new MissingContentError(missing.length);
      const scope = { ownerId, artifactId: id };
      const number = (await this.revisions.latestNumber(scope)) + 1;
      await this.revisions.create(scope, {
        number,
        author: actor,
        files: manifest.files,
        totalSize: manifest.totalSize,
      });
      await this.revisions.prune(scope, revisionRetention, number);
      return this.release(ownerId, artifact, actor, number);
    });
  }

  /** Make an earlier revision live as the next release. */
  async activate(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    number: number,
    input: ActivateRevisionInput,
  ): Promise<Artifact> {
    const { id } = await this.lookup.resolveKind(ownerId, reference, "static");
    return this.lock.run(id, async () => {
      const artifact = await this.lookup.resolveKind(ownerId, id, "static");
      requireLatestRelease(artifact, input.basedOn);
      const revision = await this.revisions.findByNumber(
        { ownerId, artifactId: id },
        number,
      );
      if (!revision) throw new RevisionNotFoundError(number);
      return this.release(ownerId, artifact, actor, number);
    });
  }

  // ===========================================
  // Releases
  // ===========================================

  /** Point the artifact at the revision and advance its release number. */
  private async release(
    ownerId: string,
    artifact: Artifact,
    actor: ArtifactAuthor,
    revision: number,
  ): Promise<Artifact> {
    const updated = await this.artifacts.update({ ownerId }, artifact.id, {
      release: artifact.release + 1,
      liveRevision: revision,
      updatedBy: actor,
    });
    if (!updated)
      throw new Error("The artifact disappeared during its release");
    return updated;
  }
}
