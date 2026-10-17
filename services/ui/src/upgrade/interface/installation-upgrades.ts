import type {
  StartUpgradeInput,
  UpgradeStatus,
} from "@everything/upgrade-contracts";

/** Upgrading the installation to a newer published version, independent of HTTP. */
export interface InstallationUpgrades {
  /** The installed version, the newest it can upgrade to, and its latest upgrade. */
  status(signal?: AbortSignal): Promise<UpgradeStatus>;
  /** Start upgrading; Everything restarts while the upgrade runs. */
  start(input: StartUpgradeInput): Promise<UpgradeStatus>;
}
