import type { ArtifactKind } from "@everything/artifact-contracts";
import {
  ArtifactNotFoundError,
  ReleaseConflictError,
  WrongKindError,
} from "../error/artifact-errors.js";
import type { ArtifactRepository } from "../interface/artifact-repository.js";
import type { Artifact } from "../model/artifact.js";

/** Artifact IDs are UUIDs; anything else is treated as a slug. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the artifact a request refers to, by ID or slug, within the owner's scope. */
export class ArtifactLookup {
  // ===========================================
  // Construction
  // ===========================================

  /** Read artifacts through the repository. */
  constructor(
    private readonly artifacts: Pick<
      ArtifactRepository,
      "getById" | "findBySlug"
    >,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Find the owner's artifact by ID or slug; missing and inaccessible artifacts look the same. */
  async resolve(ownerId: string, reference: string): Promise<Artifact> {
    const artifact = uuid.test(reference)
      ? await this.artifacts.getById({ ownerId }, reference)
      : await this.artifacts.findBySlug({ ownerId }, reference);
    if (!artifact) throw new ArtifactNotFoundError();
    return artifact;
  }

  /** Find the artifact and require it to be of the given kind. */
  async resolveKind(
    ownerId: string,
    reference: string,
    kind: ArtifactKind,
  ): Promise<Artifact> {
    const artifact = await this.resolve(ownerId, reference);
    if (artifact.kind !== kind) throw new WrongKindError(artifact.kind);
    return artifact;
  }
}

/** Refuse a change based on an older release than the live one. */
export function requireLatestRelease(
  artifact: Artifact,
  basedOn: number | undefined,
): void {
  if (basedOn !== undefined && basedOn !== artifact.release)
    throw new ReleaseConflictError(artifact.release, artifact.updatedBy);
}
