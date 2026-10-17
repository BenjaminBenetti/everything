import type {
  StartUpgradeInput,
  UpgradeStatus,
} from "@everything/upgrade-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { InstallationUpgrades } from "../interface/installation-upgrades.js";

/** Translate installation upgrades into the public API contract. */
export class HttpInstallationUpgrades implements InstallationUpgrades {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive transport policy independently from the domain adapter. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read the installed version and upgrade status. */
  status(signal?: AbortSignal): Promise<UpgradeStatus> {
    return this.transport.request<UpgradeStatus>(
      "/v1/upgrade",
      signal ? { signal } : {},
    );
  }

  /** Start an upgrade to the chosen version. */
  start(input: StartUpgradeInput): Promise<UpgradeStatus> {
    return this.transport.request<UpgradeStatus>("/v1/upgrade", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}
