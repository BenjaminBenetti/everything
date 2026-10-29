import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type {
  Artifact,
  ArtifactChanges,
} from "../../artifact/model/artifact.js";
import type { GrantChange } from "../../credential/interface/credential-grant-repository.js";
import type { NewDeployment } from "../model/deployment.js";

/** Everything a new release records about an app. */
export interface ReleaseCommit {
  /** The app's new credential grants, or undefined to keep its current grants unchanged. */
  readonly grants: GrantChange | undefined;
  /** Whether the release turns the API key capability off, which revokes the app's key. */
  readonly revokeApiKey: boolean;
  readonly deployment: NewDeployment;
  /** The app's new live release and settings. */
  readonly changes: ArtifactChanges;
}

/**
 * Records a release's grants, API key revocation, deployment, and live pointer together or not at
 * all, so a failed deployment can't leave its grants or revocation in effect on the old release.
 */
export interface ReleaseStore {
  /** Commit the release in one transaction and return the updated app. */
  commit(scope: WithinArtifactScope, release: ReleaseCommit): Promise<Artifact>;
}
