import type { OwnedEntity } from "@everything/persistence/entity";
import type { ProviderId } from "@everything/provider-contracts";

/** Credential-free identity of a persisted connection due for background maintenance. */
export interface ProviderCheckTarget extends OwnedEntity {
  readonly provider: ProviderId;
}

/** Internal maintenance scope, limited to configured connections due by this cutoff. */
export interface ProviderCheckScope {
  readonly checkedBefore: Date;
}
