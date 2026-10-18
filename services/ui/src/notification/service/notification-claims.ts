import { browserStorage, type StorageAccess } from "./browser-storage.js";

const storageKey = "everything-notified-messages";
const lockName = "everything-notified-messages";
/** Claims older than a day can't match a message still being observed. */
const claimLifetime = 24 * 60 * 60 * 1000;
const claimsMax = 300;

/** Decides once, across this browser's tabs, who handles each delivered message. */
export interface NotificationClaimStore {
  /** True for the first claim of a message ID in this browser; false for every later one. */
  claim(messageId: string): Promise<boolean>;
}

/** The Web Locks API, which makes a claim atomic across this browser's tabs. */
export type ClaimLocks = Pick<LockManager, "request">;

/** Read the Web Locks API where the browser has it. */
function browserLocks(): ClaimLocks | null {
  return globalThis.navigator?.locks ?? null;
}

/**
 * Remember handled message IDs in browser storage, so several open tabs notify about a message
 * once. The Web Locks API makes each claim atomic across tabs; without it, or without storage,
 * claims still hold within the tab.
 */
export class NotificationClaims implements NotificationClaimStore {
  // ===========================================
  // Construction
  // ===========================================
  private readonly local = new Set<string>();

  /** Use the browser's storage and locks unless a test supplies its own. */
  constructor(
    private readonly storage: StorageAccess = browserStorage,
    private readonly locks: ClaimLocks | null = browserLocks(),
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================
  // Claims
  // ===========================================

  /** Claim a message ID within this tab first, then across tabs. */
  async claim(messageId: string): Promise<boolean> {
    if (this.local.has(messageId)) return false;
    this.local.add(messageId);
    if (!this.locks) return this.record(messageId);
    try {
      return await this.locks.request(lockName, () => this.record(messageId));
    } catch {
      return this.record(messageId);
    }
  }

  /** Add the ID to the shared list unless another tab already did; an unreadable list allows the claim. */
  private record(messageId: string): boolean {
    try {
      const storage = this.storage();
      if (!storage) return true;
      const now = this.now();
      const claims = parseClaims(storage.getItem(storageKey)).filter(
        ([, claimedAt]) => now - claimedAt < claimLifetime,
      );
      if (claims.some(([claimed]) => claimed === messageId)) return false;
      claims.push([messageId, now]);
      storage.setItem(storageKey, JSON.stringify(claims.slice(-claimsMax)));
      return true;
    } catch {
      return true;
    }
  }
}

/** Read stored `[messageId, claimedAt]` pairs, ignoring anything malformed. */
function parseClaims(value: string | null): [string, number][] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (claim): claim is [string, number] =>
            Array.isArray(claim) &&
            typeof claim[0] === "string" &&
            typeof claim[1] === "number",
        )
      : [];
  } catch {
    return [];
  }
}
