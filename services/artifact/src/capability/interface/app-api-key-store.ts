import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";

/**
 * Keeps each dynamic app's API key: the copy its backend and owner receive, and what the app host
 * verifies. The composition root chooses where the recoverable copy is kept.
 */
export interface AppApiKeyStore {
  /** The app's current key, or undefined when it has none that still verifies. */
  current(scope: WithinArtifactScope): Promise<string | undefined>;
  /** Make a new key the app's only key. */
  replace(scope: WithinArtifactScope, key: string): Promise<void>;
  /** Whether the key is the app's current key. */
  verifies(scope: WithinArtifactScope, key: string): Promise<boolean>;
  /** Stop the app's key from verifying; an app without a key succeeds. */
  revoke(scope: WithinArtifactScope): Promise<void>;
}
