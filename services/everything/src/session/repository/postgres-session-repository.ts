import {
  LessThanOrEqual,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import {
  BaseRepository,
  type OwnerScope,
} from "@everything/persistence/repository";
import type { SessionRepository } from "../interface/session-repository.js";
import type { SessionScope, StoredSession } from "../model/stored-session.js";
import { SessionEntity } from "../schema/session-entity.js";

/** Store encrypted grants with the same scoped ORM defaults as other domains. */
export class PostgresSessionRepository
  extends BaseRepository<StoredSession, SessionScope>
  implements SessionRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the session mapping and stable chronological ordering. */
  constructor(database: DataSource) {
    super(database.getRepository(SessionEntity), {
      order: { createdAt: "ASC", id: "ASC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Insert a fresh capability; no plaintext handle is written to disk. */
  async create(
    scope: SessionScope,
    session: Omit<StoredSession, "tokenHash">,
  ): Promise<void> {
    this.scopeWhere(scope);
    await this.orm.insert({ ...session, tokenHash: scope.tokenHash });
  }

  /** Apply scope directly in the token rotation update. */
  async rotate(
    scope: SessionScope,
    id: string,
    encryptedGrant: string,
    expiresAt: Date,
  ): Promise<void> {
    if (!id) throw new Error("A session identifier is required");
    await this.orm.update(
      { ...this.scopeWhere(scope), id },
      { encryptedGrant, expiresAt },
    );
  }

  /** Clean up expired sessions only after verifying their owner through sign-in. */
  async pruneExpired({ ownerId }: OwnerScope, now: Date): Promise<void> {
    if (!ownerId) throw new Error("An owner is required");
    await this.orm.delete({ ownerId, expiresAt: LessThanOrEqual(now) });
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Refuse missing capability scopes before any database operation. */
  protected scopeWhere({
    tokenHash,
  }: SessionScope): FindOptionsWhere<StoredSession> {
    if (!tokenHash) throw new Error("A session capability is required");
    return { tokenHash };
  }

  /** Preserve the encrypted record for the session service. */
  protected toEntity(record: StoredSession): StoredSession {
    return record;
  }
}
