import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type {
  ArtifactAuthor,
  ArtifactKind,
  ArtifactVisibility,
  CreateArtifactInput,
} from "@everything/artifact-contracts";
import type { Artifact, ArtifactChanges } from "../model/artifact.js";

/** Every artifact of one kind across owners, for system work such as reconciling workloads. */
export interface KindScope {
  readonly kind: ArtifactKind;
}

/**
 * Every public artifact across owners, for serving them to anyone with their link. No other
 * visibility is a scope: private artifacts are reached only through their owner's scope.
 */
export interface PublicScope {
  readonly visibility: "public";
}

/** The scope in which the artifact host finds public apps for visitors who have not signed in. */
export const publicArtifacts: PublicScope = { visibility: "public" };

/** Artifacts of one owner, of one kind for system work, or every public one for visitors. */
export type ArtifactScope = OwnerScope | KindScope | PublicScope;

/** Persistence boundary for artifact records. */
export interface ArtifactRepository extends Repository<
  Artifact,
  ArtifactScope
> {
  /** List artifacts in scope, most recently updated first. */
  list(scope: ArtifactScope): Promise<Artifact[]>;
  /** Find an artifact in scope by its slug, which is unique across owners. */
  findBySlug(scope: ArtifactScope, slug: string): Promise<Artifact | undefined>;
  /** Persist a new, unpublished, private artifact; a slug in use by any artifact is refused. */
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
  /** Set who can open the owner's artifact and record who changed it; undefined when it is missing. */
  setVisibility(
    scope: OwnerScope,
    id: string,
    visibility: ArtifactVisibility,
    updatedBy: ArtifactAuthor,
  ): Promise<Artifact | undefined>;
}

/** One owner's records belonging to one artifact, such as its revisions or builds. */
export interface WithinArtifactScope extends OwnerScope {
  readonly artifactId: string;
}
