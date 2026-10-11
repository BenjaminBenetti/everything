import { createHash, randomBytes, randomUUID } from "node:crypto";
import AsyncLock from "async-lock";
import {
  AuthenticationFailure,
  type PasswordAuthentication,
  type SessionGrant,
} from "@everything/security/password-grant";
import type { SecretCipher } from "@everything/security/session-cipher";
import type {
  SessionCredentials,
  SessionProfile,
} from "@everything/security/browser";
import type { SessionStore } from "../interface/session-repository.js";
import type { SessionOperations } from "../interface/session-operations.js";
import {
  sessionLifetimeMs,
  type SessionScope,
  type StoredSession,
} from "../model/stored-session.js";
import { SignInRejected, SignInUnavailable } from "../error/session-errors.js";

/** Own session lifetimes, credential rotation, and revocation in the single API replica. */
export class SessionService implements SessionOperations {
  // ===========================================
  // Construction
  // ===========================================

  private readonly lock = new AsyncLock();

  /** Receive narrow persistence, provider, and encryption contracts. */
  constructor(
    private readonly store: SessionStore,
    private readonly provider: PasswordAuthentication,
    private readonly cipher: SecretCipher,
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Mint a fresh capability only after authentication and revoke the prior cookie. */
  async signIn(
    credentials: SessionCredentials,
    previous?: string,
  ): Promise<{ handle: string; profile: SessionProfile }> {
    let grant: SessionGrant;
    try {
      grant = await this.provider.authenticate(credentials);
    } catch (error) {
      throw error instanceof AuthenticationFailure &&
        error.reason === "rejected"
        ? new SignInRejected()
        : new SignInUnavailable();
    }
    try {
      await this.signOut(previous);
      const now = this.now();
      await this.store.pruneExpired(
        { ownerId: grant.profile.subject },
        new Date(now),
      );
      const id = randomUUID();
      const handle = id + "." + randomBytes(32).toString("base64url");
      await this.store.create(this.capability(handle)!.scope, {
        id,
        ownerId: grant.profile.subject,
        createdAt: new Date(now).toISOString(),
        encryptedGrant: await this.cipher.seal(JSON.stringify(grant)),
        expiresAt: new Date(
          Math.min(now + sessionLifetimeMs, grant.refreshExpiresAt),
        ),
      });
      return { handle, profile: grant.profile };
    } catch (error) {
      await this.provider.revoke(grant.refreshToken).catch(() => undefined);
      throw error;
    }
  }

  /** Serialize reads and refreshes so rotating refresh tokens are never reused across tabs. */
  async resolve(
    handle?: string,
  ): Promise<{ accessToken: string; profile: SessionProfile } | undefined> {
    const capability = this.capability(handle);
    if (!capability) return undefined;
    return this.lock.acquire(capability.id, async () => {
      const { id, scope } = capability;
      const record = await this.store.getById(scope, id);
      if (!record) return undefined;
      let grant = await this.readGrant(record);
      if (
        !grant ||
        record.expiresAt.getTime() <= this.now() ||
        grant.refreshExpiresAt <= this.now()
      ) {
        await this.store.delete(scope, id);
        return undefined;
      }
      if (grant.accessExpiresAt <= this.now() + 30_000) {
        try {
          grant = await this.provider.refresh(grant.refreshToken);
        } catch (error) {
          if (
            !(error instanceof AuthenticationFailure) ||
            error.reason !== "rejected"
          )
            throw new SignInUnavailable();
          await this.store.delete(scope, id);
          return undefined;
        }
        if (grant.profile.subject !== record.ownerId) {
          await this.store.delete(scope, id);
          await this.provider.revoke(grant.refreshToken).catch(() => undefined);
          return undefined;
        }
        try {
          await this.store.rotate(
            scope,
            id,
            await this.cipher.seal(JSON.stringify(grant)),
            new Date(
              Math.min(
                new Date(record.createdAt).getTime() + sessionLifetimeMs,
                grant.refreshExpiresAt,
              ),
            ),
          );
        } catch (error) {
          await this.provider.revoke(grant.refreshToken).catch(() => undefined);
          throw error;
        }
      }
      return { accessToken: grant.accessToken, profile: grant.profile };
    });
  }

  /** Delete locally before best-effort provider revocation, even when Keycloak is unavailable. */
  async signOut(handle?: string): Promise<void> {
    const capability = this.capability(handle);
    if (!capability) return;
    await this.lock.acquire(capability.id, async () => {
      const { id, scope } = capability;
      const record = await this.store.getById(scope, id);
      if (!record) return;
      await this.store.delete(scope, id);
      const grant = await this.readGrant(record);
      if (grant)
        await this.provider.revoke(grant.refreshToken).catch(() => undefined);
    });
  }

  // ===========================================
  // Credential boundary
  // ===========================================

  /** Validate the fixed-format cookie before querying and hash its high-entropy secret. */
  private capability(
    handle?: string,
  ): { id: string; scope: SessionScope } | undefined {
    if (
      !handle ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(
        handle,
      )
    )
      return undefined;
    return {
      id: handle.slice(0, 36),
      scope: { tokenHash: createHash("sha256").update(handle).digest("hex") },
    };
  }

  /** Fail closed for tampered records, changed keys, or an identity mismatch. */
  private async readGrant(
    record: StoredSession,
  ): Promise<SessionGrant | undefined> {
    try {
      const grant = JSON.parse(
        await this.cipher.open(record.encryptedGrant),
      ) as SessionGrant;
      return grant.profile.subject === record.ownerId ? grant : undefined;
    } catch {
      return undefined;
    }
  }
}
