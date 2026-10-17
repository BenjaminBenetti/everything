import { UpgradesUnavailableError } from "../error/upgrade-errors.js";
import type { UpgradeOperations } from "../interface/upgrade-operations.js";

/** Stands in for the upgrader when Everything is configured without one. */
export class UnavailableUpgrades implements UpgradeOperations {
  /** Report upgrades as unavailable. */
  async status(): Promise<never> {
    throw new UpgradesUnavailableError();
  }

  /** Refuse to start an upgrade. */
  async start(): Promise<never> {
    throw new UpgradesUnavailableError();
  }
}
