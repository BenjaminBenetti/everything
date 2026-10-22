import { randomUUID } from "node:crypto";
import type { ArtifactRuntime } from "@everything/artifact-contracts";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import { credentialSecretName } from "../../cluster/model/cluster-names.js";
import type {
  ArtifactWorkload,
  WorkloadOrchestrator,
} from "../../deployment/interface/workload-orchestrator.js";
import {
  CredentialChangedError,
  CredentialRevokedError,
} from "../error/credential-errors.js";
import type {
  CredentialGrantRepository,
  CredentialGrantScope,
} from "../interface/credential-grant-repository.js";
import type {
  CredentialSecrets,
  StoredCredentialSecret,
} from "../interface/credential-secrets.js";
import {
  formatCredentialEntries,
  type CredentialBinding,
  type CredentialRecord,
  type NewCredentialBinding,
} from "../model/credential-binding.js";
import type { PodCredentials } from "../model/credential-status.js";

/** Whether two grants name the same credential, variable, and version. */
function same(a: NewCredentialBinding, b: NewCredentialBinding): boolean {
  return (
    a.credentialId === b.credentialId &&
    a.env === b.env &&
    a.version === b.version
  );
}

/** In-memory grants and records with the same rules as the PostgreSQL repository. */
export class MemoryCredentialGrants implements CredentialGrantRepository {
  readonly bindings: CredentialBinding[] = [];
  readonly credentialRecords = new Map<string, CredentialRecord>();

  /** Whether a grant is in scope. */
  private inScope(scope: CredentialGrantScope, binding: CredentialBinding) {
    if ("inventory" in scope) return true;
    if ("credentialId" in scope)
      return binding.credentialId === scope.credentialId;
    if ("artifactId" in scope)
      return (
        binding.ownerId === scope.ownerId &&
        binding.artifactId === scope.artifactId
      );
    return binding.ownerId === scope.ownerId;
  }

  async getById(scope: CredentialGrantScope, id: string) {
    return this.bindings.find(
      (binding) => binding.id === id && this.inScope(scope, binding),
    );
  }
  async list(scope: CredentialGrantScope) {
    return this.bindings
      .filter((binding) => this.inScope(scope, binding))
      .sort((a, b) => a.env.localeCompare(b.env));
  }
  async delete(scope: CredentialGrantScope, id: string) {
    const index = this.bindings.findIndex(
      (binding) => binding.id === id && this.inScope(scope, binding),
    );
    if (index >= 0) this.bindings.splice(index, 1);
  }
  async replace(
    scope: WithinArtifactScope,
    bindings: readonly NewCredentialBinding[],
  ) {
    const current = await this.list(scope);
    const added = bindings.filter(
      (binding) => !current.some((held) => same(held, binding)),
    );
    for (const binding of added) {
      const record = this.credentialRecords.get(binding.credentialId);
      if (record?.revokedAt) throw new CredentialRevokedError();
      if (record && record.version > binding.version)
        throw new CredentialChangedError();
    }
    for (const binding of added)
      this.raise(binding.credentialId, binding.version);
    for (const held of current)
      this.bindings.splice(this.bindings.indexOf(held), 1);
    for (const binding of bindings)
      this.bindings.push({
        ...scope,
        ...binding,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      });
  }
  async recordVersion(credentialId: string, version: number) {
    const record = this.credentialRecords.get(credentialId);
    if (record?.revokedAt) throw new CredentialRevokedError();
    if (record && record.version > version) return "superseded" as const;
    this.raise(credentialId, version);
    return "current" as const;
  }
  async advance(
    scope: WithinArtifactScope,
    credentialId: string,
    version: number,
  ) {
    for (const [index, binding] of this.bindings.entries())
      if (
        this.inScope(scope, binding) &&
        binding.credentialId === credentialId &&
        binding.version < version
      )
        this.bindings[index] = { ...binding, version };
  }
  async revoke(credentialId: string) {
    const record = this.credentialRecords.get(credentialId);
    this.credentialRecords.set(credentialId, {
      id: credentialId,
      createdAt: record?.createdAt ?? new Date().toISOString(),
      version: record?.version ?? 1,
      revokedAt: record?.revokedAt ?? new Date().toISOString(),
    });
    const revoked = this.bindings.filter(
      (binding) => binding.credentialId === credentialId,
    );
    for (const binding of revoked)
      this.bindings.splice(this.bindings.indexOf(binding), 1);
    return [
      ...new Map(
        revoked.map(({ ownerId, artifactId }) => [
          artifactId,
          { ownerId, artifactId },
        ]),
      ).values(),
    ];
  }
  async records(credentialIds?: readonly string[]) {
    return [...this.credentialRecords.values()].filter(
      (record) => !credentialIds || credentialIds.includes(record.id),
    );
  }

  /** Raise a record's version, creating it when absent. */
  private raise(credentialId: string, version: number) {
    const record = this.credentialRecords.get(credentialId);
    if (!record)
      this.credentialRecords.set(credentialId, {
        id: credentialId,
        createdAt: new Date().toISOString(),
        version,
        revokedAt: null,
      });
    else if (record.version < version)
      this.credentialRecords.set(credentialId, { ...record, version });
  }
}

/** In-memory credential Secrets, keyed by their Kubernetes names. */
export class MemoryCredentialSecrets implements CredentialSecrets {
  readonly secrets = new Map<
    string,
    StoredCredentialSecret & { value: string }
  >();
  /** Fail the next writes, to test that a failure leaves grants unchanged. */
  failWrites = false;

  async write(
    artifactId: string,
    credentialId: string,
    version: number,
    value: string,
  ) {
    if (this.failWrites) throw new Error("Secret write failed");
    const name = credentialSecretName(artifactId, credentialId, version);
    this.secrets.set(name, { artifactId, credentialId, version, name, value });
  }
  async stored(artifactId?: string) {
    return [...this.secrets.values()]
      .filter((secret) => !artifactId || secret.artifactId === artifactId)
      .map(({ value: _value, ...secret }) => secret);
  }
  async prune(artifactId: string, keep: ReadonlySet<string>) {
    for (const [name, secret] of this.secrets)
      if (secret.artifactId === artifactId && !keep.has(name))
        this.secrets.delete(name);
  }
  async read(name: string) {
    return this.secrets.get(name)?.value;
  }
}

/** A pod of the simulated cluster, with the environment its process started with. */
export interface SimulatedPod {
  readonly id: number;
  readonly artifactId: string;
  /** Specification the pod was created from; a change rolls the workload. */
  readonly template: string;
  readonly annotation: string;
  /** Credential variables resolved from Secrets when the process started. */
  readonly environment: Readonly<Record<string, string>>;
  terminating: boolean;
  ready: boolean;
  failed: boolean;
}

/**
 * A simulated Kubernetes workload controller. Like a Deployment's rolling update, a changed
 * workload keeps its old pod until a new one is ready, and a new pod reads its credential Secrets
 * only when it is created. Pods change only when `settle` runs, so tests observe pending states.
 * This is a test double: it shows the service's decisions, not real container behavior.
 */
export class SimulatedCluster implements WorkloadOrchestrator {
  readonly pods: SimulatedPod[] = [];
  readonly applied: ArtifactWorkload[] = [];
  readonly stops: string[] = [];
  private readonly desired = new Map<string, ArtifactWorkload>();
  private nextPod = 1;
  /** New pods never become ready, like a crash loop. */
  newPodsFail = false;
  /** Fail the next apply, like an unreachable API server. */
  failApply = false;

  constructor(private readonly secrets: MemoryCredentialSecrets) {}

  async apply(workload: ArtifactWorkload) {
    if (this.failApply) throw new Error("Kubernetes is unavailable");
    this.applied.push(workload);
    this.desired.set(workload.artifactId, workload);
    const template = this.template(workload);
    const current = this.live(workload.artifactId).some(
      (pod) => pod.template === template,
    );
    if (!current) this.pods.push(this.create(workload, template));
  }
  async stop(artifactId: string) {
    this.stops.push(artifactId);
    this.desired.delete(artifactId);
    for (const pod of this.pods)
      if (pod.artifactId === artifactId) pod.terminating = true;
  }
  async remove(artifactId: string) {
    await this.stop(artifactId);
  }
  async runtimes() {
    return new Map<string, ArtifactRuntime>();
  }
  async heldCredentials(artifactId?: string) {
    const held = new Map<string, PodCredentials[]>();
    for (const pod of this.pods) {
      // Like real pods that never become ready, failing pods still count: a crash loop restarts them.
      if (artifactId && pod.artifactId !== artifactId) continue;
      held.set(pod.artifactId, [
        ...(held.get(pod.artifactId) ?? []),
        {
          ready: pod.ready,
          terminating: pod.terminating,
          entries: pod.annotation
            ? pod.annotation.split(",").map((text) => {
                const [env, rest] = text.split("=") as [string, string];
                const [credentialId, version] = rest.split("@") as [
                  string,
                  string,
                ];
                return { env, credentialId, version: Number(version) };
              })
            : [],
        },
      ]);
    }
    return held;
  }
  async logs() {
    return "";
  }
  async databasePassword() {
    return undefined;
  }
  async writeDatabaseSecret() {}

  /**
   * Let time pass: stopping pods exit, new pods become ready unless they fail, and once a pod with
   * the current specification is ready the rolling update removes older ones.
   */
  settle(): void {
    for (const pod of [...this.pods])
      if (pod.terminating) this.pods.splice(this.pods.indexOf(pod), 1);
    for (const pod of this.pods) if (!pod.failed) pod.ready = true;
    for (const [artifactId, workload] of this.desired) {
      const template = this.template(workload);
      if (
        this.live(artifactId).some(
          (pod) => pod.template === template && pod.ready,
        )
      )
        for (const pod of [...this.pods])
          if (pod.artifactId === artifactId && pod.template !== template)
            this.pods.splice(this.pods.indexOf(pod), 1);
    }
  }

  /** Environments of the app's running processes. */
  environments(artifactId: string): Readonly<Record<string, string>>[] {
    return this.pods
      .filter((pod) => pod.artifactId === artifactId)
      .map((pod) => pod.environment);
  }

  /** Pods of the app that aren't stopping. */
  private live(artifactId: string): SimulatedPod[] {
    return this.pods.filter(
      (pod) => pod.artifactId === artifactId && !pod.terminating,
    );
  }

  /** A comparable rendering of what decides a rollout. */
  private template(workload: ArtifactWorkload): string {
    return JSON.stringify([
      workload.image,
      workload.release,
      workload.settings,
      formatCredentialEntries(workload.credentials),
    ]);
  }

  /** Start a pod, resolving each credential from its version's Secret as the kubelet would. */
  private create(workload: ArtifactWorkload, template: string): SimulatedPod {
    const environment: Record<string, string> = {};
    let missing = false;
    for (const credential of workload.credentials) {
      const secret = this.secrets.secrets.get(
        credentialSecretName(
          workload.artifactId,
          credential.credentialId,
          credential.version,
        ),
      );
      if (!secret) missing = true;
      else environment[credential.env] = secret.value;
    }
    // A missing Secret keeps the container from being created at all; a crash loop starts it.
    return {
      id: this.nextPod++,
      artifactId: workload.artifactId,
      template,
      annotation: formatCredentialEntries(workload.credentials),
      environment: missing ? {} : environment,
      terminating: false,
      ready: false,
      failed: missing || this.newPodsFail,
    };
  }
}
