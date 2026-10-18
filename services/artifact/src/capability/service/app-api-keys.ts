import type { ArtifactApiKey } from "@everything/artifact-contracts";
import type {
  ArtifactRepository,
  WithinArtifactScope,
} from "../../artifact/interface/artifact-repository.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import type { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import type { DeploymentRepository } from "../../deployment/interface/deployment-repository.js";
import { AppApiKeyUnavailableError } from "../error/app-api-key-errors.js";
import type { AppApiKeyStore } from "../interface/app-api-key-store.js";
import { isAppApiKey } from "../model/app-api-key.js";

/**
 * Decide, from current records on every call, which app a presented key opens and whether its
 * owner can see it. Nothing is cached, so disabling the capability takes effect immediately.
 */
export class AppApiKeys {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject app records, deployments, owner-scoped lookup, and key storage. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "findBySlug">,
    private readonly deployments: Pick<DeploymentRepository, "findByRelease">,
    private readonly lookup: Pick<ArtifactLookup, "resolve">,
    private readonly keys: Pick<AppApiKeyStore, "current" | "verifies">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * The app this key opens: the dynamic app named by the slug, only while its live deployment
   * enables the capability and the key is its current one. Any other case yields undefined.
   */
  async authenticate(
    slug: string,
    key: string,
  ): Promise<WithinArtifactScope | undefined> {
    if (!isAppApiKey(key)) return undefined;
    const artifact = await this.artifacts.findBySlug({ kind: "dynamic" }, slug);
    const scope = artifact && (await this.enabled(artifact));
    return scope && (await this.keys.verifies(scope, key)) ? scope : undefined;
  }

  /** Show the owner the app's current key; missing and other owners' apps look the same. */
  async reveal(ownerId: string, reference: string): Promise<ArtifactApiKey> {
    const scope = await this.enabled(
      await this.lookup.resolve(ownerId, reference),
    );
    const apiKey = scope && (await this.keys.current(scope));
    if (!apiKey) throw new AppApiKeyUnavailableError();
    return { apiKey };
  }

  // ===========================================
  // Policy
  // ===========================================

  /** The app's scope while its live deployment enables API keys. */
  private async enabled(
    artifact: Artifact,
  ): Promise<WithinArtifactScope | undefined> {
    if (artifact.kind !== "dynamic" || artifact.liveDeployment === null)
      return undefined;
    const scope = { ownerId: artifact.ownerId, artifactId: artifact.id };
    const deployment = await this.deployments.findByRelease(
      scope,
      artifact.liveDeployment,
    );
    return deployment?.capabilities.includes("api-key") ? scope : undefined;
  }
}
