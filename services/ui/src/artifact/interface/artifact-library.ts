import type {
  ArtifactSummary,
  ArtifactVisibility,
} from "@everything/artifact-contracts";
import type {
  AppCredentialList,
  AttachCredentialInput,
} from "@everything/artifact-contracts/credential";

/** The artifacts the user can browse and open, independent of HTTP. */
export interface ArtifactLibrary {
  /** List the artifacts shared by the user's teammates. */
  list(signal?: AbortSignal): Promise<ArtifactSummary[]>;
  /** Get a link that signs the browser in to the artifact host and opens the artifact. */
  open(slug: string, path?: string): Promise<string>;
  /** Resume the app's saved release. */
  start(id: string): Promise<void>;
  /** Pause the app while keeping its release and data. */
  stop(id: string): Promise<void>;
  /** Delete a stopped or unpublished app and its saved data. */
  delete(id: string): Promise<void>;
  /** Read a dynamic app's current API key, for showing it while the user asks to see it. */
  apiKey(id: string, signal?: AbortSignal): Promise<string>;
  /** Give a dynamic app's backend one of the user's generic credentials as a variable. */
  attachCredential(
    id: string,
    input: AttachCredentialInput,
  ): Promise<AppCredentialList>;
  /** Take the credential under a variable away from an app, restarting it without the value. */
  detachCredential(id: string, env: string): Promise<AppCredentialList>;

  /** Make the app private or public, returning the app as the server saved it. */
  setVisibility(
    id: string,
    visibility: ArtifactVisibility,
  ): Promise<ArtifactSummary>;
}
