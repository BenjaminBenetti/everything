import { randomUUID } from "node:crypto";
import {
  IsNull,
  LessThan,
  MoreThan,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import type {
  CredentialScope,
  ExpiredScope,
  TokenScope,
  ViewGrantRepository,
  ViewSessionRepository,
} from "../interface/view-repositories.js";
import type { ViewGrant, ViewSession } from "../model/view-credential.js";
import { ViewGrantEntity, ViewSessionEntity } from "../schema/view-entities.js";

/** Scope a credential query to one token or to expired credentials. */
function credentialWhere(
  scope: CredentialScope,
): { tokenHash: string } | { expiresAt: ReturnType<typeof LessThan<string>> } {
  if ("tokenHash" in scope) {
    if (!scope.tokenHash) throw new Error("A token is required");
    return { tokenHash: scope.tokenHash };
  }
  if (!scope.expiredBefore) throw new Error("An expiry time is required");
  return { expiresAt: LessThan(scope.expiredBefore) };
}

/** Persist one-time view links. */
export class PostgresViewGrantRepository
  extends BaseRepository<ViewGrant, CredentialScope>
  implements ViewGrantRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository; links are never listed in order. */
  constructor(database: DataSource) {
    super(database.getRepository(ViewGrantEntity), {});
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Save a new, unused link. */
  async create(
    grant: Omit<ViewGrant, "id" | "createdAt" | "usedAt">,
  ): Promise<void> {
    await this.orm.insert({ ...grant, id: randomUUID(), usedAt: null });
  }

  /** Use the link in one conditional update, so it can be redeemed only once. */
  async consume(scope: TokenScope): Promise<ViewGrant | undefined> {
    const now = new Date().toISOString();
    const result = await this.orm.update(
      { ...this.scopeWhere(scope), usedAt: IsNull(), expiresAt: MoreThan(now) },
      { usedAt: now },
    );
    return result.affected ? this.getByToken(scope) : undefined;
  }

  /** Delete links in scope. */
  async purge(scope: ExpiredScope): Promise<void> {
    await this.orm.delete(this.scopeWhere(scope));
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Scope to one link's token or to expired links. */
  protected scopeWhere(scope: CredentialScope): FindOptionsWhere<ViewGrant> {
    return credentialWhere(scope);
  }

  /** Links contain no persistence-only fields. */
  protected toEntity(record: ViewGrant): ViewGrant {
    return record;
  }

  /** Read a link by its token. */
  private async getByToken(scope: TokenScope): Promise<ViewGrant | undefined> {
    return (await this.orm.findOneBy(this.scopeWhere(scope))) ?? undefined;
  }
}

/** Persist artifact host sessions. */
export class PostgresViewSessionRepository
  extends BaseRepository<ViewSession, CredentialScope>
  implements ViewSessionRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository; sessions are never listed in order. */
  constructor(database: DataSource) {
    super(database.getRepository(ViewSessionEntity), {});
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Save a new session. */
  async create(session: Omit<ViewSession, "id" | "createdAt">): Promise<void> {
    await this.orm.insert({ ...session, id: randomUUID() });
  }

  /** Find the session if it has not expired. */
  async findValid(scope: TokenScope): Promise<ViewSession | undefined> {
    return (
      (await this.orm.findOneBy({
        ...this.scopeWhere(scope),
        expiresAt: MoreThan(new Date().toISOString()),
      })) ?? undefined
    );
  }

  /** Delete sessions in scope. */
  async purge(scope: ExpiredScope): Promise<void> {
    await this.orm.delete(this.scopeWhere(scope));
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Scope to one session's token or to expired sessions. */
  protected scopeWhere(scope: CredentialScope): FindOptionsWhere<ViewSession> {
    return credentialWhere(scope);
  }

  /** Sessions contain no persistence-only fields. */
  protected toEntity(record: ViewSession): ViewSession {
    return record;
  }
}
