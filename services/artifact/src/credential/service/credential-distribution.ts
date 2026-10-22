import type {
  AppCredential,
  CredentialAppUse,
  CredentialDelivery,
  CredentialInventoryEntry,
  CredentialValueInput,
} from "@everything/artifact-contracts/credential";
import type { ArtifactRepository } from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { credentialSecretName } from "../../cluster/model/cluster-names.js";
import type { WorkloadOrchestrator } from "../../deployment/interface/workload-orchestrator.js";
import type { WorkloadReconciler } from "../../deployment/service/workload-reconciler.js";
import {
  CredentialSupersededError,
  CredentialValueConflictError,
} from "../error/credential-errors.js";
import type { CredentialGrantRepository } from "../interface/credential-grant-repository.js";
import type { CredentialSecrets } from "../interface/credential-secrets.js";
import { appCredentialStates } from "../model/credential-status.js";
import { requireCredentialValue } from "./app-credentials.js";

/** Log a failed app without the value or the failure's message, which may quote a request. */
function reportFailure(task: string, artifactId: string, error: unknown): void {
  console.error(`Credential ${task} failed for an app`, {
    artifact: artifactId,
    name: (error as Error).name,
    code: (error as { code?: unknown }).code,
  });
}

/**
 * Deliver a credential's new value to every app that receives it, revoke a deleted credential from
 * every app, and report where each app stands. One app's failure never stops the others, and its
 * observed status shows that it hasn't changed.
 */
export class CredentialDistribution {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject grants, values, apps, observation, reconciliation, and the per-app lock. */
  constructor(
    private readonly grants: Pick<
      CredentialGrantRepository,
      "list" | "recordVersion" | "advance" | "revoke" | "records"
    >,
    private readonly secrets: Pick<CredentialSecrets, "write" | "stored">,
    private readonly artifacts: Pick<ArtifactRepository, "list" | "getById">,
    private readonly observer: Pick<WorkloadOrchestrator, "heldCredentials">,
    private readonly reconciler: Pick<WorkloadReconciler, "reconcile">,
    private readonly lock: Pick<ArtifactLock, "run">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Record the new version, then for each app whose grant is older or whose copy is missing, store
   * the value, raise the grant, and replace the app's processes. An older delivery is refused.
   */
  async deliver(
    credentialId: string,
    input: CredentialValueInput,
  ): Promise<CredentialDelivery> {
    requireCredentialValue(input.value);
    const outcome = await this.grants.recordVersion(
      credentialId,
      input.version,
      input.valueId,
    );
    if (outcome === "superseded") throw new CredentialSupersededError();
    // A version already holding another value can't be reused: reporting it applied would hide the
    // processes still running the other value. Everything saves the value as a newer version.
    if (outcome === "conflict") throw new CredentialValueConflictError();
    const stored = new Set(
      (await this.secrets.stored()).map((secret) => secret.name),
    );
    const outdated = (await this.grants.list({ credentialId })).filter(
      (binding) =>
        binding.version < input.version ||
        binding.valueId !== input.valueId ||
        !stored.has(
          credentialSecretName(
            binding.artifactId,
            credentialId,
            binding.version,
          ),
        ),
    );
    for (const scope of new Map(
      outdated.map(({ ownerId, artifactId }) => [
        artifactId,
        { ownerId, artifactId },
      ]),
    ).values())
      await this.lock
        .run(scope.artifactId, async () => {
          const artifact = await this.artifacts.getById(
            { ownerId: scope.ownerId },
            scope.artifactId,
          );
          const granted = (await this.grants.list(scope)).some(
            (binding) => binding.credentialId === credentialId,
          );
          if (!artifact || !granted) return;
          await this.secrets.write(
            artifact.id,
            credentialId,
            input.version,
            input.valueId,
            input.value,
          );
          await this.grants.advance(
            scope,
            credentialId,
            input.version,
            input.valueId,
          );
          await this.reconciler.reconcile(artifact);
        })
        .catch((error: unknown) =>
          reportFailure("delivery", scope.artifactId, error),
        );
    const apps = await this.uses(credentialId);
    return {
      complete: apps.every(
        (app) =>
          app.version >= input.version &&
          app.status !== "updating" &&
          app.status !== "missing" &&
          app.status !== "removing",
      ),
      apps,
    };
  }

  /**
   * Record the revocation and delete every grant in one transaction, then replace the processes of
   * every app that had a grant, still holds the credential, or still stores a copy of it.
   */
  async revoke(credentialId: string): Promise<CredentialDelivery> {
    const granted = await this.grants.revoke(credentialId);
    const [stored, held, artifacts] = await Promise.all([
      this.secrets.stored(),
      this.observer.heldCredentials(),
      this.artifacts.list({ kind: "dynamic" }),
    ]);
    const affected = new Set([
      ...granted.map((scope) => scope.artifactId),
      ...stored
        .filter((secret) => secret.credentialId === credentialId)
        .map((secret) => secret.artifactId),
      ...[...held]
        .filter(([, pods]) =>
          pods.some((pod) =>
            pod.entries.some((entry) => entry.credentialId === credentialId),
          ),
        )
        .map(([artifactId]) => artifactId),
    ]);
    for (const artifactId of affected)
      await this.lock
        .run(artifactId, async () => {
          const listed = artifacts.find(({ id }) => id === artifactId);
          const artifact =
            listed &&
            (await this.artifacts.getById(
              { ownerId: listed.ownerId },
              artifactId,
            ));
          // Apps deleted meanwhile are cleaned up by their deletion and by periodic reconciliation.
          if (artifact) await this.reconciler.reconcile(artifact);
        })
        .catch((error: unknown) =>
          reportFailure("revocation", artifactId, error),
        );
    const [apps, stillHeld] = await Promise.all([
      this.uses(credentialId),
      this.observer.heldCredentials(),
    ]);
    // Pods of an app deleted meanwhile aren't listed as uses but still count until they stop.
    const anyHolder = [...stillHeld.values()].some((pods) =>
      pods.some((pod) =>
        pod.entries.some((entry) => entry.credentialId === credentialId),
      ),
    );
    return { complete: apps.length === 0 && !anyHolder, apps };
  }

  /** Every app, of any owner, that has a grant of the credential or a process still holding it. */
  async uses(credentialId: string): Promise<CredentialAppUse[]> {
    const [artifacts, bindings, records, stored, held] = await Promise.all([
      this.artifacts.list({ kind: "dynamic" }),
      this.grants.list({ credentialId }),
      this.grants.records([credentialId]),
      this.secrets.stored(),
      this.observer.heldCredentials(),
    ]);
    const involved = new Set([
      ...bindings.map((binding) => binding.artifactId),
      ...[...held]
        .filter(([, pods]) =>
          pods.some((pod) =>
            pod.entries.some((entry) => entry.credentialId === credentialId),
          ),
        )
        .map(([artifactId]) => artifactId),
    ]);
    return artifacts
      .filter((artifact) => involved.has(artifact.id))
      .flatMap((artifact) =>
        this.statesOf(artifact, {
          bindings: bindings.filter(
            (binding) => binding.artifactId === artifact.id,
          ),
          records: new Map(records.map((record) => [record.id, record])),
          stored,
          held,
        })
          .filter((state) => state.credentialId === credentialId)
          .map((state) => ({
            ownerId: artifact.ownerId,
            artifactId: artifact.id,
            slug: artifact.slug,
            title: artifact.title,
            env: state.env,
            version: state.version,
            status: state.status,
            valueId: state.valueId ?? null,
          })),
      )
      .sort(
        (a, b) => a.slug.localeCompare(b.slug) || a.env.localeCompare(b.env),
      );
  }

  /** Summarize every credential with a grant, a holder, or a record, for Everything's synchronization. */
  async inventory(): Promise<CredentialInventoryEntry[]> {
    const [bindings, records, stored, held] = await Promise.all([
      this.grants.list({ inventory: true }),
      this.grants.records(),
      this.secrets.stored(),
      this.observer.heldCredentials(),
    ]);
    const storedNames = new Set(stored.map((secret) => secret.name));
    const holders = new Set(
      [...held.values()].flatMap((pods) =>
        pods.flatMap((pod) => pod.entries.map((entry) => entry.credentialId)),
      ),
    );
    const ids = new Set([
      ...bindings.map((binding) => binding.credentialId),
      ...records.map((record) => record.id),
      ...holders,
    ]);
    return [...ids].sort().map((credentialId) => {
      const granted = bindings.filter(
        (binding) => binding.credentialId === credentialId,
      );
      const record = records.find((candidate) => candidate.id === credentialId);
      return {
        credentialId,
        oldestVersion: granted.length
          ? Math.min(...granted.map((binding) => binding.version))
          : null,
        missing: granted.some(
          (binding) =>
            !storedNames.has(
              credentialSecretName(
                binding.artifactId,
                credentialId,
                binding.version,
              ),
            ),
        ),
        held: holders.has(credentialId),
        revoked: !!record?.revokedAt,
        version: record?.version ?? null,
        valueId: record?.valueId ?? null,
      };
    });
  }

  // ===========================================
  // Status
  // ===========================================

  /** One app's credential states from already loaded observations. */
  private statesOf(
    artifact: Artifact,
    observed: {
      readonly bindings: Parameters<typeof appCredentialStates>[0]["bindings"];
      readonly records: Parameters<typeof appCredentialStates>[0]["records"];
      readonly stored: Awaited<ReturnType<CredentialSecrets["stored"]>>;
      readonly held: Awaited<
        ReturnType<WorkloadOrchestrator["heldCredentials"]>
      >;
    },
  ): AppCredential[] {
    return appCredentialStates({
      artifactId: artifact.id,
      running: artifact.running && artifact.liveDeployment !== null,
      bindings: observed.bindings,
      records: observed.records,
      stored: new Set(
        observed.stored
          .filter((secret) => secret.artifactId === artifact.id)
          .map((secret) => secret.name),
      ),
      pods: observed.held.get(artifact.id) ?? [],
    });
  }
}
