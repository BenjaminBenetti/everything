import { createHash, randomBytes } from "node:crypto";
import type { ArtifactRepository } from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import type { ArtifactCapabilities } from "../../capability/interface/artifact-capabilities.js";
import {
  credentialSecretName,
  imageRepository,
} from "../../cluster/model/cluster-names.js";
import type { CredentialGrantRepository } from "../../credential/interface/credential-grant-repository.js";
import type { CredentialSecrets } from "../../credential/interface/credential-secrets.js";
import type { CredentialBinding } from "../../credential/model/credential-binding.js";
import { holdsWithdrawnCredential } from "../../credential/model/credential-status.js";
import type { ArtifactDatabases } from "../../database/interface/artifact-databases.js";
import type { DeploymentRepository } from "../interface/deployment-repository.js";
import type { WorkloadOrchestrator } from "../interface/workload-orchestrator.js";

/** Names of the Secrets an app's current grants read from. */
function grantedSecrets(
  artifactId: string,
  bindings: readonly CredentialBinding[],
): ReadonlySet<string> {
  return new Set(
    bindings.map((binding) =>
      credentialSecretName(artifactId, binding.credentialId, binding.version),
    ),
  );
}

/** Brings Kubernetes in line with each dynamic artifact's live deployment, stored in PostgreSQL. */
export class WorkloadReconciler {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject stored state, resource provisioners, and the lock shared with deployment and deletion. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "list" | "getById">,
    private readonly deployments: Pick<DeploymentRepository, "findByRelease">,
    private readonly orchestrator: WorkloadOrchestrator,
    private readonly databases: ArtifactDatabases,
    private readonly pullHost: string,
    private readonly capabilities: ArtifactCapabilities,
    private readonly lock: ArtifactLock,
    private readonly grants: Pick<CredentialGrantRepository, "list">,
    private readonly credentialSecrets: Pick<
      CredentialSecrets,
      "prune" | "stored"
    >,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Run the live deployment with the app's current credential grants, or stop the workload when the
   * app is stopped or undeployed. Grants come only from their own table, never from a deployment
   * record, so an earlier release can't bring back a withdrawn credential.
   */
  async reconcile(artifact: Artifact): Promise<void> {
    if (artifact.kind !== "dynamic") return;
    const scope = { ownerId: artifact.ownerId, artifactId: artifact.id };
    const deployment =
      artifact.liveDeployment === null
        ? undefined
        : await this.deployments.findByRelease(scope, artifact.liveDeployment);
    const bindings = await this.grants.list(scope);
    if (!artifact.running || !deployment) {
      await this.orchestrator.stop(artifact.id);
      await this.credentialSecrets.prune(
        artifact.id,
        grantedSecrets(artifact.id, bindings),
      );
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
    const capabilities = await this.capabilities.reconcile(
      artifact,
      deployment.capabilities,
    );
    // A rolling update keeps the old pod until a new one is ready, and a new one may never be; a
    // process holding a withdrawn credential or an older value is therefore deleted first.
    const held =
      (await this.orchestrator.heldCredentials(artifact.id)).get(artifact.id) ??
      [];
    if (holdsWithdrawnCredential(held, bindings))
      await this.orchestrator.stop(artifact.id);
    await this.orchestrator.apply({
      artifactId: artifact.id,
      slug: artifact.slug,
      image: `${this.pullHost}/${imageRepository(artifact.id)}@${deployment.imageDigest}`,
      settings: {
        port: deployment.port,
        env: deployment.env,
        database: deployment.database,
        capabilities: deployment.capabilities,
        diskGi: deployment.diskGi,
        healthPath: deployment.healthPath,
      },
      release: deployment.release,
      databaseFingerprint,
      capabilities,
      credentials: bindings.map(({ env, credentialId, version }) => ({
        env,
        credentialId,
        version,
      })),
    });
    await this.credentialSecrets.prune(
      artifact.id,
      grantedSecrets(artifact.id, bindings),
    );
  }

  /**
   * Reconcile every dynamic artifact, for example after a restart; one failure does not stop the
   * rest. Credential Secrets left behind by deleted apps are removed afterwards.
   */
  async reconcileAll(): Promise<void> {
    for (const artifact of await this.artifacts.list({ kind: "dynamic" }))
      await this.lock
        .run(artifact.id, async () => {
          const current = await this.artifacts.getById(
            { ownerId: artifact.ownerId },
            artifact.id,
          );
          if (current) await this.reconcile(current);
        })
        .catch((error: unknown) =>
          console.error("Artifact reconciliation failed", {
            artifact: artifact.id,
            name: (error as Error).name,
            code: (error as { code?: unknown }).code,
          }),
        );
    await this.removeOrphanedCredentials().catch((error: unknown) =>
      console.error("Credential cleanup failed", {
        name: (error as Error).name,
        code: (error as { code?: unknown }).code,
      }),
    );
  }

  /** Revoke API clients and keys, then delete the artifact's Kubernetes objects, disk, role, and schema. */
  async remove(artifact: Artifact): Promise<void> {
    if (artifact.kind !== "dynamic") return;
    await this.capabilities.remove(artifact);
    await this.orchestrator.remove(artifact.id);
    await this.credentialSecrets.prune(artifact.id, new Set());
    await this.databases.remove(artifact.id);
  }

  // ===========================================
  // Cleanup
  // ===========================================

  /** Delete credential Secrets of apps that no longer exist, confirming each under its lock. */
  private async removeOrphanedCredentials(): Promise<void> {
    const dynamicIds = async () =>
      new Set(
        (await this.artifacts.list({ kind: "dynamic" })).map(({ id }) => id),
      );
    const known = await dynamicIds();
    const orphans = new Set(
      (await this.credentialSecrets.stored())
        .map((secret) => secret.artifactId)
        .filter((artifactId) => !known.has(artifactId)),
    );
    for (const artifactId of orphans)
      await this.lock.run(artifactId, async () => {
        if ((await dynamicIds()).has(artifactId)) return;
        await this.orchestrator.stop(artifactId);
        await this.credentialSecrets.prune(artifactId, new Set());
      });
  }
}
