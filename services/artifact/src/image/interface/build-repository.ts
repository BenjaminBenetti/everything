import type { Repository } from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type {
  Build,
  BuildProgressChanges,
  BuildSummary,
  NewBuild,
} from "../model/build.js";

/** Every unfinished build across owners, for the build monitor. */
export interface ActiveBuildsScope {
  readonly active: true;
}

/** The build whose job presents this source token. */
export interface SourceTokenScope {
  readonly sourceTokenHash: string;
}

/** One artifact's builds, every unfinished build, or the build holding a source token. */
export type BuildScope =
  WithinArtifactScope | ActiveBuildsScope | SourceTokenScope;

/** Persistence boundary for dynamic artifact builds. */
export interface BuildRepository extends Repository<Build, BuildScope> {
  /** Find one build of the artifact by number. */
  findByNumber(
    scope: WithinArtifactScope,
    number: number,
  ): Promise<Build | undefined>;
  /** The artifact's most recent successful build. */
  latestSucceeded(scope: WithinArtifactScope): Promise<Build | undefined>;
  /** Most recent builds first, without file lists or logs. */
  history(scope: WithinArtifactScope, limit: number): Promise<BuildSummary[]>;
  /** Highest build number, or 0 when there is none. */
  latestNumber(scope: WithinArtifactScope): Promise<number>;
  /** Persist a new, queued build. */
  create(scope: WithinArtifactScope, build: NewBuild): Promise<Build>;
  /** Record the progress of a build in scope; a build outside the scope is left unchanged. */
  record(
    scope: BuildScope,
    id: string,
    changes: BuildProgressChanges,
  ): Promise<void>;
  /** Delete all but the newest `keep` builds, never deleting the protected one. */
  prune(
    scope: WithinArtifactScope,
    keep: number,
    protect: number | null,
  ): Promise<void>;
}
