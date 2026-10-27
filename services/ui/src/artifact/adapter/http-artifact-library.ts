import type {
  ArtifactApiKey,
  ArtifactList,
  ArtifactSummary,
  ArtifactView,
  ArtifactVisibility,
} from "@everything/artifact-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { ArtifactLibrary } from "../interface/artifact-library.js";

/** Translate library operations into the public API contract. */
export class HttpArtifactLibrary implements ArtifactLibrary {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive transport policy independently from the domain adapter. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read the shared artifacts. */
  async list(signal?: AbortSignal): Promise<ArtifactSummary[]> {
    const result = await this.transport.request<ArtifactList>(
      "/v1/artifacts",
      signal ? { signal } : {},
    );
    return [...result.artifacts];
  }

  /** Request a one-time link to the artifact. */
  async open(slug: string, path?: string): Promise<string> {
    const view = await this.transport.request<ArtifactView>(
      "/v1/artifact-views",
      {
        method: "POST",
        body: JSON.stringify(path ? { slug, path } : { slug }),
      },
    );
    return view.url;
  }

  /** Resume the saved release without publishing a new one. */
  async start(id: string): Promise<void> {
    await this.transport.request(
      `/v1/artifacts/${encodeURIComponent(id)}/start`,
      {
        method: "POST",
      },
    );
  }

  /** Stop serving the app while retaining its files and data. */
  async stop(id: string): Promise<void> {
    await this.transport.request(
      `/v1/artifacts/${encodeURIComponent(id)}/stop`,
      {
        method: "POST",
      },
    );
  }

  /** Read the app's API key from the uncached endpoint; it is never stored in the browser. */
  async apiKey(id: string, signal?: AbortSignal): Promise<string> {
    const result = await this.transport.request<ArtifactApiKey>(
      `/v1/artifacts/${encodeURIComponent(id)}/api-key`,
      signal ? { signal } : {},
    );
    return result.apiKey;
  }

  /** Change who can open the app; only a same-origin request from the signed-in owner is accepted. */
  setVisibility(
    id: string,
    visibility: ArtifactVisibility,
  ): Promise<ArtifactSummary> {
    return this.transport.request<ArtifactSummary>(
      `/v1/artifacts/${encodeURIComponent(id)}/visibility`,
      { method: "PUT", body: JSON.stringify({ visibility }) },
    );
  }

  /** Permanently remove a stopped or unpublished app. */
  async delete(id: string): Promise<void> {
    await this.transport.request(`/v1/artifacts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}
