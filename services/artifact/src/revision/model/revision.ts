import type { OwnedEntity } from "@everything/persistence/entity";
import type {
  ArtifactAuthor,
  ArtifactFile,
  ArtifactRevision,
} from "@everything/artifact-contracts";

/** Number of revisions kept per artifact; the live revision is always kept. */
export const revisionRetention = 20;

/** An immutable snapshot of a static artifact's files. */
export interface Revision extends OwnedEntity {
  readonly artifactId: string;
  readonly number: number;
  readonly author: ArtifactAuthor;
  readonly files: readonly ArtifactFile[];
  readonly fileCount: number;
  readonly totalSize: number;
}

/** Stored columns of a revision, with its author flattened. */
export interface RevisionRecord extends Omit<Revision, "author"> {
  readonly authorId: string;
  readonly authorName: string;
}

/** A new revision's contents. */
export interface NewRevision {
  readonly number: number;
  readonly author: ArtifactAuthor;
  readonly files: readonly ArtifactFile[];
  readonly totalSize: number;
}

/** History entries omit file lists. */
export type RevisionSummary = ArtifactRevision;
