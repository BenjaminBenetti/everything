import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type {
  ArtifactAuthor,
  ArtifactKind,
  CreateArtifactInput,
} from "@everything/artifact-contracts";
import type { Artifact, ArtifactChanges } from "../model/artifact.js";

/** Every artifact of one kind across owners, for system work such as reconciling workloads. */
export interface KindScope {
  readonly kind: ArtifactKind;
}

/** Artifacts of one owner, or of one kind for system work. */
export type ArtifactScope = OwnerScope | KindScope;

/** Persistence boundary for artifact records. */
export interface ArtifactRepository extends Repository<
  Artifact,
  ArtifactScope
> {
  /** List artifacts in scope, most recently updated first. */
  list(scope: ArtifactScope): Promise<Artifact[]>;
  /** Find an owner's artifact by its slug. */
  findBySlug(scope: OwnerScope, slug: string): Promise<Artifact | undefined>;
  /** Persist a new, unpublished artifact; a slug in use by any artifact is refused. */
  create(
    scope: OwnerScope,
    input: CreateArtifactInput,
    author: ArtifactAuthor,
  ): Promise<Artifact>;
  /** Apply changes within scope, returning the updated artifact or undefined when it is missing. */
  update(
    scope: OwnerScope,
    id: string,
    changes: ArtifactChanges,
  ): Promise<Artifact | undefined>;
}

/** One owner's records belonging to one artifact, such as its revisions or builds. */
export interface WithinArtifactScope extends OwnerScope {
  readonly artifactId: string;
}
