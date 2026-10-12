import type { ProviderId } from "@everything/provider-contracts";

/** The daily worker can refresh due connections without editing settings or exposing credentials. */
export interface ProviderChecks {
  /** Recheck the persisted schedule inside the owner/provider lock before making a request. */
  verifyIfDue(ownerId: string, provider: ProviderId): Promise<void>;
}
