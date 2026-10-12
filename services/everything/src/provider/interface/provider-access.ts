import type { ProviderId } from "@everything/provider-contracts";
import type { VerificationInput } from "./connection-verifier.js";

/** Internal credential access; never passed to HTTP presenters. */
export interface ProviderAccess {
  /** Require an active owner connection and retain refreshed credentials before use. */
  access(ownerId: string, provider: ProviderId): Promise<VerificationInput>;
}
