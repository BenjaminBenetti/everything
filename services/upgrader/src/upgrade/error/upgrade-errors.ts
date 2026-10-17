import { ApplicationError } from "@everything/errors";

/** No published chart is configured, as in development. */
export class UpgradesNotConfiguredError extends ApplicationError {
  /** Point to the installer, which upgrades such installations. */
  constructor() {
    super(
      409,
      "UPGRADES_NOT_CONFIGURED",
      "This installation doesn't upgrade itself. Use the installer to upgrade it.",
    );
  }
}

/** The installer has not saved its settings in the cluster. */
export class UpgradeSettingsMissingError extends ApplicationError {
  /** Ask for one more installer run, which saves them. */
  constructor() {
    super(
      409,
      "UPGRADE_SETTINGS_MISSING",
      "Run the installer once more to let Everything upgrade itself.",
    );
  }
}

/** Another upgrade is still running. */
export class UpgradeInProgressError extends ApplicationError {
  /** Ask the caller to wait for it. */
  constructor() {
    super(
      409,
      "UPGRADE_IN_PROGRESS",
      "An upgrade is already running. Wait for it to finish.",
    );
  }
}

/** The version is not a published version newer than the current one. */
export class UpgradeVersionUnavailableError extends ApplicationError {
  /** Ask the caller to choose from the versions offered. */
  constructor() {
    super(
      409,
      "UPGRADE_VERSION_UNAVAILABLE",
      "That version isn't available to upgrade to. Check for new versions and try again.",
    );
  }
}

/** The chart registry could not list the published versions. */
export class ChartRegistryUnavailableError extends ApplicationError {
  /** Ask the caller to try again later. */
  constructor() {
    super(
      503,
      "CHART_REGISTRY_UNAVAILABLE",
      "Couldn't check for new versions right now. Try again in a moment.",
    );
  }
}
