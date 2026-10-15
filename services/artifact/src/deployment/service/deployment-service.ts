import {
  defaultDeploymentSettings,
  reservedEnvironmentNames,
  type ArtifactAuthor,
  type ArtifactDeploymentSettings,
  type DeployInput,
} from "@everything/artifact-contracts";
import type { ArtifactRepository } from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import {
  requireLatestRelease,
  type ArtifactLookup,
} from "../../artifact/service/artifact-lookup.js";
import { BuildNotReadyError } from "../../image/error/build-errors.js";
import type { BuildRepository } from "../../image/interface/build-repository.js";
import {
  DiskSizeFixedError,
  ReservedVariableError,
} from "../error/deployment-errors.js";
import type { DeploymentRepository } from "../interface/deployment-repository.js";
import type {
  LogOptions,
  WorkloadOrchestrator,
} from "../interface/workload-orchestrator.js";
import { deploymentRetention } from "../model/deployment.js";
import type { WorkloadReconciler } from "./workload-reconciler.js";

/** Names the artifact service sets in every artifact's environment. */
const reserved = new Set<string>(reservedEnvironmentNames);

/** Deploys builds of dynamic apps and reads their container output. */
export class DeploymentService {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject storage, the reconciler, the orchestrator for logs, and the per-artifact lock. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "update">,
    private readonly deployments: DeploymentRepository,
    private readonly builds: Pick<
      BuildRepository,
      "findByNumber" | "latestSucceeded"
    >,
    private readonly reconciler: Pick<WorkloadReconciler, "reconcile">,
    private readonly orchestrator: Pick<WorkloadOrchestrator, "logs">,
    private readonly lookup: ArtifactLookup,
    private readonly lock: ArtifactLock,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Record a deployment of a successful build as the next release, then run it. */
  async deploy(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    input: DeployInput,
  ): Promise<Artifact> {
    for (const name of Object.keys(input.env ?? {}))
      if (reserved.has(name)) throw new ReservedVariableError(name);
    const { id } = await this.lookup.resolveKind(ownerId, reference, "dynamic");
    return this.lock.run(id, async () => {
      const artifact = await this.lookup.resolveKind(ownerId, id, "dynamic");
      requireLatestRelease(artifact, input.basedOn);
      const scope = { ownerId, artifactId: id };
      const build =
        input.build === undefined
          ? await this.builds.latestSucceeded(scope)
          : await this.builds.findByNumber(scope, input.build);
      if (build?.status !== "succeeded" || !build.imageDigest)
        throw new BuildNotReadyError(input.build);
      const settings = await this.settings(artifact, input);
      if (
        settings.diskGi !== null &&
        artifact.diskGi !== null &&
        settings.diskGi !== artifact.diskGi
      )
        throw new DiskSizeFixedError(artifact.diskGi);
      const release = artifact.release + 1;
      await this.deployments.create(scope, {
        ...settings,
        release,
        author: actor,
        build: build.number,
        imageDigest: build.imageDigest,
      });
      const updated = await this.artifacts.update({ ownerId }, id, {
        release,
        liveDeployment: release,
        running: true,
        diskGi: artifact.diskGi ?? settings.diskGi,
        updatedBy: actor,
      });
      if (!updated)
        throw new Error("The artifact disappeared during its deployment");
      await this.deployments.prune(scope, deploymentRetention, release);
      await this.reconciler.reconcile(updated);
      return updated;
    });
  }

  /** Read recent output of the artifact's container. */
  async logs(
    ownerId: string,
    reference: string,
    options: LogOptions,
  ): Promise<string> {
    const artifact = await this.lookup.resolveKind(
      ownerId,
      reference,
      "dynamic",
    );
    return this.orchestrator.logs(artifact.id, options);
  }

  // ===========================================
  // Settings
  // ===========================================

  /** Fill omitted settings from the live deployment, or from the first-deployment defaults. */
  private async settings(
    artifact: Artifact,
    input: DeployInput,
  ): Promise<ArtifactDeploymentSettings> {
    const live =
      artifact.liveDeployment === null
        ? undefined
        : await this.deployments.findByRelease(
            { ownerId: artifact.ownerId, artifactId: artifact.id },
            artifact.liveDeployment,
          );
    const base = live ?? defaultDeploymentSettings;
    return {
      port: input.port ?? base.port,
      env: input.env ?? base.env,
      database: input.database ?? base.database,
      diskGi: input.diskGi === undefined ? base.diskGi : input.diskGi,
      healthPath:
        input.healthPath === undefined ? base.healthPath : input.healthPath,
    };
  }
}
