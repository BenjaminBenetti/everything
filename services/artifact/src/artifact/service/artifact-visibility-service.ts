import type {
  ArtifactAuthor,
  ArtifactVisibility,
} from "@everything/artifact-contracts";
import {
  ArtifactNotFoundError,
  OwnerActionRequiredError,
} from "../error/artifact-errors.js";
import type { ArtifactRepository } from "../interface/artifact-repository.js";
import type { Artifact } from "../model/artifact.js";
import type { ArtifactLock } from "./artifact-lock.js";
import type { ArtifactLookup } from "./artifact-lookup.js";

/**
 * Changes who can open an app. Everything sends this only for the owner signed in to its browser
 * application; as a second check, the acting author must be the owner, never one of their teammates.
 */
export class ArtifactVisibilityService {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject scoped storage and the per-app lock shared with releases and lifecycle changes. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "setVisibility">,
    private readonly lookup: Pick<ArtifactLookup, "resolve">,
    private readonly lock: Pick<ArtifactLock, "run">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Set the owner's app to private or public; the new choice applies to the next request it serves. */
  async change(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    visibility: ArtifactVisibility,
  ): Promise<Artifact> {
    if (actor.id !== ownerId) throw new OwnerActionRequiredError();
    const { id } = await this.lookup.resolve(ownerId, reference);
    return this.lock.run(id, async () => {
      const app = await this.lookup.resolve(ownerId, id);
      if (app.visibility === visibility) return app;
      const updated = await this.artifacts.setVisibility(
        { ownerId },
        id,
        visibility,
        actor,
      );
      if (!updated) throw new ArtifactNotFoundError();
      return updated;
    });
  }
}
