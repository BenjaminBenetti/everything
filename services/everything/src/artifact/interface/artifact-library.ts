import type {
  ArtifactApiKey,
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
  ArtifactVisibility,
} from "@everything/artifact-contracts";

/** The owner's app library and manual lifecycle controls. */
export interface ArtifactLibrary {
  /** List the user's artifacts. */
  list(ownerId: string): Promise<ArtifactSummary[]>;
  /** Issue a link that signs the user in to the artifact host and opens the artifact. */
  view(ownerId: string, input: ArtifactViewInput): Promise<ArtifactView>;
  /** Resume an app's saved release. */
  start(ownerId: string, id: string): Promise<void>;
  /** Stop serving an app while preserving its data. */
  stop(ownerId: string, id: string): Promise<void>;
  /** Delete a stopped or unpublished app and its data. */
  delete(ownerId: string, id: string): Promise<void>;
  /** Show the current API key of the owner's app. */
  apiKey(ownerId: string, id: string): Promise<ArtifactApiKey>;
  /** Make the owner's app private or public; callers must have verified the owner is signed in. */
  setVisibility(
    ownerId: string,
    id: string,
    visibility: ArtifactVisibility,
  ): Promise<ArtifactSummary>;
}
