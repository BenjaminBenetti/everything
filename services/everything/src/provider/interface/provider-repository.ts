import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { StoredProvider } from "../model/stored-provider.js";

/** Persist a connection only inside its authenticated owner's scope. */
export interface ProviderRepository extends Repository<
  StoredProvider,
  OwnerScope
> {
  /** Insert a new connection or replace the scoped record. */
  save(scope: OwnerScope, connection: StoredProvider): Promise<void>;
}

export type ProviderStore = Pick<
  ProviderRepository,
  "list" | "save" | "delete"
>;
