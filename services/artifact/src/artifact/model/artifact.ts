import type { OwnedEntity } from "@everything/persistence/entity";
import type {
  ArtifactAuthor,
  ArtifactKind,
} from "@everything/artifact-contracts";

/** A shared, linkable piece of work and the release that is live. */
export interface Artifact extends OwnedEntity {
  readonly slug: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly createdBy: ArtifactAuthor;
  readonly updatedBy: ArtifactAuthor;
  /** Number of the live release; 0 before anything is published or deployed. */
  readonly release: number;
  /** Live revision number of a static artifact. */
  readonly liveRevision: number | null;
  /** Release number of a dynamic artifact's live deployment. */
  readonly liveDeployment: number | null;
  /** Whether a dynamic artifact's live deployment should be running. */
  readonly running: boolean;
  /** Size of a dynamic artifact's disk, fixed once the disk exists. */
  readonly diskGi: number | null;
}

/** Stored columns of an artifact, with each author flattened into an ID and a name. */
export interface ArtifactRecord extends Omit<
  Artifact,
  "createdBy" | "updatedBy"
> {
  readonly createdById: string;
  readonly createdByName: string;
  readonly updatedById: string;
  readonly updatedByName: string;
}

/** Fields a release or edit may change; each change records the main agent that made it. */
export type ArtifactChanges = Partial<
  Pick<
    Artifact,
    | "title"
    | "description"
    | "release"
    | "liveRevision"
    | "liveDeployment"
    | "running"
    | "diskGi"
  >
> & { readonly updatedBy: ArtifactAuthor };
