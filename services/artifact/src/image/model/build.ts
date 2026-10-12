import type { OwnedEntity } from "@everything/persistence/entity";
import type {
  ArtifactAuthor,
  ArtifactBuild,
  ArtifactBuildStatus,
  ArtifactFile,
} from "@everything/artifact-contracts";

/** Number of builds kept per artifact; the live deployment's build is always kept. */
export const buildRetention = 20;

/** Bytes of a finished build's log that are kept. */
export const buildLogLimit = 64 * 1024;

/** Statuses of builds that have not finished. */
export const activeBuildStatuses = [
  "queued",
  "running",
] as const satisfies readonly ArtifactBuildStatus[];

/** One image build of a dynamic artifact from uploaded source. */
export interface Build extends OwnedEntity {
  readonly artifactId: string;
  readonly number: number;
  readonly author: ArtifactAuthor;
  readonly status: ArtifactBuildStatus;
  readonly dockerfile: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  readonly files: readonly ArtifactFile[];
  readonly fileCount: number;
  readonly totalSize: number;
  readonly imageDigest: string | null;
  /** Log kept once the build finished. */
  readonly log: string | null;
  readonly error: string | null;
  /** SHA-256 of the token the build job presents to download its source. */
  readonly sourceTokenHash: string;
  readonly finishedAt: string | null;
}

/** Stored columns of a build, with its author flattened. */
export interface BuildRecord extends Omit<Build, "author"> {
  readonly authorId: string;
  readonly authorName: string;
}

/** A new build's request. */
export interface NewBuild {
  readonly number: number;
  readonly author: ArtifactAuthor;
  readonly dockerfile: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  readonly files: readonly ArtifactFile[];
  readonly totalSize: number;
  readonly sourceTokenHash: string;
}

/** Progress recorded while monitoring a build. */
export type BuildProgressChanges = Partial<
  Pick<Build, "status" | "imageDigest" | "log" | "error" | "finishedAt">
>;

/** History entries omit file lists and logs. */
export type BuildSummary = ArtifactBuild;
