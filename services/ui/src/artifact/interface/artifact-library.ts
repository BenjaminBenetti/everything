import type {
  ArtifactSummary,
  ArtifactVisibility,
} from "@everything/artifact-contracts";

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
  /** Make the app private or public, returning the app as the server saved it. */
  setVisibility(
    id: string,
    visibility: ArtifactVisibility,
  ): Promise<ArtifactSummary>;
}
