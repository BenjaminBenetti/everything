import type { SavedKey } from "@everything/key-contracts";
import {
  appCredentialLimits,
  credentialEnvironmentProblem,
  type AppCredentialStatus,
  type CredentialRollout,
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
      return "You can’t change this credential. Only the account that added it can replace its value or attach it to apps, and apps can’t manage credentials themselves.";
    return error.message;
  }
  return "We couldn’t complete that request. Please try again.";
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

/** A short, truthful sentence about a credential's apps after its value was replaced. */
export function replacementOutcome(rollout: CredentialRollout): string {
  if (!rollout.usage)
    return "Value saved. Everything couldn’t reach your apps yet; it delivers the new value as soon as it can.";
  const apps = rollout.usage.apps.length + rollout.usage.otherApps;
  if (apps === 0) return "Value saved. No app uses this credential yet.";
  if (rollout.complete && isSettledUsage(rollout.usage.apps))
    return "Value saved. Every app now uses the new value.";
  return "Value saved. Apps are restarting to use the new value.";
}
