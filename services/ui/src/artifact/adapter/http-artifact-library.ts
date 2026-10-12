import type {
  ArtifactList,
  ArtifactSummary,
  ArtifactView,
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
}
