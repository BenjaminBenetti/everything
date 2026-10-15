import type {
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
} from "@everything/artifact-contracts";
import {
  ArtifactNotFoundError,
  ArtifactRequestFailure,
  ArtifactServiceUnavailableError,
  AppActionConflictError,
} from "../error/artifact-errors.js";
import type { ArtifactGateway } from "../interface/artifact-gateway.js";
import type { ArtifactLibrary } from "../interface/artifact-library.js";

/** Express artifact service failures as this API's own errors. */
function translate(error: unknown): Error {
  if (error instanceof ArtifactRequestFailure && error.status === 404)
    return new ArtifactNotFoundError();
  if (error instanceof ArtifactRequestFailure && error.status === 409)
    return new AppActionConflictError();
  return new ArtifactServiceUnavailableError();
}

/** Serves the browser's artifact operations through the artifact service. */
export class ArtifactLibraryService implements ArtifactLibrary {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the artifact service through its gateway. */
  constructor(
    private readonly gateway: Pick<
      ArtifactGateway,
      "list" | "view" | "start" | "stop" | "delete"
    >,
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

  /** Resume the owner's saved app release. */
  start(ownerId: string, id: string): Promise<void> {
    return this.change(ownerId, id, "start");
  }

  /** Stop the owner's app while retaining its data. */
  stop(ownerId: string, id: string): Promise<void> {
    return this.change(ownerId, id, "stop");
  }

  /** Remove the owner's app only while it remains stopped or unpublished. */
  delete(ownerId: string, id: string): Promise<void> {
    return this.change(ownerId, id, "delete");
  }

  // ===========================================
  // Manual actions
  // ===========================================

  /** Derive ownership and human authorship from the verified subject, hiding upstream details. */
  private async change(
    ownerId: string,
    id: string,
    action: "start" | "stop" | "delete",
  ): Promise<void> {
    const actor = { ownerId, author: { id: ownerId, name: "You" } };
    try {
      if (action === "delete") await this.gateway.delete(actor, id, true);
      else await this.gateway[action](actor, id);
    } catch (error) {
      throw translate(error);
    }
  }
}
