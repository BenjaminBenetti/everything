import type { Repository } from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type {
  NewRevision,
  Revision,
  RevisionSummary,
} from "../model/revision.js";

/** Persistence boundary for static artifact revisions. */
export interface RevisionRepository extends Repository<
  Revision,
  WithinArtifactScope
> {
  /** Find one revision of the artifact by number. */
  findByNumber(
    scope: WithinArtifactScope,
    number: number,
  ): Promise<Revision | undefined>;
  /** Most recent revisions first, without their file lists. */
  history(
    scope: WithinArtifactScope,
    limit: number,
  ): Promise<RevisionSummary[]>;
  /** Highest revision number, or 0 when there is none. */
  latestNumber(scope: WithinArtifactScope): Promise<number>;
  /** Persist a new revision. */
  create(scope: WithinArtifactScope, revision: NewRevision): Promise<Revision>;
  /** Delete all but the newest `keep` revisions, never deleting the protected one. */
  prune(
    scope: WithinArtifactScope,
    keep: number,
    protect: number | null,
  ): Promise<void>;
}
