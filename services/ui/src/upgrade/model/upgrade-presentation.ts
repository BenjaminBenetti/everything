import type { UpgradeStatus } from "@everything/upgrade-contracts";

/** What the version settings offer. */
export type UpgradeOffer =
  /** An upgrade is running; Everything restarts partway through it. */
  | { readonly kind: "running"; readonly version: string }
  /** A newer version can be installed. */
  | { readonly kind: "available"; readonly version: string }
  /** The installation is on the newest version. */
  | { readonly kind: "current" }
  /** The published versions couldn't be read. */
  | { readonly kind: "unchecked" }
  /** The installer upgrades this installation. */
  | { readonly kind: "installer" }
  /** One more installer run lets Everything upgrade itself. */
  | { readonly kind: "needs-installer" };

/** A result worth pointing out above the offer. */
export type UpgradeNotice =
  /** An upgrade this page followed finished; the page still runs the previous version's code. */
  | { readonly kind: "upgraded"; readonly version: string }
  /** The last upgrade failed and the installation stayed on the version it started from. */
  | {
      readonly kind: "failed";
      readonly version: string;
      readonly reason: string;
    };

/** The version settings' content for one status. */
export interface UpgradePresentation {
  readonly offer: UpgradeOffer;
  readonly notice: UpgradeNotice | null;
}

/**
 * Decide what the version settings show. `followed` is the version of an upgrade this page saw
 * running, so only that page offers to reload once it finishes.
 */
export function presentUpgrade(
  status: UpgradeStatus,
  followed: string | null,
): UpgradePresentation {
  const last = status.lastUpgrade;
  if (last?.state === "running")
    return {
      offer: { kind: "running", version: last.toVersion },
      notice: null,
    };
  let notice: UpgradeNotice | null = null;
  if (last?.state === "failed" && last.fromVersion === status.currentVersion)
    notice = {
      kind: "failed",
      version: last.toVersion,
      reason: last.failure ?? "The upgrade stopped before it finished.",
    };
  else if (
    last?.state === "succeeded" &&
    last.toVersion === followed &&
    last.toVersion === status.currentVersion
  )
    notice = { kind: "upgraded", version: last.toVersion };
  return { offer: offer(status), notice };
}

/** The offer for an installation with no upgrade running. */
function offer(status: UpgradeStatus): UpgradeOffer {
  if (status.availability === "not-configured") return { kind: "installer" };
  if (status.availability === "needs-installer")
    return { kind: "needs-installer" };
  if (!status.versionsChecked) return { kind: "unchecked" };
  return status.latestVersion
    ? { kind: "available", version: status.latestVersion }
    : { kind: "current" };
}
