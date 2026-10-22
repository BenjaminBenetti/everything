import type {
  CredentialAppUse,
  CredentialUsage,
} from "@everything/artifact-contracts/credential";

/**
 * Show the caller their own apps that use a credential, and only count other accounts' apps, so
 * one account never learns another's app names.
 */
export function usageFor(
  subject: string,
  apps: readonly CredentialAppUse[],
): CredentialUsage {
  return {
    apps: apps
      .filter((app) => app.ownerId === subject)
      .map(({ artifactId, slug, title, env, status }) => ({
        appId: artifactId,
        slug,
        title,
        env,
        status,
      })),
    otherApps: new Set(
      apps
        .filter((app) => app.ownerId !== subject)
        .map((app) => app.artifactId),
    ).size,
  };
}
