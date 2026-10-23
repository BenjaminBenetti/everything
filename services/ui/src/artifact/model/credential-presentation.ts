import type { SavedKey } from "@everything/key-contracts";
import {
  appCredentialLimits,
  credentialEnvironmentProblem,
  type AppCredentialStatus,
  type CredentialRollout,
  type CredentialUsage,
  type CredentialUse,
} from "@everything/artifact-contracts/credential";
import { HttpRequestError } from "../../http/model/http-request-error.js";

/** Plain-language label for where an app's credential stands. */
export const credentialStatusLabels: Readonly<
  Record<AppCredentialStatus, string>
> = {
  applied: "In use",
  pending: "Restarting",
  stopped: "App stopped",
  updating: "Updating",
  missing: "Being restored",
  removing: "Removing",
};

/** Whether nothing more happens for this app until the next change. */
export function isSettledCredential(status: AppCredentialStatus): boolean {
  return status === "applied" || status === "stopped";
}

/** Whether every listed app has settled, so status polling can stop. */
export function isSettledUsage(apps: readonly CredentialUse[]): boolean {
  return apps.every((app) => isSettledCredential(app.status));
}

/** Fastest and slowest follow-up polls while usage is unknown or still changing. */
const usagePollMs = { first: 2000, longest: 30_000 } as const;

/**
 * How long to wait before reading a followed credential's usage again, or false to stop. Usage that
 * couldn't be read is never treated as settled: it is retried with a doubling delay, and usage
 * that is still changing is read again shortly.
 */
export function usageFollowDelay(observation: {
  readonly usage: CredentialUsage | undefined;
  readonly failed: boolean;
  readonly failures: number;
}): number | false {
  if (observation.failed || !observation.usage)
    return Math.min(
      usagePollMs.longest,
      usagePollMs.first * 2 ** Math.max(0, observation.failures - 1),
    );
  return isSettledUsage(observation.usage.apps) ? false : usagePollMs.first;
}

/** What following usage needs from one read's query state. */
export interface UsageReadState {
  readonly status: "pending" | "error" | "success";
  readonly data: CredentialUsage | undefined;
  /** How many reads have failed in total; it changes with every failure. */
  readonly errorUpdateCount: number;
}

/**
 * Follow one credential's usage across reads, counting consecutive failures here: React Query
 * restarts its own failure count with every fetch, so without retries it never passes one and the
 * delay would never grow.
 */
export function usageFollower(): (state: UsageReadState) => number | false {
  let failures = 0;
  let counted = 0;
  return (state) => {
    if (state.status === "success") failures = 0;
    else if (state.status === "error" && state.errorUpdateCount !== counted) {
      counted = state.errorUpdateCount;
      failures += 1;
    }
    return usageFollowDelay({
      usage: state.data,
      failed: state.status === "error",
      failures,
    });
  };
}

/** Generic credentials the user can attach: added by them and not being deleted, by name. */
export function attachableCredentials(keys: readonly SavedKey[]): SavedKey[] {
  return keys
    .filter((key) => key.type === "generic" && key.owned && !key.status)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Explain why a variable name can't hold a credential, or undefined when it can. */
export function credentialVariableMessage(env: string): string | undefined {
  if (!env) return "Enter the environment variable name the app reads.";
  const problem = credentialEnvironmentProblem(env);
  if (problem === "invalid")
    return `Use letters, digits, and underscores, starting with a letter or underscore, up to ${appCredentialLimits.envLength} characters.`;
  if (problem === "reserved")
    return "Everything sets this name itself. Avoid PORT, BASE_PATH, DATABASE_URL, APP_API_KEY, and names starting with EVERYTHING_, PG, or KUBERNETES_.";
  return undefined;
}

/** Suggest a variable name from a credential's name, such as SLACK_BOT_TOKEN for “slack-bot-token”. */
export function suggestedVariable(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const candidate = (/^[0-9]/.test(words) ? `_${words}` : words).slice(
    0,
    appCredentialLimits.envLength,
  );
  return candidate && !credentialEnvironmentProblem(candidate) ? candidate : "";
}

/** Messages for the stable error codes credential actions can return. */
const failureMessages: Readonly<Record<string, string>> = {
  KEY_NAME_TAKEN:
    "Another generic credential already uses this name. Choose a different name.",
  INVALID_KEY:
    "Enter a name and a value smaller than 32 KB that isn’t blank and has no NUL characters.",
  INVALID_CREDENTIAL_VARIABLE: `Use letters, digits, and underscores for the variable name, starting with a letter or underscore, up to ${appCredentialLimits.envLength} characters.`,
  RESERVED_CREDENTIAL_VARIABLE:
    "Everything sets this variable name itself. Choose another name.",
  DUPLICATE_CREDENTIAL_VARIABLE:
    "This app already receives a credential under that name. Choose another name, or remove it first.",
  CREDENTIAL_VARIABLE_TAKEN:
    "This app already receives a credential under that name. Choose another name, or remove it first.",
  CREDENTIAL_VARIABLE_CONFLICT:
    "This app already has an ordinary environment variable with that name. Choose another name.",
  TOO_MANY_CREDENTIALS: `An app can receive at most ${appCredentialLimits.count} credentials. Remove one before attaching another.`,
  CREDENTIAL_REVOKED:
    "This credential was deleted, so it can’t be attached to an app.",
  CREDENTIAL_CHANGED:
    "The credential’s value changed while it was being attached. Try again.",
  CREDENTIAL_NOT_ATTACHED:
    "That credential is no longer attached to this app. Refresh to see the current list.",
  ARTIFACTS_UNAVAILABLE:
    "Apps are unavailable right now. Try again in a moment.",
  WRONG_ARTIFACT_KIND: "Only apps that run a backend can receive credentials.",
};

/**
 * Describe a failed credential action in the UI's own words, using only the server's error code;
 * the server's message is never shown, so nothing it echoes can reach the page.
 */
export function credentialFailureMessage(error: unknown): string {
  if (error instanceof HttpRequestError) {
    const known = error.code && failureMessages[error.code];
    if (known) return known;
    if (error.status === 403)
      return "You can’t change this credential. Only the account that added it can replace its value or attach it to apps.";
    return error.message;
  }
  return "We couldn’t complete that request. Please try again.";
}

/**
 * Explain a failed removal truthfully: the change may already be saved even though the request
 * failed, and the app keeps the value until its old process stops, so the refreshed statuses are
 * what to trust.
 */
export function removalFailureMessage(error: unknown): string {
  if (
    error instanceof HttpRequestError &&
    error.code === "CREDENTIAL_NOT_ATTACHED"
  )
    return "That credential was already removed from the app. It shows as Removing until the app has stopped using it.";
  return "We couldn’t confirm the removal, but it may already be saved. Check the statuses here: the credential shows as Removing until the app has stopped using it, and disappears once it’s gone.";
}

/** A short, truthful sentence about a credential's apps after it was deleted. */
export function deletionOutcome(
  rollout: CredentialRollout | undefined,
): string {
  if (!rollout || rollout.complete)
    return "Credential deleted. No app receives it anymore.";
  if (!rollout.usage)
    return "Credential deleted. Everything couldn’t reach your apps yet, so it keeps trying to remove it from them.";
  const pending = rollout.usage.apps.length + rollout.usage.otherApps || 1;
  return `Credential deleted. It’s still being removed from ${pending} ${pending === 1 ? "app" : "apps"}, and Everything keeps trying until no app has it.`;
}

/**
 * A short, truthful sentence about a credential's apps after its value was replaced. The saved
 * value is a fact from the replacement; where apps stand comes from the latest observation, which
 * replaces the replacement's first answer as soon as one is available.
 */
export function replacementProgress(
  rollout: CredentialRollout,
  latest: CredentialUsage | undefined,
): string {
  const usage = latest ?? rollout.usage;
  if (!usage)
    return "Saved. Everything couldn’t reach your apps yet and keeps trying.";
  if (usage.apps.length + usage.otherApps === 0)
    return "Saved. No app uses this credential yet.";
  if (usage.apps.every((app) => app.status === "applied"))
    return "Saved. All apps use the new value.";
  if (isSettledUsage(usage.apps))
    return "Saved. Running apps use the new value, and stopped apps get it when they start.";
  return "Saved. Apps are restarting to use the new value; their statuses update below.";
}
