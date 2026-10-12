import type { Repository } from "@everything/persistence/repository";
import type {
  ProviderCheckScope,
  ProviderCheckTarget,
} from "../model/provider-check.js";

/** Internal maintenance queries never expose credentials or serve user-facing provider reads. */
export interface ProviderCheckRepository extends Repository<
  ProviderCheckTarget,
  ProviderCheckScope
> {}

/** The scheduler can discover due work but cannot alter or delete connection records. */
export type ProviderCheckSource = Pick<ProviderCheckRepository, "list">;
