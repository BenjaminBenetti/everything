import type {
  AppCredential,
  AppCredentialStatus,
} from "@everything/artifact-contracts/credential";
import { credentialSecretName } from "../../cluster/model/cluster-names.js";
import type {
  CredentialBinding,
  CredentialEntry,
  CredentialRecord,
} from "./credential-binding.js";

/** The credentials one pod's environment holds, whether it serves, and whether it is being deleted. */
export interface PodCredentials {
  readonly ready: boolean;
  readonly terminating: boolean;
  readonly entries: readonly CredentialEntry[];
}

/** Everything the status of one app's credentials depends on. */
export interface AppCredentialObservation {
  readonly artifactId: string;
  /** Whether the app's live deployment should be running. */
  readonly running: boolean;
  readonly bindings: readonly CredentialBinding[];
  /** Records of the credentials involved, by credential ID. */
  readonly records: ReadonlyMap<string, CredentialRecord>;
  /** Names of the app's stored credential Secrets, or undefined when they weren't read. */
  readonly stored: ReadonlySet<string> | undefined;
  /** The app's pods, including ones being deleted, whose processes may still run. */
  readonly pods: readonly PodCredentials[];
}

/** Whether two entries are the same credential, variable, and version. */
function sameEntry(a: CredentialEntry, b: CredentialEntry): boolean {
  return (
    a.env === b.env &&
    a.credentialId === b.credentialId &&
    a.version === b.version
  );
}

/**
 * Derive each grant's status from records and observed pods, then add withdrawn credentials a pod
 * still holds. A grant is applied only when a pod serves and every pod, including any still
 * stopping, holds exactly its version, so an older process never hides behind a green status.
 */
export function appCredentialStates(
  observation: AppCredentialObservation,
): AppCredential[] {
  const { artifactId, running, bindings, records, stored, pods } = observation;

  /** The status of one grant. */
  function status(binding: CredentialBinding): AppCredentialStatus {
    if ((records.get(binding.credentialId)?.version ?? 0) > binding.version)
      return "updating";
    if (
      stored &&
      !stored.has(
        credentialSecretName(artifactId, binding.credentialId, binding.version),
      )
    )
      return "missing";
    // Stopped means no process holds any version of it: a pod still exiting, possibly for good on
    // an unreachable node, keeps it pending.
    if (!running)
      return pods.some((pod) =>
        pod.entries.some(
          (entry) =>
            entry.env === binding.env &&
            entry.credentialId === binding.credentialId,
        ),
      )
        ? "pending"
        : "stopped";
    const holdsExactly = (pod: PodCredentials) =>
      pod.entries.some((entry) => sameEntry(entry, binding)) &&
      !pod.entries.some(
        (entry) => entry.env === binding.env && !sameEntry(entry, binding),
      );
    return pods.some((pod) => pod.ready && !pod.terminating) &&
      pods.every(holdsExactly)
      ? "applied"
      : "pending";
  }

  const granted: AppCredential[] = [...bindings]
    .sort((a, b) => a.env.localeCompare(b.env))
    .map((binding) => ({
      credentialId: binding.credentialId,
      name: null,
      env: binding.env,
      version: binding.version,
      status: status(binding),
      valueId: binding.valueId,
    }));
  const withdrawn = new Map<string, AppCredential>();
  for (const entry of pods.flatMap((pod) => pod.entries)) {
    if (
      bindings.some(
        (binding) =>
          binding.env === entry.env &&
          binding.credentialId === entry.credentialId,
      )
    )
      continue;
    const key = `${entry.env}=${entry.credentialId}`;
    if ((withdrawn.get(key)?.version ?? 0) >= entry.version) continue;
    withdrawn.set(key, {
      credentialId: entry.credentialId,
      name: null,
      env: entry.env,
      version: entry.version,
      status: "removing",
      valueId: null,
    });
  }
  return [
    ...granted,
    ...[...withdrawn.values()].sort((a, b) => a.env.localeCompare(b.env)),
  ];
}

/**
 * Whether a pod that isn't already stopping holds a credential entry outside the app's grants. Such
 * a process must be replaced before the withdrawal can be reported as done.
 */
export function holdsWithdrawnCredential(
  pods: readonly PodCredentials[],
  bindings: readonly CredentialEntry[],
): boolean {
  return pods.some(
    (pod) =>
      !pod.terminating &&
      pod.entries.some(
        (entry) => !bindings.some((binding) => sameEntry(binding, entry)),
      ),
  );
}
