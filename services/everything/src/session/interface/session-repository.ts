import type {
  Repository,
  OwnerScope,
} from "@everything/persistence/repository";
import type { StoredSession, SessionScope } from "../model/stored-session.js";

/** Capability-scoped session persistence. */
export interface SessionRepository extends Repository<
  StoredSession,
  SessionScope
> {
  /** Persist the new capability after provider authentication. */
  create(
    scope: SessionScope,
    session: Omit<StoredSession, "tokenHash">,
  ): Promise<void>;
  /** Rotate encrypted credentials within the same capability scope. */
  rotate(
    scope: SessionScope,
    id: string,
    encryptedGrant: string,
    expiresAt: Date,
  ): Promise<void>;
  /** Retire expired records belonging to an authenticated owner. */
  pruneExpired(scope: OwnerScope, now: Date): Promise<void>;
}

/** The session use case has no need to enumerate capabilities. */
export type SessionStore = Omit<SessionRepository, "list">;
