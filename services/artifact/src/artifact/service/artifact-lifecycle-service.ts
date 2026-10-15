import type { ArtifactAuthor } from "@everything/artifact-contracts";
import {
  AppNotPublishedError,
  ArtifactNotFoundError,
} from "../error/artifact-errors.js";
import type { ArtifactRepository } from "../interface/artifact-repository.js";
import type { ArtifactRuntime } from "../interface/artifact-runtime.js";
import type { Artifact } from "../model/artifact.js";
import type { ArtifactLock } from "./artifact-lock.js";
import type { ArtifactLookup } from "./artifact-lookup.js";

/** Pause or resume a saved app release without selecting a different release. */
export class ArtifactLifecycleService {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject scoped storage, shared coordination, and the runtime boundary. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "update">,
    private readonly lookup: Pick<ArtifactLookup, "resolve">,
    private readonly lock: Pick<ArtifactLock, "run">,
    private readonly runtime: ArtifactRuntime,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Resume the existing published revision or deployed image with its saved settings. */
  start(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
  ): Promise<Artifact> {
    return this.setRunning(ownerId, actor, reference, true);
  }

  /** Take the app offline, retaining its release, database, and disk. */
  stop(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
  ): Promise<Artifact> {
    return this.setRunning(ownerId, actor, reference, false);
  }

  // ===========================================
  // State transitions
  // ===========================================

  /** Re-read under the app's lock so releases, deletions, and manual controls cannot race. */
  private async setRunning(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    running: boolean,
  ): Promise<Artifact> {
    const { id } = await this.lookup.resolve(ownerId, reference);
    return this.lock.run(id, async () => {
      const app = await this.lookup.resolve(ownerId, id);
      const release =
        app.kind === "static" ? app.liveRevision : app.liveDeployment;
      if (running && release === null) throw new AppNotPublishedError();
      const updated =
        app.running === running
          ? app
          : await this.artifacts.update({ ownerId }, id, {
              running,
              updatedBy: actor,
            });
      if (!updated) throw new ArtifactNotFoundError();
      await this.runtime.reconcile(updated);
      return updated;
    });
  }
}
