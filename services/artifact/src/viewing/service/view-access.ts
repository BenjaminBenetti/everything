import { randomBytes } from "node:crypto";
import type {
  ArtifactView,
  ArtifactViewInput,
} from "@everything/artifact-contracts";
import { ArtifactNotFoundError } from "../../artifact/error/artifact-errors.js";
import type { ArtifactRepository } from "../../artifact/interface/artifact-repository.js";
import { InvalidViewPathError } from "../error/view-errors.js";
import type {
  ViewGrantRepository,
  ViewSessionRepository,
} from "../interface/view-repositories.js";
import {
  artifactPathPattern,
  credentialHash,
  grantLifetimeMs,
  viewSessionLifetimeMs,
} from "../model/view-credential.js";

/** A redeemed view link: the new session's secret and the path to open. */
export interface RedeemedView {
  readonly sessionToken: string;
  readonly next: string;
}

/** Signs viewers in to the artifact host with one-time links issued for the signed-in user. */
export class ViewAccess {
  // ===========================================
  // Construction
  // ===========================================

  /** Inject artifact lookup, credential storage, and the artifact host's origin. */
  constructor(
    private readonly artifacts: Pick<ArtifactRepository, "findBySlug">,
    private readonly grants: ViewGrantRepository,
    private readonly sessions: ViewSessionRepository,
    private readonly artifactOrigin: string,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Issue a link that signs the owner in and opens the artifact; the destination stays server-side. */
  async grant(
    ownerId: string,
    input: ArtifactViewInput,
  ): Promise<ArtifactView> {
    const path = input.path ?? "/";
    if (!artifactPathPattern.test(path)) throw new InvalidViewPathError();
    if (!(await this.artifacts.findBySlug({ ownerId }, input.slug)))
      throw new ArtifactNotFoundError();
    const code = randomBytes(32).toString("base64url");
    await this.grants.create({
      ownerId,
      tokenHash: credentialHash(code),
      next: `/${input.slug}${path}`,
      expiresAt: new Date(Date.now() + grantLifetimeMs).toISOString(),
    });
    return { url: `${this.artifactOrigin}/_access?code=${code}` };
  }

  /** Use a link once and start a session; expired, used, and unknown links yield undefined. */
  async redeem(code: string): Promise<RedeemedView | undefined> {
    const grant = await this.grants.consume({
      tokenHash: credentialHash(code),
    });
    if (!grant) return undefined;
    const sessionToken = randomBytes(32).toString("base64url");
    await this.sessions.create({
      ownerId: grant.ownerId,
      tokenHash: credentialHash(sessionToken),
      expiresAt: new Date(Date.now() + viewSessionLifetimeMs).toISOString(),
    });
    return { sessionToken, next: grant.next };
  }

  /** The owner signed in with this session token, if it is valid. */
  async viewer(sessionToken: string | undefined): Promise<string | undefined> {
    if (!sessionToken) return undefined;
    return (
      await this.sessions.findValid({ tokenHash: credentialHash(sessionToken) })
    )?.ownerId;
  }

  /** End the session with this token, if it is valid, so it opens nothing from now on. */
  async signOut(sessionToken: string): Promise<void> {
    const scope = { tokenHash: credentialHash(sessionToken) };
    const session = await this.sessions.findValid(scope);
    if (session) await this.sessions.delete(scope, session.id);
  }

  /** Delete expired links and sessions. */
  async purge(): Promise<void> {
    const expiredBefore = new Date().toISOString();
    await this.grants.purge({ expiredBefore });
    await this.sessions.purge({ expiredBefore });
  }
}
