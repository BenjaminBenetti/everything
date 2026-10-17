import type {
  StartUpgradeInput,
  UpgradeStatus,
} from "@everything/upgrade-contracts";

/** Upgrading the installation to a newer published version, independent of the upgrader's transport. */
export interface UpgradeOperations {
  /** The installation's version, the newest it can upgrade to, and its latest upgrade. */
  status(): Promise<UpgradeStatus>;
  /** Start upgrading to a published version newer than the installed one. */
  start(input: StartUpgradeInput): Promise<UpgradeStatus>;
}
