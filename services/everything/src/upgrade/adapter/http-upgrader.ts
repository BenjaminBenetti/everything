import type {
  StartUpgradeInput,
  UpgradeStatus,
} from "@everything/upgrade-contracts";
import type { AccessTokenSource } from "@everything/security/client-credentials";
import {
  UpgradeInProgressError,
  UpgradesOffError,
  UpgradesUnavailableError,
  UpgradeVersionUnavailableError,
} from "../error/upgrade-errors.js";
import type { UpgradeOperations } from "../interface/upgrade-operations.js";

/** Requests give up after this long; starting an upgrade only creates its Job. */
const requestTimeoutMs = 20_000;

/** A failure answer from the upgrader. */
interface UpgraderFailure {
  readonly code?: string;
  readonly message?: string;
}

/**
 * Calls the upgrader inside the cluster with Everything's service account token, which only it
 * accepts. Its refusals become Everything's own errors; anything else means upgrades are unavailable.
 */
export class HttpUpgrader implements UpgradeOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the upgrader's address and the token source; the fetcher is replaceable for tests. */
  constructor(
    private readonly url: string,
    private readonly tokens: AccessTokenSource,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read the installation's version and upgrade status. */
  status(): Promise<UpgradeStatus> {
    return this.request("GET");
  }

  /** Ask the upgrader to start an upgrade. */
  start(input: StartUpgradeInput): Promise<UpgradeStatus> {
    return this.request("POST", { version: input.version });
  }

  // ===========================================
  // Upgrader boundary
  // ===========================================

  /** Send one request, mapping the upgrader's refusals and treating everything else as unavailable. */
  private async request(
    method: "GET" | "POST",
    body?: StartUpgradeInput,
  ): Promise<UpgradeStatus> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}/v1/upgrade`, {
        method,
        headers: {
          authorization: `Bearer ${await this.tokens.token()}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new UpgradesUnavailableError();
    }
    if (response.ok) return (await response.json()) as UpgradeStatus;
    let failure: UpgraderFailure = {};
    try {
      failure = (await response.json()) as UpgraderFailure;
    } catch {
      // A body that is not JSON carries no caller-safe message.
    }
    throw refusal(response.status, failure);
  }
}

/** Everything's error for an upgrader refusal. */
function refusal(status: number, failure: UpgraderFailure): Error {
  if (status === 409)
    switch (failure.code) {
      case "UPGRADES_NOT_CONFIGURED":
      case "UPGRADE_SETTINGS_MISSING":
        return new UpgradesOffError(
          failure.message ?? "This installation doesn't upgrade itself.",
        );
      case "UPGRADE_IN_PROGRESS":
        return new UpgradeInProgressError();
      case "UPGRADE_VERSION_UNAVAILABLE":
        return new UpgradeVersionUnavailableError();
    }
  return new UpgradesUnavailableError();
}
