import type {
  ArtifactApiKey,
  ArtifactSummary,
  ArtifactView,
  ArtifactViewInput,
} from "@everything/artifact-contracts";
import {
  AppApiKeyUnavailableError,
  ArtifactNotFoundError,
  ArtifactRequestFailure,
  ArtifactServiceUnavailableError,
  AppActionConflictError,
} from "../error/artifact-errors.js";
import type { ArtifactGateway } from "../interface/artifact-gateway.js";
import type { ArtifactLibrary } from "../interface/artifact-library.js";
import type { CredentialGrants } from "../../credential/service/credential-grants.js";

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

  /** Use the artifact service through its gateway, naming credentials from the key store. */
  constructor(
    private readonly gateway: Pick<
      ArtifactGateway,
      "list" | "view" | "start" | "stop" | "delete" | "apiKey"
    >,
    private readonly credentials: Pick<CredentialGrants, "named">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** List the user's artifacts with their credentials' current names. */
  async list(ownerId: string): Promise<ArtifactSummary[]> {
    let artifacts: ArtifactSummary[];
    try {
      artifacts = await this.gateway.list(ownerId);
    } catch (error) {
      throw translate(error);
    }
    return Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        credentials: await this.credentials.named(artifact.credentials ?? []),
      })),
    );
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

  /** Show the app's API key; a conflict means the app has no key to show. */
  async apiKey(ownerId: string, id: string): Promise<ArtifactApiKey> {
    try {
      return await this.gateway.apiKey(ownerId, id);
    } catch (error) {
      if (error instanceof ArtifactRequestFailure && error.status === 409)
        throw new AppApiKeyUnavailableError();
      throw translate(error);
    }
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
