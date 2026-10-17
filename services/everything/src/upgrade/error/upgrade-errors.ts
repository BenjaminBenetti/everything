import { ApplicationError } from "@everything/errors";

/** The upgrader could not be reached, failed, or could not read the published versions. */
export class UpgradesUnavailableError extends ApplicationError {
  /** Ask the user to try again later. */
  constructor() {
    super(
      503,
      "UPGRADES_UNAVAILABLE",
      "Couldn't check for a new version right now. Try again in a moment.",
    );
  }
}

/** This installation is upgraded with the installer, or the installer has not saved its settings. */
export class UpgradesOffError extends ApplicationError {
  /** Keep the upgrader's explanation of what turns upgrades on. */
  constructor(message: string) {
    super(409, "UPGRADES_OFF", message);
  }
}

/** Another upgrade is still running. */
export class UpgradeInProgressError extends ApplicationError {
  /** Ask the user to wait for it. */
  constructor() {
    super(
      409,
      "UPGRADE_IN_PROGRESS",
      "An upgrade is already running. Wait for it to finish.",
    );
  }
}

/** The version is not a published version newer than the installed one. */
export class UpgradeVersionUnavailableError extends ApplicationError {
  /** Ask the user to check again. */
  constructor() {
    super(
      409,
      "UPGRADE_VERSION_UNAVAILABLE",
      "That version isn't available to upgrade to. Check for new versions and try again.",
    );
  }
}
