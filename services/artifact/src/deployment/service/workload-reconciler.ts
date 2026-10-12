import { createHash, randomBytes } from "node:crypto";
import type { ArtifactRepository } from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import { imageRepository } from "../../cluster/model/cluster-names.js";
import type { ArtifactDatabases } from "../../database/interface/artifact-databases.js";
import type { DeploymentRepository } from "../interface/deployment-repository.js";
import type { WorkloadOrchestrator } from "../interface/workload-orchestrator.js";

/** Brings Kubernetes in line with each dynamic artifact's live deployment, stored in PostgreSQL. */
export class WorkloadReconciler {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject stored state, the orchestrator, database provisioning, and the registry nodes pull from. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "list">,
    private readonly deployments: Pick<DeploymentRepository, "findByRelease">,
    private readonly orchestrator: WorkloadOrchestrator,
    private readonly databases: ArtifactDatabases,
    private readonly pullHost: string,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Run the live deployment, or stop the workload when the artifact is stopped or undeployed. */
  async reconcile(artifact: Artifact): Promise<void> {
    if (artifact.kind !== "dynamic") return;
    const deployment =
      artifact.liveDeployment === null
        ? undefined
        : await this.deployments.findByRelease(
            { ownerId: artifact.ownerId, artifactId: artifact.id },
            artifact.liveDeployment,
          );
    if (!artifact.running || !deployment) {
      await this.orchestrator.stop(artifact.id);
      return;
    }
    let databaseFingerprint: string | null = null;
    if (deployment.database) {
      const password =
        (await this.orchestrator.databasePassword(artifact.id)) ??
        randomBytes(24).toString("hex");
      await this.orchestrator.writeDatabaseSecret(
        artifact.id,
        await this.databases.ensure(artifact.id, password),
      );
      databaseFingerprint = createHash("sha256")
        .update(password)
        .digest("hex")
        .slice(0, 16);
    }
    await this.orchestrator.apply({
      artifactId: artifact.id,
      slug: artifact.slug,
      image: `${this.pullHost}/${imageRepository(artifact.id)}@${deployment.imageDigest}`,
      settings: {
        port: deployment.port,
        env: deployment.env,
        database: deployment.database,
        diskGi: deployment.diskGi,
        healthPath: deployment.healthPath,
      },
      release: deployment.release,
      databaseFingerprint,
    });
  }

  /** Reconcile every dynamic artifact, for example after a restart; one failure does not stop the rest. */
  async reconcileAll(): Promise<void> {
    for (const artifact of await this.artifacts.list({ kind: "dynamic" }))
      await this.reconcile(artifact).catch((error: unknown) =>
        console.error("Artifact reconciliation failed", {
          artifact: artifact.id,
          name: (error as Error).name,
          code: (error as { code?: unknown }).code,
        }),
      );
  }

  /** Delete the artifact's Kubernetes objects, disk, database role, and schema. */
  async remove(artifact: Artifact): Promise<void> {
    if (artifact.kind !== "dynamic") return;
    await this.orchestrator.remove(artifact.id);
    await this.databases.remove(artifact.id);
  }
}
