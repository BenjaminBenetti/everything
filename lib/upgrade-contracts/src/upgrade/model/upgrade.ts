/**
 * A released version, as the release workflow tags it: a semantic version without build metadata,
 * such as 1.2.3 or 1.2.3-rc.1.
 */
export const releaseVersionPattern =
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$";
export const releaseVersionMaxLength = 128;

/** Whether this installation can upgrade itself from Everything. */
export type UpgradeAvailability =
  /** Everything can install newer published versions. */
  | "ready"
  /** No published chart is configured, as in development, so the installer upgrades it. */
  | "not-configured"
  /** The installer has not saved its settings in the cluster yet; running it once more fixes that. */
  | "needs-installer";

/** Where the most recent upgrade stands. */
export type UpgradeState = "running" | "succeeded" | "failed";

/** The most recent upgrade the installation started from Everything. */
export interface UpgradeAttempt {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly state: UpgradeState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Why a failed upgrade stopped; the installation stays on, or returns to, its previous version. */
  readonly failure: string | null;
}

/** The installation's version, the newest one it can upgrade to, and its latest upgrade. */
export interface UpgradeStatus {
  readonly availability: UpgradeAvailability;
  readonly currentVersion: string;
  /** The newest published version newer than the current one; null when there is none or it is unknown. */
  readonly latestVersion: string | null;
  /** Whether the published versions could be read, so a null latestVersion means up to date. */
  readonly versionsChecked: boolean;
  readonly lastUpgrade: UpgradeAttempt | null;
}

/** A request to upgrade to one of the published versions newer than the current one. */
export interface StartUpgradeInput {
  readonly version: string;
}
