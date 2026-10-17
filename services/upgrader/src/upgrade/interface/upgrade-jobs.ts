import type { UpgradeAttempt } from "@everything/upgrade-contracts";

/** The versions one upgrade moves between. */
export interface UpgradeRequest {
  readonly fromVersion: string;
  readonly toVersion: string;
}

/** Upgrades run outside the service, which the upgrade itself replaces. */
export interface UpgradeJobs {
  /** The most recently started upgrade, or null when there is none on record. */
  latest(): Promise<UpgradeAttempt | null>;
  /** Start an upgrade that runs on its own until it succeeds or rolls back. */
  start(request: UpgradeRequest): Promise<void>;
}
