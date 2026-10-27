import { randomBytes } from "node:crypto";
import type {
  ArtifactViewPass,
  ArtifactViewPassInput,
} from "@everything/artifact-contracts";
import type { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { InvalidViewPathError } from "../error/view-errors.js";
import type { ViewPassRepository } from "../interface/view-repositories.js";
import {
  artifactPathPattern,
  credentialHash,
  viewPassLifetimeMs,
  viewPassPrefix,
  viewPassSignInPath,
  type ViewPass,
} from "../model/view-credential.js";

/**
 * Lets teammates view one artifact from inside the cluster, as the user sees it, with short-lived
 * passes issued to Everything on their behalf.
 */
export class ViewPasses {
  // ===========================================
  // Construction
  // ===========================================

  /** Resolve artifacts within the owner's scope and store passes by hash. */
  constructor(
    private readonly artifacts: Pick<ArtifactLookup, "resolve">,
    private readonly passes: ViewPassRepository,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Issue a pass that opens only this artifact; missing and other owners' artifacts look the same. A
   * public artifact gets its page on the public apps host instead, and no pass is stored.
   */
  async issue(
    ownerId: string,
    reference: string,
    input: ArtifactViewPassInput,
  ): Promise<ArtifactViewPass> {
    const path = input.path ?? "/";
    if (!artifactPathPattern.test(path)) throw new InvalidViewPathError();
    const artifact = await this.artifacts.resolve(ownerId, reference);
    if (artifact.visibility === "public")
      return { visibility: "public", path: `/${artifact.slug}${path}` };
    const token = viewPassPrefix + randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + viewPassLifetimeMs).toISOString();
    await this.passes.create({
      ownerId,
      artifactId: artifact.id,
      tokenHash: credentialHash(token),
      path,
      expiresAt,
    });
    return {
      visibility: "private",
      token,
      path: `/${artifact.slug}${path}`,
      signInPath: `${viewPassSignInPath}?${new URLSearchParams({ token })}`,
      expiresAt,
    };
  }

  /** The unexpired pass with this token; anything else, including other secrets, yields undefined. */
  async find(token: string | undefined): Promise<ViewPass | undefined> {
    if (!token?.startsWith(viewPassPrefix)) return undefined;
    return this.passes.findValid({ tokenHash: credentialHash(token) });
  }

  /** Delete expired passes. */
  async purge(): Promise<void> {
    await this.passes.purge({ expiredBefore: new Date().toISOString() });
  }
}
