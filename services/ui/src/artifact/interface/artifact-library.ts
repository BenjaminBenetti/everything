import type { ArtifactSummary } from "@everything/artifact-contracts";

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
}
