import type { ArtifactSummary } from "@everything/artifact-contracts";

/** The artifacts the user can browse and open, independent of HTTP. */
export interface ArtifactLibrary {
  /** List the artifacts shared by the user's teammates. */
  list(signal?: AbortSignal): Promise<ArtifactSummary[]>;
  /** Get a link that signs the browser in to the artifact host and opens the artifact. */
  open(slug: string, path?: string): Promise<string>;
}
