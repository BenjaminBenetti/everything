import type {
  StartUpgradeInput,
  UpgradeStatus,
} from "@everything/upgrade-contracts";

/** The upgrade use cases the HTTP API serves. */
export interface UpgradeOperations {
  /** The installation's version, the newest it can upgrade to, and its latest upgrade. */
  status(): Promise<UpgradeStatus>;
  /** Start upgrading to a published version newer than the current one. */
  start(input: StartUpgradeInput): Promise<UpgradeStatus>;
}
