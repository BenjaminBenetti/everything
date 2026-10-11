import type { BaseEntity } from "../../entity/model/base-entity.js";

/** Scope for repositories whose entities belong to an authenticated subject. */
export interface OwnerScope {
  readonly ownerId: string;
}

/** Common persistence operations; implementations must apply scope to every query. */
export interface Repository<TEntity extends BaseEntity, TScope> {
  /** Find an entity within scope, returning undefined for missing or inaccessible IDs. */
  getById(scope: TScope, id: TEntity["id"]): Promise<TEntity | undefined>;

  /** List entities within scope; specialized interfaces document ordering and limits. */
  list(scope: TScope): Promise<TEntity[]>;

  /** Delete within scope; a missing or inaccessible ID has no effect. */
  delete(scope: TScope, id: TEntity["id"]): Promise<void>;
}
