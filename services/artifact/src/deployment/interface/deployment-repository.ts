import type { Repository } from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { Deployment, NewDeployment } from "../model/deployment.js";

/** Persistence boundary for dynamic artifact deployments. */
export interface DeploymentRepository extends Repository<
  Deployment,
  WithinArtifactScope
> {
  /** Find the deployment that created a release. */
  findByRelease(
    scope: WithinArtifactScope,
    release: number,
  ): Promise<Deployment | undefined>;
  /** Persist a new deployment. */
  create(
    scope: WithinArtifactScope,
    deployment: NewDeployment,
  ): Promise<Deployment>;
  /** Delete all but the newest `keep` deployments, never deleting the protected release. */
  prune(
    scope: WithinArtifactScope,
    keep: number,
    protect: number,
  ): Promise<void>;
}
