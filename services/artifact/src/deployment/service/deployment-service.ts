import {
  defaultDeploymentSettings,
  reservedEnvironmentNames,
  type ArtifactAuthor,
  type ArtifactDeploymentSettings,
  type DeployInput,
} from "@everything/artifact-contracts";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import {
  requireLatestRelease,
  type ArtifactLookup,
} from "../../artifact/service/artifact-lookup.js";
import {
  requireSeparateVariables,
  requireValidGrants,
  type AppCredentials,
} from "../../credential/service/app-credentials.js";
import { BuildNotReadyError } from "../../image/error/build-errors.js";
import type { BuildRepository } from "../../image/interface/build-repository.js";
import {
  DiskSizeFixedError,
  ReservedVariableError,
} from "../error/deployment-errors.js";
import type { DeploymentRepository } from "../interface/deployment-repository.js";
import type { ReleaseStore } from "../interface/release-store.js";
import type {
  LogOptions,
  WorkloadOrchestrator,
} from "../interface/workload-orchestrator.js";
import { deploymentRetention, type Deployment } from "../model/deployment.js";
import type { WorkloadReconciler } from "./workload-reconciler.js";

/** Names the artifact service sets in every artifact's environment. */
const reserved = new Set<string>(reservedEnvironmentNames);

/** Deploys builds of dynamic apps and reads their container output. */
export class DeploymentService {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject storage, the release store, the reconciler, the orchestrator for logs, the lock, and credentials. */
  constructor(
    private readonly deployments: Pick<
      DeploymentRepository,
      "findByRelease" | "prune"
    >,
    private readonly builds: Pick<
      BuildRepository,
      "findByNumber" | "latestSucceeded"
    >,
    private readonly reconciler: Pick<WorkloadReconciler, "reconcile">,
    private readonly orchestrator: Pick<WorkloadOrchestrator, "logs">,
    private readonly lookup: ArtifactLookup,
    private readonly lock: ArtifactLock,
    private readonly releases: ReleaseStore,
    private readonly credentials: Pick<
      AppCredentials,
      "current" | "store" | "discardUngranted" | "redact"
    >,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Record a deployment of a successful build as the next release, then run it. Supplied credentials
   * replace the app's grants; omitted ones keep the current grants, never an earlier release's.
   */
  async deploy(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    input: DeployInput,
  ): Promise<Artifact> {
    for (const name of Object.keys(input.env ?? {}))
      if (reserved.has(name)) throw new ReservedVariableError(name);
    if (input.credentials) requireValidGrants(input.credentials);
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
      const live = await this.live(artifact);
      const settings = mergeSettings(live ?? defaultDeploymentSettings, input);
      if (
        settings.diskGi !== null &&
        artifact.diskGi !== null &&
        settings.diskGi !== artifact.diskGi
      )
        throw new DiskSizeFixedError(artifact.diskGi);
      // Check the final environment, including grants kept from before, before changing anything.
      requireSeparateVariables(
        settings.env,
        input.credentials ?? (await this.credentials.current(scope)),
      );
      const release = artifact.release + 1;
      // Values are stored first, so a committed grant never names a missing copy. The grants, an
      // API key revocation, the deployment, and the live release then commit together or not at
      // all, so a failed deployment can't leave its grants or revocation in effect.
      if (input.credentials)
        await this.credentials.store(scope, input.credentials);
      let updated: Artifact;
      try {
        updated = await this.releases.commit(scope, {
          grants: input.credentials
            ? {
                bindings: input.credentials.map(
                  ({ credentialId, env, version, valueId }) => ({
                    credentialId,
                    env,
                    version,
                    valueId,
                  }),
                ),
                expectedGeneration: input.credentialGeneration,
              }
            : undefined,
          revokeApiKey:
            !!live?.capabilities.includes("api-key") &&
            !settings.capabilities.includes("api-key"),
          deployment: {
            ...settings,
            release,
            author: actor,
            build: build.number,
            imageDigest: build.imageDigest,
          },
          changes: {
            release,
            liveDeployment: release,
            running: true,
            diskGi: artifact.diskGi ?? settings.diskGi,
            updatedBy: actor,
          },
        });
      } catch (error) {
        if (input.credentials)
          await this.credentials.discardUngranted(scope).catch(() => undefined);
        throw error;
      }
      await this.deployments.prune(scope, deploymentRetention, release);
      await this.reconciler.reconcile(updated);
      return updated;
    });
  }

  /**
   * Read recent output of the artifact's container, hiding exact copies of its current credential
   * values. Output the app transformed, or values it already printed elsewhere, can't be detected.
   */
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
    return this.credentials.redact(
      artifact,
      await this.orchestrator.logs(artifact.id, options),
    );
  }

  // ===========================================
  // Settings
  // ===========================================

  /** The live deployment, whose settings fill those a request omits. */
  private async live(artifact: Artifact): Promise<Deployment | undefined> {
    return artifact.liveDeployment === null
      ? undefined
      : this.deployments.findByRelease(
          { ownerId: artifact.ownerId, artifactId: artifact.id },
          artifact.liveDeployment,
        );
  }
}

/** Fill omitted settings from the live deployment, or from the first-deployment defaults. */
function mergeSettings(
  base: ArtifactDeploymentSettings,
  input: DeployInput,
): ArtifactDeploymentSettings {
  return {
    port: input.port ?? base.port,
    env: input.env ?? base.env,
    database: input.database ?? base.database,
    capabilities: input.capabilities ?? base.capabilities,
    diskGi: input.diskGi === undefined ? base.diskGi : input.diskGi,
    healthPath:
      input.healthPath === undefined ? base.healthPath : input.healthPath,
  };
}
