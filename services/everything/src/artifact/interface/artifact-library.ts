import type {
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
} from "@everything/artifact-contracts";

/** What the user's browser can do with artifacts: list them and open one. */
export interface ArtifactLibrary {
  /** List the user's artifacts. */
  list(ownerId: string): Promise<ArtifactSummary[]>;
  /** Issue a link that signs the user in to the artifact host and opens the artifact. */
  view(ownerId: string, input: ArtifactViewInput): Promise<ArtifactView>;
}
