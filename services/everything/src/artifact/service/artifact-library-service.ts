import type {
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
} from "@everything/artifact-contracts";
import {
  ArtifactNotFoundError,
  ArtifactRequestFailure,
  ArtifactServiceUnavailableError,
} from "../error/artifact-errors.js";
import type { ArtifactGateway } from "../interface/artifact-gateway.js";
import type { ArtifactLibrary } from "../interface/artifact-library.js";

/** Express artifact service failures as this API's own errors. */
function translate(error: unknown): Error {
  if (error instanceof ArtifactRequestFailure && error.status === 404)
    return new ArtifactNotFoundError();
  return new ArtifactServiceUnavailableError();
}

/** Serves the browser's artifact operations through the artifact service. */
export class ArtifactLibraryService implements ArtifactLibrary {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the artifact service through its gateway. */
  constructor(
    private readonly gateway: Pick<ArtifactGateway, "list" | "view">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** List the user's artifacts. */
  async list(ownerId: string): Promise<ArtifactSummary[]> {
    try {
      return await this.gateway.list(ownerId);
    } catch (error) {
      throw translate(error);
    }
  }

  /** Issue a view link for the user. */
  async view(ownerId: string, input: ArtifactViewInput): Promise<ArtifactView> {
    try {
      return await this.gateway.view(ownerId, input);
    } catch (error) {
      throw translate(error);
    }
  }
}
