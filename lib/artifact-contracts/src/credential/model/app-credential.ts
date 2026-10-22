import {
  environmentNamePattern,
  reservedEnvironmentNames,
} from "../../artifact/model/artifact.js";

/** Limits on the credentials one dynamic app receives. */
export const appCredentialLimits = {
  /** Credentials one app receives; with the value limit, at most 512 KiB of environment. */
  count: 16,
  /** Longest environment variable name a credential is attached as. */
  envLength: 128,
  /** Largest value, in UTF-8 bytes, matching the key store's limit. */
  valueBytes: 32768,
} as const;

/**
 * Prefixes of variables that Everything, PostgreSQL clients, or Kubernetes set or read; a credential
 * can't be attached under them, so it can't replace or redirect the platform's own settings.
 */
export const reservedCredentialPrefixes = [
  "EVERYTHING_",
  "PG",
  "KUBERNETES_",
] as const;

/** Why a name can't hold a credential, or undefined when it can. */
export type CredentialEnvironmentProblem = "invalid" | "reserved";

/** Check a credential's environment variable name against syntax, length, and reserved names. */
export function credentialEnvironmentProblem(
  env: string,
): CredentialEnvironmentProblem | undefined {
  if (
    env.length > appCredentialLimits.envLength ||
    !new RegExp(environmentNamePattern).test(env)
  )
    return "invalid";
  if (
    (reservedEnvironmentNames as readonly string[]).includes(env) ||
    reservedCredentialPrefixes.some((prefix) => env.startsWith(prefix))
  )
    return "reserved";
  return undefined;
}

/**
 * Where one app's attached credential stands, derived from its stored grant and observed processes:
 * - `applied`: every process the app runs has this value.
 * - `pending`: the app is restarting so its processes use this value.
 * - `stopped`: the app is stopped; it receives the value when it starts.
 * - `updating`: a newer value is waiting to be delivered to the app.
 * - `missing`: the app's stored copy is missing; Everything delivers it again.
 * - `removing`: detached or deleted, but a process that received it hasn't stopped yet.
 */
export type AppCredentialStatus =
  "applied" | "pending" | "stopped" | "updating" | "missing" | "removing";

/** Every status, for validation schemas. */
export const appCredentialStatuses = [
  "applied",
  "pending",
  "stopped",
  "updating",
  "missing",
  "removing",
] as const satisfies readonly AppCredentialStatus[];

/** A credential an app receives: identifiers and status, never the value. */
export interface AppCredential {
  /** Stable ID; renaming the credential never changes which one the app receives. */
  readonly credentialId: string;
  /** Current name, filled in by Everything; null when the credential was deleted. */
  readonly name: string | null;
  /** Environment variable the app's backend reads it from. */
  readonly env: string;
  /** Version of the value the app's grant holds. */
  readonly version: number;
  readonly status: AppCredentialStatus;
}

/**
 * A credential Everything grants to an app, resolved and authorized by Everything. This is the only
 * contract that carries a value; the app service never stores it outside the app's runtime Secret.
 */
export interface AppCredentialGrant {
  readonly credentialId: string;
  readonly env: string;
  readonly version: number;
  readonly value: string;
}

/** A teammate's request to give an app a credential, chosen by its name. */
export interface CredentialBindingRequest {
  readonly name: string;
  readonly env: string;
}

/** A user's request to give an app a credential, chosen by its ID. */
export interface AttachCredentialInput {
  readonly credentialId: string;
  readonly env: string;
}

/** A credential's new value, delivered to every app that receives it. */
export interface CredentialValueInput {
  readonly version: number;
  readonly value: string;
}

/** One app's use of a credential, across owners, as the app service reports it to Everything. */
export interface CredentialAppUse {
  readonly ownerId: string;
  readonly artifactId: string;
  readonly slug: string;
  readonly title: string;
  readonly env: string;
  readonly version: number;
  readonly status: AppCredentialStatus;
}

/**
 * The apps that receive a credential, or still hold it, after a delivery or revocation. `complete`
 * means every grant now has the delivered value stored, or, for a revocation, that no grant remains
 * and no process still holds it.
 */
export interface CredentialDelivery {
  readonly complete: boolean;
  readonly apps: readonly CredentialAppUse[];
}

/** One credential in the app service's inventory, for Everything's background synchronization. */
export interface CredentialInventoryEntry {
  readonly credentialId: string;
  /** Oldest version an app's grant holds, or null when no app has a grant. */
  readonly oldestVersion: number | null;
  /** Whether an app's stored copy of its grant is missing. */
  readonly missing: boolean;
  /** Whether a process still holds the credential, with or without a grant. */
  readonly held: boolean;
  /** Whether the app service has recorded the credential's deletion. */
  readonly revoked: boolean;
}

/** Every credential the app service knows of. */
export interface CredentialInventory {
  readonly credentials: readonly CredentialInventoryEntry[];
}

/** One of the caller's apps that uses a credential, for the Keys page. */
export interface CredentialUse {
  readonly appId: string;
  readonly slug: string;
  readonly title: string;
  readonly env: string;
  readonly status: AppCredentialStatus;
}

/** Who uses a credential; other accounts' apps are only counted. */
export interface CredentialUsage {
  readonly apps: readonly CredentialUse[];
  readonly otherApps: number;
}

/**
 * Where the apps using a credential stand after its value was replaced or it was deleted. `usage`
 * is null when the app service couldn't be reached; Everything keeps retrying in the background.
 */
export interface CredentialRollout {
  /**
   * After a replacement, every app has the new value stored; after a deletion, no app has a grant
   * and no process still holds it. Processes may still be restarting; see each app's status.
   */
  readonly complete: boolean;
  readonly usage: CredentialUsage | null;
}

/** The credentials one app receives, after attaching or removing one. */
export interface AppCredentialList {
  readonly credentials: readonly AppCredential[];
}
