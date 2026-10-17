import semver from "semver";

/**
 * Published versions an installation may upgrade to, newest first: those newer than the current
 * version, leaving out pre-releases unless the current version is one, so an installation follows
 * the release channel it was installed from.
 */
export function upgradeCandidates(
  published: readonly string[],
  current: string,
): string[] {
  const includePrereleases = semver.prerelease(current) !== null;
  return [...new Set(published)]
    .filter((version) => semver.valid(version) === version)
    .filter((version) => includePrereleases || !semver.prerelease(version))
    .filter((version) => semver.gt(version, current))
    .sort(semver.rcompare);
}

/** The newest version the installation may upgrade to, or null when it is up to date. */
export function newestUpgrade(
  published: readonly string[],
  current: string,
): string | null {
  return upgradeCandidates(published, current)[0] ?? null;
}

/** Helm stores a chart version's build metadata separator, `+`, as `_` in OCI tags. */
export function versionFromTag(tag: string): string {
  return tag.replaceAll("_", "+");
}
