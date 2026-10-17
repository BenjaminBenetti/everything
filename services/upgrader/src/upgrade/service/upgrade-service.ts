import AsyncLock from "async-lock";
import type {
  StartUpgradeInput,
  UpgradeAvailability,
  UpgradeStatus,
} from "@everything/upgrade-contracts";
import type { ChartVersions } from "../../release/interface/chart-versions.js";
import {
  newestUpgrade,
  upgradeCandidates,
} from "../../release/model/release-versions.js";
import {
  ChartRegistryUnavailableError,
  UpgradeInProgressError,
  UpgradeSettingsMissingError,
  UpgradesNotConfiguredError,
  UpgradeVersionUnavailableError,
} from "../error/upgrade-errors.js";
import type { InstallerSettings } from "../interface/installer-settings.js";
import type { UpgradeJobs } from "../interface/upgrade-jobs.js";
import type { UpgradeOperations } from "../interface/upgrade-operations.js";

/** The installed version and whether a published chart is configured to upgrade from. */
export interface InstalledRelease {
  readonly currentVersion: string;
  readonly chartConfigured: boolean;
}

/**
 * Offers the published versions newer than the installed one and starts at most one upgrade at a
 * time. Callers choose only the version: the chart's location, the release, and its settings are
 * fixed by the installation, so no caller can install anything but a newer published release.
 */
export class UpgradeService implements UpgradeOperations {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly lock = new AsyncLock();

  /** Bind the installed release, its published versions, the installer's settings, and the Jobs. */
  constructor(
    private readonly release: InstalledRelease,
    private readonly versions: ChartVersions,
    private readonly settings: InstallerSettings,
    private readonly jobs: UpgradeJobs,
    private readonly onRegistryFailure: (error: unknown) => void = () => {},
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Report the newest upgrade, leaving it unknown when the registry cannot be read. */
  async status(): Promise<UpgradeStatus> {
    const [availability, lastUpgrade] = await Promise.all([
      this.availability(),
      this.jobs.latest(),
    ]);
    let latestVersion: string | null = null;
    let versionsChecked = false;
    if (availability !== "not-configured") {
      try {
        latestVersion = newestUpgrade(
          await this.versions.published(),
          this.release.currentVersion,
        );
        versionsChecked = true;
      } catch (error) {
        this.onRegistryFailure(error);
      }
    }
    return {
      availability,
      currentVersion: this.release.currentVersion,
      latestVersion,
      versionsChecked,
      lastUpgrade,
    };
  }

  /** Start an upgrade to a freshly confirmed newer version while no other upgrade runs. */
  start(input: StartUpgradeInput): Promise<UpgradeStatus> {
    return this.lock.acquire("upgrade", async () => {
      const availability = await this.availability();
      if (availability === "not-configured")
        throw new UpgradesNotConfiguredError();
      if (availability === "needs-installer")
        throw new UpgradeSettingsMissingError();
      if ((await this.jobs.latest())?.state === "running")
        throw new UpgradeInProgressError();
      let published: string[];
      try {
        published = await this.versions.published({ fresh: true });
      } catch (error) {
        this.onRegistryFailure(error);
        throw new ChartRegistryUnavailableError();
      }
      const current = this.release.currentVersion;
      if (!upgradeCandidates(published, current).includes(input.version))
        throw new UpgradeVersionUnavailableError();
      await this.jobs.start({ fromVersion: current, toVersion: input.version });
      return this.status();
    });
  }

  // ===========================================
  // Availability
  // ===========================================

  /** Upgrades need a published chart and the installer's settings to install it with. */
  private async availability(): Promise<UpgradeAvailability> {
    if (!this.release.chartConfigured) return "not-configured";
    return (await this.settings.saved()) ? "ready" : "needs-installer";
  }
}
