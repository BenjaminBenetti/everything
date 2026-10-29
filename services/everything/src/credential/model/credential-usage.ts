import type {
  AppCredentialStatus,
  CredentialAppUse,
  CredentialUsage,
} from "@everything/artifact-contracts/credential";

/** The version and value Everything has saved for a live credential. */
export interface SavedValue {
  readonly version: number;
  readonly valueId: string | null;
}

/**
 * An app's status as Everything reports it: a grant that doesn't hold the saved version and value
 * is updating, whatever its process state, so a newer saved value is never shown as in use.
 */
export function effectiveStatus(
  use: {
    readonly status: AppCredentialStatus;
    readonly version: number;
    readonly valueId?: string | null | undefined;
  },
  saved: SavedValue | undefined,
): AppCredentialStatus {
  if (!saved || use.status === "removing" || use.status === "missing")
    return use.status;
  return use.version !== saved.version ||
    (!!use.valueId && !!saved.valueId && use.valueId !== saved.valueId)
    ? "updating"
    : use.status;
}

/**
 * Show the caller their own apps that use a credential, and only count other accounts' apps, so
 * one account never learns another's app names.
 */
export function usageFor(
  subject: string,
  apps: readonly CredentialAppUse[],
  saved?: SavedValue,
): CredentialUsage {
  return {
    apps: apps
      .filter((app) => app.ownerId === subject)
      .map((app) => ({
        appId: app.artifactId,
        slug: app.slug,
        title: app.title,
        env: app.env,
        status: effectiveStatus(app, saved),
      })),
    otherApps: new Set(
      apps
        .filter((app) => app.ownerId !== subject)
        .map((app) => app.artifactId),
    ).size,
  };
}
