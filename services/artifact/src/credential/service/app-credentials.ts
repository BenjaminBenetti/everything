import {
  appCredentialLimits,
  credentialEnvironmentProblem,
  type AppCredential,
  type AppCredentialGrant,
} from "@everything/artifact-contracts/credential";
import type { ArtifactAuthor } from "@everything/artifact-contracts";
import type {
  ArtifactRepository,
  WithinArtifactScope,
} from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import type { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { ArtifactNotFoundError } from "../../artifact/error/artifact-errors.js";
import { credentialSecretName } from "../../cluster/model/cluster-names.js";
import type { DeploymentRepository } from "../../deployment/interface/deployment-repository.js";
import type { WorkloadOrchestrator } from "../../deployment/interface/workload-orchestrator.js";
import type { WorkloadReconciler } from "../../deployment/service/workload-reconciler.js";
import {
  CredentialNotAttachedError,
  CredentialVariableConflictError,
  CredentialVariableTakenError,
  DuplicateCredentialVariableError,
  InvalidCredentialError,
  InvalidCredentialVariableError,
  ReservedCredentialVariableError,
  TooManyCredentialsError,
} from "../error/credential-errors.js";
import type { CredentialGrantRepository } from "../interface/credential-grant-repository.js";
import type { CredentialSecrets } from "../interface/credential-secrets.js";
import type {
  CredentialBinding,
  NewCredentialBinding,
} from "../model/credential-binding.js";
import { appCredentialStates } from "../model/credential-status.js";

/** A grant to keep, optionally with the value to store for it. */
export type GrantChange = NewCredentialBinding & { readonly value?: string };

/** Shortest value redacted from logs; shorter ones would hide unrelated text. */
const shortestRedactedValue = 6;

/** Refuse a variable name that can't hold a credential. */
export function requireCredentialVariable(env: string): void {
  const problem = credentialEnvironmentProblem(env);
  if (problem === "invalid") throw new InvalidCredentialVariableError(env);
  if (problem === "reserved") throw new ReservedCredentialVariableError(env);
}

/** Refuse a value that a process environment can't hold exactly, without repeating it. */
export function requireCredentialValue(value: string): void {
  if (
    !value ||
    value.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value,
    ) ||
    Buffer.byteLength(value, "utf8") > appCredentialLimits.valueBytes
  )
    throw new InvalidCredentialError();
}

/** Check a complete set of grants before anything is looked up or changed. */
export function requireValidGrants(
  grants: readonly AppCredentialGrant[],
): void {
  if (grants.length > appCredentialLimits.count)
    throw new TooManyCredentialsError();
  const seen = new Set<string>();
  for (const grant of grants) {
    requireCredentialVariable(grant.env);
    requireCredentialValue(grant.value);
    if (!Number.isSafeInteger(grant.version) || grant.version < 1)
      throw new InvalidCredentialError();
    if (seen.has(grant.env))
      throw new DuplicateCredentialVariableError(grant.env);
    seen.add(grant.env);
  }
}

/** Refuse credentials that would share a name with one of the app's ordinary variables. */
export function requireSeparateVariables(
  env: Readonly<Record<string, string>>,
  credentials: readonly { readonly env: string }[],
): void {
  const conflict = credentials.find((credential) =>
    Object.hasOwn(env, credential.env),
  );
  if (conflict) throw new CredentialVariableConflictError(conflict.env);
}

/** Replace exact occurrences of granted values in text the app wrote. */
export function redactCredentials(
  text: string,
  values: readonly { readonly env: string; readonly value: string }[],
): string {
  return [...values]
    .filter(({ value }) => value.length >= shortestRedactedValue)
    .sort((a, b) => b.value.length - a.value.length)
    .reduce(
      (redacted, { env, value }) =>
        redacted.split(value).join(`[credential ${env}]`),
      text,
    );
}

/**
 * Own which credentials each dynamic app receives: validation, stored values, grants, and their
 * observed status. Values arrive already authorized by Everything and are kept only in Secrets.
 */
export class AppCredentials {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject grants, value storage, observation, records, and the per-app lock. */
  constructor(
    private readonly grants: Pick<
      CredentialGrantRepository,
      "list" | "replace" | "records"
    >,
    private readonly secrets: Pick<
      CredentialSecrets,
      "write" | "stored" | "read" | "prune"
    >,
    private readonly observer: Pick<WorkloadOrchestrator, "heldCredentials">,
    private readonly artifacts: Pick<ArtifactRepository, "update">,
    private readonly deployments: Pick<DeploymentRepository, "findByRelease">,
    private readonly reconciler: Pick<WorkloadReconciler, "reconcile">,
    private readonly lookup: Pick<ArtifactLookup, "resolveKind">,
    private readonly lock: Pick<ArtifactLock, "run">,
  ) {}

  // ===========================================
  // Grants
  // ===========================================

  /** The app's current grants. */
  current(scope: WithinArtifactScope): Promise<CredentialBinding[]> {
    return this.grants.list(scope);
  }

  /**
   * Store the values supplied, then make the grants the app's complete set. Values are written
   * first, so a grant never names a missing copy; an unused copy is pruned by reconciliation.
   */
  async replace(
    scope: WithinArtifactScope,
    changes: readonly GrantChange[],
  ): Promise<void> {
    try {
      for (const change of changes)
        if (change.value !== undefined)
          await this.secrets.write(
            scope.artifactId,
            change.credentialId,
            change.version,
            change.value,
          );
      await this.grants.replace(
        scope,
        changes.map(({ credentialId, env, version }) => ({
          credentialId,
          env,
          version,
        })),
      );
    } catch (error) {
      // A refused grant's value, such as a revoked credential's, must not linger in the cluster.
      await this.discardUngranted(scope).catch(() => undefined);
      throw error;
    }
  }

  /** Give a dynamic app one more credential, then run it with the credential. */
  async attach(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    grant: AppCredentialGrant,
  ): Promise<Artifact> {
    requireValidGrants([grant]);
    const { id } = await this.lookup.resolveKind(ownerId, reference, "dynamic");
    return this.lock.run(id, async () => {
      const artifact = await this.lookup.resolveKind(ownerId, id, "dynamic");
      const scope = { ownerId, artifactId: id };
      const current = await this.grants.list(scope);
      if (current.some((binding) => binding.env === grant.env))
        throw new CredentialVariableTakenError(grant.env);
      if (current.length >= appCredentialLimits.count)
        throw new TooManyCredentialsError();
      requireSeparateVariables((await this.liveEnvironment(artifact)) ?? {}, [
        grant,
      ]);
      await this.replace(scope, [...current, grant]);
      return this.changed(artifact, actor);
    });
  }

  /** Take one credential away from an app, replacing any process that received it. */
  async detach(
    ownerId: string,
    actor: ArtifactAuthor,
    reference: string,
    env: string,
  ): Promise<Artifact> {
    const { id } = await this.lookup.resolveKind(ownerId, reference, "dynamic");
    return this.lock.run(id, async () => {
      const artifact = await this.lookup.resolveKind(ownerId, id, "dynamic");
      const scope = { ownerId, artifactId: id };
      const current = await this.grants.list(scope);
      if (!current.some((binding) => binding.env === env))
        throw new CredentialNotAttachedError(env);
      await this.replace(
        scope,
        current.filter((binding) => binding.env !== env),
      );
      return this.changed(artifact, actor);
    });
  }

  // ===========================================
  // Status
  // ===========================================

  /** Every listed app's credentials with statuses from its records, Secrets, and pods. */
  async states(
    artifacts: readonly Artifact[],
  ): Promise<ReadonlyMap<string, AppCredential[]>> {
    const dynamic = artifacts.filter((artifact) => artifact.kind === "dynamic");
    if (!dynamic.length) return new Map();
    const owners = [...new Set(dynamic.map((artifact) => artifact.ownerId))];
    const single = dynamic.length === 1 ? dynamic[0]!.id : undefined;
    const [bindings, stored, held] = await Promise.all([
      Promise.all(owners.map((ownerId) => this.grants.list({ ownerId }))).then(
        (lists) => lists.flat(),
      ),
      this.secrets.stored(single),
      this.observer.heldCredentials(single),
    ]);
    const records = new Map(
      (
        await this.grants.records([
          ...new Set(bindings.map((binding) => binding.credentialId)),
        ])
      ).map((record) => [record.id, record]),
    );
    return new Map(
      dynamic.map((artifact) => [
        artifact.id,
        appCredentialStates({
          artifactId: artifact.id,
          running: artifact.running && artifact.liveDeployment !== null,
          bindings: bindings.filter(
            (binding) => binding.artifactId === artifact.id,
          ),
          records,
          stored: new Set(
            stored
              .filter((secret) => secret.artifactId === artifact.id)
              .map((secret) => secret.name),
          ),
          pods: held.get(artifact.id) ?? [],
        }),
      ]),
    );
  }

  /** Hide the app's current credential values where they appear verbatim in its output. */
  async redact(artifact: Artifact, text: string): Promise<string> {
    if (!text) return text;
    const bindings = await this.grants.list({
      ownerId: artifact.ownerId,
      artifactId: artifact.id,
    });
    const values = await Promise.all(
      bindings.map(async (binding) => ({
        env: binding.env,
        value:
          (await this.secrets.read(
            credentialSecretName(
              artifact.id,
              binding.credentialId,
              binding.version,
            ),
          )) ?? "",
      })),
    );
    return redactCredentials(text, values);
  }

  // ===========================================
  // Helpers
  // ===========================================

  /** Delete the app's stored copies that no current grant reads. */
  private async discardUngranted(scope: WithinArtifactScope): Promise<void> {
    const granted = await this.grants.list(scope);
    await this.secrets.prune(
      scope.artifactId,
      new Set(
        granted.map((binding) =>
          credentialSecretName(
            scope.artifactId,
            binding.credentialId,
            binding.version,
          ),
        ),
      ),
    );
  }

  /** Ordinary variables of the app's live deployment, if it has one. */
  private async liveEnvironment(
    artifact: Artifact,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    if (artifact.liveDeployment === null) return undefined;
    return (
      await this.deployments.findByRelease(
        { ownerId: artifact.ownerId, artifactId: artifact.id },
        artifact.liveDeployment,
      )
    )?.env;
  }

  /** Record who changed the app and apply its grants to the running workload. */
  private async changed(
    artifact: Artifact,
    actor: ArtifactAuthor,
  ): Promise<Artifact> {
    const updated = await this.artifacts.update(
      { ownerId: artifact.ownerId },
      artifact.id,
      { updatedBy: actor },
    );
    if (!updated) throw new ArtifactNotFoundError();
    await this.reconciler.reconcile(updated);
    return updated;
  }
}
