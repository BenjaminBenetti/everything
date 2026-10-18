import type { Repository } from "@everything/persistence/repository";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { AppApiKeyRecord } from "../model/app-api-key.js";

/** Persistence boundary for API key verification records, one per app. */
export interface AppApiKeyRepository extends Repository<
  AppApiKeyRecord,
  WithinArtifactScope
> {
  /** The app's record, if it has a key. */
  find(scope: WithinArtifactScope): Promise<AppApiKeyRecord | undefined>;
  /** Atomically replace the app's record with one for a new key. */
  replace(scope: WithinArtifactScope, keyHash: string): Promise<void>;
  /** Delete the app's record; an absent record succeeds. */
  revoke(scope: WithinArtifactScope): Promise<void>;
}
